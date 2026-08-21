/**
 * 阿里云盘与相册服务 (PDS) transport: listing, search, and reading a byte range.
 *
 * Written against the official MIT SDK (`aliyun/aliyun-pds-js-sdk` v1.4.0)
 * rather than the `alibabacloud-pds-intelligent-workspace` skill, which
 * documents only the `aliyun pds` CLI. Four of the product's conventions are
 * load-bearing and differ sharply from 百度网盘:
 *
 * - **The data plane is not signed.** Despite being an Alibaba Cloud product,
 *   `*.api.aliyunpds.com` takes a plain `Authorization: Bearer <access_token>`;
 *   there is no AccessKey and no request signature anywhere in this path.
 * - **Every call is a `POST` to `{endpoint}/v2{path}` with a JSON body**, even
 *   the ones that only read. There are no query parameters to redact, which is
 *   why the credential never appears in a URL here.
 * - **The endpoint is per-tenant.** PDS is multi-tenant, so the origin comes
 *   from the logged-in profile rather than from a constant in this file.
 * - **A file needs two ids.** `file_id` is meaningless without `drive_id`, so a
 *   reference carries both, joined by `/`.
 *
 * **The signed-URL hazard.** `/file/list` and `/file/search` return a live
 * `download_url` inline on every row whenever `url_expire_sec` is set — which
 * the SDK does by default. Nothing in this module ever reads that field: a
 * {@link DriveEntry} flows out to a `ReferenceSummary` and into the client, and
 * a signed URL must not travel with it. Downloads resolve their own URL through
 * {@link PdsDriveProvider.read}, which keeps it inside this class.
 *
 * Unlike Baidu there is no application sandbox: a PDS token sees the account's
 * whole drive. Listing is confined to a configured folder, but search is
 * recursive by design and reaches everything the user owns.
 *
 * @module dsh-reference-anything/cloud-drive/providers/pds
 */

import { ReferenceAnythingError } from '../../../errors.ts'
import type { DriveEntry, DriveProvider, DriveProviderOptions, DriveReadResult } from '../types.ts'
import { drain, type FetchLike, isEntry, totalFromResponse } from './http.ts'
import { type PdsToken, pdsTokenStatus, readPdsToken } from './pds-config.ts'

/** Version segment between the tenant endpoint and every API path. */
const API_VERSION = 'v2'

/** Sentinel `parent_file_id` for the top of a drive. */
const ROOT_FOLDER_ID = 'root'

/** Server-side cap on one `/file/list` or `/file/search` page. */
const MAX_PAGE_LIMIT = 100

/**
 * Lifetime requested for a download URL.
 *
 * The API allows up to 115200 s. A short one is asked for deliberately: the URL
 * is used within the same call, so a long lifetime would only widen the window
 * in which a leaked link still works.
 */
const DOWNLOAD_URL_TTL_SEC = 900

/** Retire a cached download URL early, so a read never starts against a dead one. */
const DOWNLOAD_URL_MARGIN_MS = 60_000

/** Largest error body worth reading before giving up on parsing it. */
const MAX_ERROR_BYTES = 4096

/** Error codes that mean "log in again" rather than "this request was wrong". */
const AUTH_CODES = /AccessTokenInvalid|TokenExpired|UserNotLogin|InvalidToken/i

/** One resolved download URL and when it stops being worth reusing. */
interface CachedUrl {
  readonly url: string
  readonly expiresAt: number
  readonly size: number
}

/**
 * Strip query strings out of anything that might be shown or logged.
 *
 * A PDS download URL carries its signature in the query, so a message that
 * quotes one is a credential leak with a short fuse. The origin and path are
 * kept because they are what makes a failure diagnosable.
 *
 * @param text - arbitrary text on its way into an error message.
 */
function redact(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#]*)[?#][^\s]*/gi, '$1?***')
}

/** Reads PDS through its data-plane API, using the `aliyun pds` CLI's credential. */
export class PdsDriveProvider implements DriveProvider {
  readonly kind = 'pds' as const
  readonly displayName = '阿里云盘'

  /**
   * Unresolved until the first read probes it.
   *
   * Expected to resolve to `true`: PDS's own downloaders send
   * `Range: bytes=…` (`lib/loaders/NodeDownloader.ts`,
   * `lib/loaders/WebDownloader.ts`), so the storage behind a download URL
   * honours ranges. It is still probed rather than assumed, because the URL
   * points at object storage whose behaviour is not this API's contract, and a
   * `200` where `206` was asked for must demote rather than silently turn every
   * windowed read into a full download.
   */
  supportsRange: boolean | undefined = undefined

  private readonly root: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly configPath: string | undefined

  /** The account's default drive, resolved once — the CLI's config carries none. */
  private driveId: string | undefined

  /** {@link PdsDriveProvider.root} resolved to a folder id, once. */
  private rootFileId: string | undefined

  /**
   * Metadata seen for a composite id, kept for the process's life.
   *
   * A name and a size are stable facts about a file, so unlike a download URL
   * this never expires; describing something the user already picked from the
   * menu costs no round-trip.
   */
  private readonly metas = new Map<string, DriveEntry>()

  /** Download URLs already resolved this process, keyed by composite id. */
  private readonly urls = new Map<string, CachedUrl>()

  /**
   * Folder names learned while listing, for composing a display path.
   *
   * PDS returns no path on a file row — only `parent_file_id` — and walking the
   * chain per entry would cost a round-trip per row on the keystroke path. So
   * the path is assembled from folders already seen and degrades to a leading
   * ellipsis when an ancestor is unknown.
   */
  private readonly folders = new Map<string, { readonly name: string, readonly parent: string }>()

  /** @param options - transport and clock seams; all optional in production. */
  constructor(options: DriveProviderOptions = {}) {
    this.root = options.root ?? ''
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? (() => Date.now())
    this.configPath = options.configPath
  }

  /**
   * Whether a usable credential exists on disk.
   *
   * Strictly local, per {@link DriveProvider.credentialed}: a file read and an
   * expiry comparison, no network. A logged-in user whose network is down still
   * reports available and fails inside {@link PdsDriveProvider.list}, which is
   * the honest distinction between "not configured" and "not working".
   */
  async credentialed(): Promise<boolean> {
    return (await this.tokenStatus()).ok
  }

  /**
   * List the configured folder, or search the drive when the user has typed
   * something.
   *
   * Search is recursive and drive-wide, which is PDS's own behaviour — the
   * `parent_file_id` filter its query language offers matches direct children
   * only, so scoping a search to the configured folder would quietly hide every
   * nested hit rather than narrowing honestly.
   *
   * @param query - free text; empty lists the configured folder newest-first.
   * @param limit - hard cap on returned entries.
   * @param signal - cancellation from the caller.
   */
  async list(query: string, limit: number, signal?: AbortSignal): Promise<readonly DriveEntry[]> {
    const bounded = Math.max(0, Math.min(limit, MAX_PAGE_LIMIT))
    if (bounded === 0) return []
    const token = await this.requireToken()
    const driveId = await this.resolveDrive(token, signal)
    const trimmed = query.trim()

    const body = trimmed === ''
      ? await this.call<ListBody>(token, '/file/list', {
        drive_id: driveId,
        parent_file_id: await this.resolveRoot(token, driveId, signal),
        limit: bounded,
        order_by: 'updated_at',
        order_direction: 'DESC',
      }, signal)
      : await this.call<ListBody>(token, '/file/search', {
        drive_id: driveId,
        query: nameQuery(trimmed),
        limit: bounded,
        order_by: 'updated_at DESC',
      }, signal)

    const entries = (body.items ?? [])
      .map(item => this.toEntry(item, driveId))
      .filter(isEntry)
      .slice(0, bounded)
    for (const entry of entries) this.metas.set(entry.id, entry)
    return entries
  }

  /**
   * Tier 1 is not available on this drive.
   *
   * PDS indexes files for search but returns no extracted passage with a hit —
   * `/file/search` answers with metadata only, and the multimodal search that
   * does return content is a separate product surface behind different
   * credentials. Reads therefore always go through the download ladder.
   */
  async extractedText(): Promise<string | undefined> {
    return undefined
  }

  /**
   * Describe one file from its metadata, with no download.
   *
   * @param id - `<drive_id>/<file_id>`.
   * @param signal - cancellation from the caller.
   */
  async describe(id: string, signal?: AbortSignal): Promise<DriveEntry | undefined> {
    const cached = this.metas.get(id)
    if (cached !== undefined) return cached
    const token = await this.requireToken()
    const key = await this.splitKey(token, id, signal)
    try {
      const item = await this.call<RawItem>(token, '/file/get', {
        drive_id: key.driveId,
        file_id: key.fileId,
      }, signal)
      const entry = this.toEntry(item, key.driveId)
      if (entry !== undefined) this.metas.set(entry.id, entry)
      return entry
    } catch (cause) {
      // A file that is gone is not an error here — the caller asked whether it
      // exists, and `undefined` answers that. Anything else is a real failure.
      if (cause instanceof ReferenceAnythingError && cause.code === 'REFERENCE_NOT_FOUND') return undefined
      throw cause
    }
  }

  /**
   * Read bytes `[start, end)` of one file.
   *
   * Resolves a signed download URL (cached for most of its short lifetime),
   * then requests the range. When the storage ignores `Range` and starts
   * sending the whole file, the body is consumed only up to `end` and then
   * aborted, so a windowed read of a multi-gigabyte file costs the window
   * rather than the file.
   *
   * @param id - `<drive_id>/<file_id>`.
   * @param start - first byte, counted from zero.
   * @param end - exclusive upper bound.
   * @param signal - cancellation from the caller.
   */
  async read(id: string, start: number, end: number, signal?: AbortSignal): Promise<DriveReadResult> {
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end <= start) {
      throw new ReferenceAnythingError(
        `pds: invalid byte range [${start}, ${end})`,
        'REFERENCE_READ_FAILED',
      )
    }
    const token = await this.requireToken()
    const cached = await this.resolveUrl(token, id, signal)

    const wantRange = this.supportsRange !== false
    const response = await this.send(cached.url, {
      ...(wantRange ? { headers: { Range: `bytes=${start}-${end - 1}` } } : {}),
      ...(signal ? { signal } : {}),
    }, 'download')

    if (!response.ok && response.status !== 206) {
      await response.body?.cancel()
      throw new ReferenceAnythingError(
        `pds: download failed with HTTP ${response.status}`,
        response.status === 404 ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_READ_FAILED',
      )
    }

    // The probe. A 206 proves ranges work; a 200 to a range request proves they
    // do not, and demoting here is what stops every later read from paying for
    // a full body it will throw away.
    const ranged = response.status === 206
    if (wantRange) this.supportsRange = ranged

    const wanted = ranged ? end - start : end
    const body = await drain(response, wanted)
    const bytes = ranged ? body : body.subarray(Math.min(start, body.byteLength))
    const totalSize = totalFromResponse(response) ?? (cached.size > 0 ? cached.size : undefined)
    return {
      bytes,
      ranged,
      ...(totalSize === undefined ? {} : { totalSize }),
    }
  }

  /**
   * The account's default drive.
   *
   * `aliyun pds`'s config records a `user_id` but no `drive_id`, so this is the
   * one piece of account state that has to come from the network. Resolved once
   * and held for the process; a `list()` on a warm provider makes one call, not
   * two.
   *
   * @param token - a live credential.
   * @param signal - cancellation from the caller.
   */
  private async resolveDrive(token: PdsToken, signal?: AbortSignal): Promise<string> {
    if (this.driveId !== undefined) return this.driveId
    const body = await this.call<{ drive_id?: string }>(token, '/drive/get_default_drive', {
      ...(token.userId === undefined ? {} : { user_id: token.userId }),
    }, signal)
    const driveId = body.drive_id
    if (typeof driveId !== 'string' || driveId === '') {
      throw new ReferenceAnythingError(
        'pds: the account has no default drive',
        'SOURCE_UNAVAILABLE',
      )
    }
    this.driveId = driveId
    return driveId
  }

  /**
   * Turn the configured root into a folder id.
   *
   * Three cases, in the order a user is likely to write them: empty means the
   * top of the drive; a value starting with `/` is an absolute path resolved
   * once through `/file/get_by_path`; anything else is taken as a folder id
   * verbatim, which is what the CLI prints.
   *
   * @param token - a live credential.
   * @param driveId - the drive the root lives in.
   * @param signal - cancellation from the caller.
   */
  private async resolveRoot(token: PdsToken, driveId: string, signal?: AbortSignal): Promise<string> {
    if (this.rootFileId !== undefined) return this.rootFileId
    const configured = this.root.trim()
    if (configured === '' || configured === ROOT_FOLDER_ID) {
      this.rootFileId = ROOT_FOLDER_ID
      return ROOT_FOLDER_ID
    }
    if (!configured.startsWith('/')) {
      this.rootFileId = configured
      return configured
    }
    const item = await this.call<RawItem>(token, '/file/get_by_path', {
      drive_id: driveId,
      file_path: configured.replace(/\/+$/, '') || '/',
    }, signal)
    const fileId = typeof item.file_id === 'string' && item.file_id !== '' ? item.file_id : ROOT_FOLDER_ID
    this.rootFileId = fileId
    return fileId
  }

  /**
   * A download URL for one file, reusing a live one when there is one.
   *
   * The URL never leaves this class: it is signed, and a signed URL in a
   * `ReferenceSummary` would be a credential handed to whatever renders it.
   *
   * @param token - a live credential.
   * @param id - `<drive_id>/<file_id>`.
   * @param signal - cancellation from the caller.
   */
  private async resolveUrl(token: PdsToken, id: string, signal?: AbortSignal): Promise<CachedUrl> {
    const now = this.now()
    const cached = this.urls.get(id)
    if (cached !== undefined && cached.expiresAt > now) return cached

    const key = await this.splitKey(token, id, signal)
    const body = await this.call<DownloadUrlBody>(token, '/file/get_download_url', {
      drive_id: key.driveId,
      file_id: key.fileId,
      expire_sec: DOWNLOAD_URL_TTL_SEC,
    }, signal)

    const url = body.url
    if (typeof url !== 'string' || url === '') {
      throw new ReferenceAnythingError('pds: no download URL for this file', 'REFERENCE_READ_FAILED')
    }
    const stated = typeof body.expiration === 'string' ? Date.parse(body.expiration) : Number.NaN
    const expiresAt = (Number.isFinite(stated) ? stated : now + DOWNLOAD_URL_TTL_SEC * 1000)
      - DOWNLOAD_URL_MARGIN_MS
    const resolved: CachedUrl = {
      url,
      expiresAt,
      size: typeof body.size === 'number' && body.size > 0 ? body.size : 0,
    }
    this.urls.set(id, resolved)
    return resolved
  }

  /**
   * Split a composite reference id.
   *
   * A reference minted by this provider always carries both halves. One written
   * by hand, or migrated from a build that stored bare file ids, falls back to
   * the account's default drive rather than failing — the drive is a location,
   * and there is only one plausible one.
   *
   * @param token - a live credential, for the default-drive fallback.
   * @param id - `<drive_id>/<file_id>`, or a bare `<file_id>`.
   * @param signal - cancellation from the caller.
   */
  private async splitKey(
    token: PdsToken,
    id: string,
    signal?: AbortSignal,
  ): Promise<{ driveId: string, fileId: string }> {
    const cut = id.indexOf('/')
    if (cut > 0 && cut < id.length - 1) {
      return { driveId: id.slice(0, cut), fileId: id.slice(cut + 1) }
    }
    const fileId = cut === -1 ? id : id.replace(/\//g, '')
    if (fileId === '') {
      throw new ReferenceAnythingError('pds: malformed file id', 'REFERENCE_INVALID_URI')
    }
    return { driveId: await this.resolveDrive(token, signal), fileId }
  }

  /**
   * One data-plane call: `POST {endpoint}/v2{path}` with a JSON body.
   *
   * @param token - a live credential; supplied as a bearer header, never a URL.
   * @param path - API path with its leading slash, e.g. `/file/list`.
   * @param body - request payload.
   * @param signal - cancellation from the caller.
   * @returns the parsed response body.
   */
  private async call<T>(
    token: PdsToken,
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.send(`${token.endpoint}/${API_VERSION}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }, path)

    if (!response.ok) throw await this.apiError(response, path)

    const text = await response.text()
    if (text.trim() === '') return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ReferenceAnythingError(`pds: unreadable response from ${path}`, 'REFERENCE_READ_FAILED')
    }
  }

  /**
   * Turn a failed response into an error the caller can act on.
   *
   * Only the status and the server's own `code` are used. The `message` is
   * deliberately not quoted: it echoes request parameters, and one of those is
   * a signed URL on the download path.
   *
   * @param response - a response whose status is not ok.
   * @param path - the API path, for a diagnosable message.
   */
  private async apiError(response: Response, path: string): Promise<ReferenceAnythingError> {
    let code = ''
    try {
      const raw = await drain(response, MAX_ERROR_BYTES)
      const parsed: unknown = JSON.parse(new TextDecoder().decode(raw))
      if (parsed !== null && typeof parsed === 'object' && 'code' in parsed) {
        const value = (parsed as { code?: unknown }).code
        if (typeof value === 'string') code = value
      }
    } catch {
      // A body that is not JSON adds nothing the status does not already say.
    }

    if (response.status === 401 || AUTH_CODES.test(code)) {
      return new ReferenceAnythingError(
        '阿里云盘 credential has expired; run `aliyun pds config` again',
        'SOURCE_UNAVAILABLE',
      )
    }
    if (response.status === 404 || code.startsWith('NotFound')) {
      return new ReferenceAnythingError('pds: file not found', 'REFERENCE_NOT_FOUND')
    }
    const detail = code === '' ? `HTTP ${response.status}` : `${code} (HTTP ${response.status})`
    return new ReferenceAnythingError(`pds: ${path} failed — ${detail}`, 'REFERENCE_READ_FAILED')
  }

  /**
   * The one place this module reaches the network.
   *
   * @param url - absolute request URL.
   * @param init - request options.
   * @param label - API path or `download`, for a message that names no URL.
   */
  private async send(url: string, init: RequestInit, label: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, init)
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ReferenceAnythingError('pds: request cancelled', 'REFERENCE_CANCELLED', { cause })
      }
      throw new ReferenceAnythingError(
        `pds: network request to ${label} failed (${redact(String(cause))})`,
        'REFERENCE_READ_FAILED',
      )
    }
  }

  /** Credential status without disclosing the credential. */
  private async tokenStatus(): ReturnType<typeof pdsTokenStatus> {
    return this.configPath === undefined
      ? await pdsTokenStatus(this.now())
      : await pdsTokenStatus(this.now(), this.configPath)
  }

  /** Load the credential, or explain how to get one. */
  private async requireToken(): Promise<PdsToken> {
    const token = this.configPath === undefined
      ? await readPdsToken(this.now())
      : await readPdsToken(this.now(), this.configPath)
    if (token !== undefined) return token
    const status = await this.tokenStatus()
    const problem = status.ok ? 'no-token' : status.problem
    throw new ReferenceAnythingError(
      problem === 'expired'
        ? '阿里云盘 credential has expired; run `aliyun pds config` again'
        : '阿里云盘 is not logged in; run `aliyun pds config`',
      'SOURCE_UNAVAILABLE',
    )
  }

  /**
   * Project one API row into an entry, dropping anything without a usable id.
   *
   * `download_url` is present on most rows and is deliberately never read: an
   * entry becomes a `ReferenceSummary`, and a signed URL must not travel with
   * one.
   *
   * @param item - a `/file/*` response row.
   * @param driveId - the drive the row was fetched from, for rows that omit it.
   */
  private toEntry(item: RawItem, driveId: string): DriveEntry | undefined {
    const fileId = item.file_id
    if (typeof fileId !== 'string' || fileId === '') return undefined
    const owner = typeof item.drive_id === 'string' && item.drive_id !== '' ? item.drive_id : driveId
    const name = typeof item.name === 'string' && item.name !== '' ? item.name : fileId
    const isDirectory = item.type === 'folder'
    const parent = typeof item.parent_file_id === 'string' && item.parent_file_id !== ''
      ? item.parent_file_id
      : ROOT_FOLDER_ID
    if (isDirectory) this.folders.set(fileId, { name, parent })

    const modifiedAt = typeof item.updated_at === 'string' ? Date.parse(item.updated_at) : Number.NaN
    return {
      kind: 'pds',
      id: `${owner}/${fileId}`,
      name,
      path: this.displayPath(name, parent),
      size: typeof item.size === 'number' && item.size > 0 ? item.size : 0,
      isDirectory,
      ...(Number.isFinite(modifiedAt) ? { modifiedAt } : {}),
    }
  }

  /**
   * A human-readable location for one entry.
   *
   * Display only, never an API argument — {@link DriveEntry.path}'s contract.
   * Walks the folders seen so far and gives up with a leading ellipsis rather
   * than issuing a request, because this runs on the keystroke path.
   *
   * @param name - the entry's own name.
   * @param parent - its `parent_file_id`.
   */
  private displayPath(name: string, parent: string): string {
    const segments: string[] = [name]
    let current = parent
    // Bounded so a cycle in malformed data cannot spin here.
    for (let depth = 0; depth < 32; depth += 1) {
      if (current === ROOT_FOLDER_ID || current === this.rootFileId) return `/${segments.join('/')}`
      const folder = this.folders.get(current)
      if (folder === undefined) return `…/${segments.join('/')}`
      segments.unshift(folder.name)
      current = folder.parent
    }
    return `…/${segments.join('/')}`
  }
}

/**
 * Build a PDS search expression matching a name.
 *
 * The query language is a small filter DSL — the SDK's own functional tests use
 * `(name="k" or name match "k")` — so the user's text has to be embedded in a
 * quoted literal. Quotes and backslashes are dropped rather than escaped: the
 * escaping rules are not published, and a dropped character costs a slightly
 * looser match while a mis-escaped one costs a rejected request.
 *
 * @param query - the user's raw input.
 */
function nameQuery(query: string): string {
  const literal = query.replace(/["\\]/g, '').slice(0, 512)
  return `name match "${literal}"`
}

/** `/file/list` and `/file/search` response envelope. */
interface ListBody {
  readonly items?: readonly RawItem[]
  readonly next_marker?: string
  readonly total_count?: number
}

/**
 * One `/file/*` row.
 *
 * `download_url` is declared so its absence from every read site is a visible
 * decision rather than an oversight; see {@link PdsDriveProvider.toEntry}.
 */
interface RawItem {
  readonly drive_id?: string
  readonly file_id?: string
  readonly parent_file_id?: string
  readonly name?: string
  readonly size?: number
  readonly type?: string
  readonly updated_at?: string
  readonly download_url?: string
}

/** `/file/get_download_url` response. */
interface DownloadUrlBody {
  readonly url?: string
  readonly size?: number
  readonly expiration?: string
}
