/**
 * 百度网盘 transport: listing, semantic search, and reading a byte range.
 *
 * Written against the official Apache-2.0 Go SDK (`baidu-netdisk/baidu-drive-sdk-go`)
 * rather than the union documentation site, so the field names and query
 * parameters here are copied from working code. Three of its conventions are
 * load-bearing and easy to get wrong:
 *
 * - **The credential is a query parameter**, not an `Authorization` header
 *   (`baidudriver/api/transport.go:16`), and it is injected into *every*
 *   request including the download itself.
 * - **The download CDN requires `User-Agent: pan.baidu.com`.** Without it the
 *   request is rejected, which is why the UA is set explicitly here rather than
 *   left to the runtime's default.
 * - **`errno` is the real status.** Baidu answers `200 OK` with a non-zero
 *   `errno` in the body for most failures, so an HTTP-status-only check reads
 *   every error as success.
 *
 * Everything is confined to the `/apps/bdpan/` application sandbox. That is the
 * product's boundary, not a limitation of this code: an OAuth app can only see
 * its own directory, and files elsewhere in the user's drive are invisible to
 * any token minted this way.
 *
 * @module dsh-reference-anything/cloud-drive/providers/baidu
 */

import { ReferenceAnythingError } from '../../../errors.ts'
import type { DriveEntry, DriveProvider, DriveProviderOptions, DriveReadResult } from '../types.ts'
import { type BdpanToken, bdpanTokenStatus, readBdpanToken } from './bdpan-config.ts'
import { drain, type FetchLike, isEntry, totalFromResponse } from './http.ts'

/** API host for listing, search, and metadata. */
const API_BASE = 'https://pan.baidu.com'

/** The application sandbox every token minted through `bdpan` is confined to. */
export const BAIDU_SANDBOX_ROOT = '/apps/bdpan'

/**
 * User-Agent the download CDN requires.
 *
 * `baidudriver/api/download_file.go` sets this on the `dlink` fetch and
 * documents it as mandatory; the request fails without it.
 */
const DOWNLOAD_USER_AGENT = 'pan.baidu.com'

/** `dlink`s are documented as valid 8 hours; retire them early to avoid a mid-read expiry. */
const DLINK_TTL_MS = 7 * 60 * 60 * 1000

/** Baidu's own cap on one `filemetas` call. */
const MAX_FSIDS_PER_CALL = 100

/** Search scene string the SDK sends; the endpoint rejects other values. */
const SEARCH_SCENE = 'mcpserver'

/** One `dlink` and when it stops being worth reusing. */
interface CachedDlink {
  readonly url: string
  readonly expiresAt: number
  readonly size: number
}

/**
 * Re-encode oversized integers as strings before parsing.
 *
 * `fs_id` is an `int64`. `JSON.parse` reads it into a double, and every value
 * above 2^53 comes back silently rounded — a corrupted id that still looks
 * like a number and fails only later, as a "file not found" for a file that
 * exists. Quoting the digits before the parse is the one fix that does not
 * require a bespoke JSON reader.
 *
 * Scoped to the two keys that carry an id (`fs_id` in list and metadata,
 * `fsid` in search) so no other numeric field changes type.
 *
 * @param text - raw response body.
 * @returns the body with id values quoted.
 */
export function quoteBigIds(text: string): string {
  return text.replace(/"(fs_id|fsid)"\s*:\s*(\d+)/g, '"$1":"$2"')
}

/** Baidu wraps failures in the body, not the status line. */
interface BaiduEnvelope {
  readonly errno?: number
  readonly errmsg?: string
  readonly error_no?: number
  readonly error_msg?: string
}

/** Remove the credential from anything that might be shown or logged. */
function redact(text: string): string {
  return text.replace(/(access_token=)[^&\s]+/g, '$1***')
}

/** Reads 百度网盘 through its public REST API, using the `bdpan` CLI's credential. */
export class BaiduDriveProvider implements DriveProvider {
  readonly kind = 'baidu' as const
  readonly displayName = '百度网盘'

  /**
   * Unresolved until the first read probes it.
   *
   * Baidu documents no `Range` support and the official SDK's `DownloadParams`
   * exposes only a `Dlink` with no offset, so the answer is genuinely unknown
   * until a real request is made. A `200` where `206` was asked for sets this
   * to `false` for the rest of the process.
   */
  supportsRange: boolean | undefined = undefined

  private readonly root: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly configPath: string | undefined

  /** `dlink`s already resolved this process, keyed by `fs_id`. */
  private readonly dlinks = new Map<string, CachedDlink>()

  /**
   * Metadata seen for a file id, kept for the process's life.
   *
   * Unlike a `dlink` this does not expire: a name and a size are stable facts
   * about a file, and re-fetching them on every read would double the request
   * count for nothing.
   */
  private readonly metas = new Map<string, DriveEntry>()

  /**
   * Passages semantic search returned, keyed by `fs_id`.
   *
   * Held here rather than on the `DriveEntry` that leaves this module, because
   * a passage is body text: it belongs inside `reference_read`'s untrusted-data
   * envelope and must never reach a `ReferenceSummary`.
   */
  private readonly excerpts = new Map<string, string>()

  /** @param options - transport and clock seams; all optional in production. */
  constructor(options: DriveProviderOptions = {}) {
    this.root = options.root ?? BAIDU_SANDBOX_ROOT
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? (() => Date.now())
    this.configPath = options.configPath
  }

  /**
   * Whether a usable credential exists on disk.
   *
   * Strictly local, per {@link DriveProvider.credentialed}: a file read and an
   * expiry comparison, no network. A logged-in user whose network is down
   * still reports available and fails inside {@link BaiduDriveProvider.list},
   * which is the honest distinction between "not configured" and "not working".
   */
  async credentialed(): Promise<boolean> {
    const status = await this.token1Status()
    return status.ok
  }

  /**
   * List the sandbox root, or search it when the user has typed something.
   *
   * @param query - free text; empty lists the root directory newest-first.
   * @param limit - hard cap on returned entries.
   * @param signal - cancellation from the caller.
   */
  async list(query: string, limit: number, signal?: AbortSignal): Promise<readonly DriveEntry[]> {
    const bounded = Math.max(0, Math.min(limit, 1000))
    if (bounded === 0) return []
    const token = await this.requireToken()
    const trimmed = query.trim()
    const entries = trimmed === ''
      ? await this.listDirectory(token, bounded, signal)
      : await this.search(token, trimmed, bounded, signal)
    // Memoized here rather than in the two callees, so a later `describe` of
    // anything the user has already seen in the menu costs no round-trip.
    for (const entry of entries) this.metas.set(entry.id, entry)
    return entries
  }

  /**
   * Tier 1: the passage semantic search already extracted, if this entry came
   * from a search.
   *
   * A directory listing never populates it, and Baidu has nothing to return
   * until it has indexed the file, so `undefined` is the ordinary case rather
   * than a failure.
   *
   * @param id - `fs_id` as a decimal string.
   */
  async extractedText(id: string): Promise<string | undefined> {
    return this.excerpts.get(id)
  }

  /**
   * Describe one file from its metadata, with no download.
   *
   * Shares the `filemetas` round-trip with {@link BaiduDriveProvider.read}:
   * the same call carries both the name and the `dlink`, so describing a file
   * about to be read costs nothing extra.
   *
   * @param id - `fs_id` as a decimal string.
   * @param signal - cancellation from the caller.
   */
  async describe(id: string, signal?: AbortSignal): Promise<DriveEntry | undefined> {
    const cached = this.metas.get(id)
    if (cached !== undefined) return cached
    const token = await this.requireToken()
    try {
      return (await this.fetchMeta(token, id, signal)).entry
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
   * Resolves a `dlink` (cached for its documented lifetime), then requests the
   * range. When the CDN ignores `Range` and starts sending the whole file, the
   * body is consumed only up to `end` and then aborted, so a range request
   * against a multi-gigabyte file costs the requested window rather than the
   * file.
   *
   * @param id - `fs_id` as a decimal string.
   * @param start - first byte, counted from zero.
   * @param end - exclusive upper bound.
   * @param signal - cancellation from the caller.
   */
  async read(id: string, start: number, end: number, signal?: AbortSignal): Promise<DriveReadResult> {
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end <= start) {
      throw new ReferenceAnythingError(
        `baidu: invalid byte range [${start}, ${end})`,
        'REFERENCE_READ_FAILED',
      )
    }
    const token = await this.requireToken()
    const dlink = await this.resolveDlink(token, id, signal)

    const url = withToken(dlink.url, token.accessToken)
    const wantRange = this.supportsRange !== false
    const response = await this.send(url, {
      headers: {
        'User-Agent': DOWNLOAD_USER_AGENT,
        ...(wantRange ? { Range: `bytes=${start}-${end - 1}` } : {}),
      },
      ...(signal ? { signal } : {}),
    })

    if (!response.ok && response.status !== 206) {
      await response.body?.cancel()
      throw new ReferenceAnythingError(
        `baidu: download failed with HTTP ${response.status}`,
        response.status === 404 ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_READ_FAILED',
      )
    }

    // The probe. A 206 proves ranges work; a 200 to a range request proves
    // they do not, and demoting here is what stops every later read from
    // paying for a full body it will throw away.
    const ranged = response.status === 206
    if (wantRange) this.supportsRange = ranged

    const wanted = ranged ? end - start : end
    const body = await drain(response, wanted)
    const bytes = ranged ? body : body.subarray(Math.min(start, body.byteLength))
    const totalSize = totalFromResponse(response) ?? (dlink.size > 0 ? dlink.size : undefined)
    return {
      bytes,
      ranged,
      ...(totalSize === undefined ? {} : { totalSize }),
    }
  }

  /** One directory page, newest first. */
  private async listDirectory(
    token: BdpanToken,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly DriveEntry[]> {
    const params = new URLSearchParams({
      method: 'list',
      dir: this.root,
      order: 'time',
      desc: '1',
      // `start` must accompany `limit`: the server ignores a lone `limit`
      // (`baidudriver/api/file_list.go:140`).
      start: '0',
      limit: String(limit),
    })
    const body = await this.apiGet<{ list?: readonly RawListItem[] }>(
      '/rest/2.0/xpan/file',
      params,
      token,
      signal,
    )
    return (body.list ?? []).map(item => this.fromListItem(item)).filter(isEntry).slice(0, limit)
  }

  /** Semantic search, scoped to the sandbox when the account id is known. */
  private async search(
    token: BdpanToken,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly DriveEntry[]> {
    const params = new URLSearchParams({
      query,
      scene: SEARCH_SCENE,
      num: String(limit),
      access_token: token.accessToken,
    })
    // Without `dirs` the endpoint searches the whole account rather than the
    // sandbox, so scope it whenever the config disclosed a `uk`.
    if (token.uk !== undefined) {
      params.set('dirs', JSON.stringify([{ uk: Number(token.uk), path: this.root }]))
    }

    const url = `${API_BASE}/xpan/unisearch?${params.toString()}`
    // The endpoint has a non-empty-body check but takes no body fields, so the
    // SDK posts a literal empty object.
    const response = await this.send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      ...(signal ? { signal } : {}),
    })
    const parsed = await this.decode<UniSearchBody>(response, url)

    const entries: DriveEntry[] = []
    for (const group of parsed.data ?? []) {
      for (const hit of group?.list ?? []) {
        const entry = this.fromSearchHit(hit)
        if (entry === undefined) continue
        if (hit.content !== undefined && hit.content !== '') this.excerpts.set(entry.id, hit.content)
        else if (hit.ocr !== undefined && hit.ocr !== '') this.excerpts.set(entry.id, hit.ocr)
        entries.push(entry)
        if (entries.length >= limit) return entries
      }
    }
    return entries
  }

  /**
   * Resolve and cache a download link.
   *
   * @param id - `fs_id` as a decimal string.
   */
  private async resolveDlink(token: BdpanToken, id: string, signal?: AbortSignal): Promise<CachedDlink> {
    const cached = this.dlinks.get(id)
    if (cached !== undefined && cached.expiresAt > this.now()) return cached
    const { dlink } = await this.fetchMeta(token, id, signal)
    if (dlink === undefined) {
      throw new ReferenceAnythingError('baidu: file has no download link', 'REFERENCE_NOT_FOUND')
    }
    return dlink
  }

  /**
   * One `filemetas` call, split out so a describe and a read share it.
   *
   * The download link is optional in the return: a directory has none, and
   * that is a fact about the entry rather than a failure to report.
   *
   * @param id - `fs_id` as a decimal string.
   */
  private async fetchMeta(
    token: BdpanToken,
    id: string,
    signal?: AbortSignal,
  ): Promise<{ entry: DriveEntry, dlink: CachedDlink | undefined }> {
    if (!/^\d+$/.test(id)) {
      throw new ReferenceAnythingError(`baidu: malformed file id`, 'REFERENCE_INVALID_URI')
    }
    const params = new URLSearchParams({
      method: 'filemetas',
      dlink: '1',
      // The parameter is a JSON array of at most MAX_FSIDS_PER_CALL numbers;
      // the id stays a string here only so its precision survives.
      fsids: `[${id}]`,
    })
    const body = await this.apiGet<{ list?: readonly RawMeta[] }>(
      '/rest/2.0/xpan/multimedia',
      params,
      token,
      signal,
    )
    const meta = body.list?.[0]
    if (meta === undefined) {
      throw new ReferenceAnythingError('baidu: no such file', 'REFERENCE_NOT_FOUND')
    }
    const path = typeof meta.path === 'string' ? meta.path : ''
    const size = typeof meta.size === 'number' ? meta.size : 0
    const entry: DriveEntry = {
      kind: this.kind,
      id,
      name: (typeof meta.filename === 'string' && meta.filename !== '' ? meta.filename : basename(path)) || id,
      path,
      size,
      isDirectory: meta.isdir === 1,
      ...(secondsToMs(meta.server_mtime) === undefined ? {} : { modifiedAt: secondsToMs(meta.server_mtime)! }),
    }
    this.metas.set(id, entry)

    let dlink: CachedDlink | undefined
    if (typeof meta.dlink === 'string' && meta.dlink !== '') {
      dlink = { url: meta.dlink, expiresAt: this.now() + DLINK_TTL_MS, size }
      this.dlinks.set(id, dlink)
    }
    return { entry, dlink }
  }

  /** GET a JSON API endpoint, appending the credential and unwrapping `errno`. */
  private async apiGet<T>(
    path: string,
    params: URLSearchParams,
    token: BdpanToken,
    signal?: AbortSignal,
  ): Promise<T> {
    params.set('access_token', token.accessToken)
    const url = `${API_BASE}${path}?${params.toString()}`
    const response = await this.send(url, {
      headers: { 'User-Agent': DOWNLOAD_USER_AGENT },
      ...(signal ? { signal } : {}),
    })
    return await this.decode<T>(response, url)
  }

  /** Parse one API response, turning both HTTP and `errno` failures into errors. */
  private async decode<T>(response: Response, url: string): Promise<T> {
    const text = await response.text()
    if (!response.ok) {
      throw new ReferenceAnythingError(
        `baidu: request failed with HTTP ${response.status} (${redact(url)})`,
        'REFERENCE_READ_FAILED',
      )
    }
    let parsed: T & BaiduEnvelope
    try {
      parsed = JSON.parse(quoteBigIds(text)) as T & BaiduEnvelope
    } catch (cause) {
      throw new ReferenceAnythingError('baidu: response was not JSON', 'REFERENCE_READ_FAILED', { cause })
    }
    const errno = parsed.errno ?? parsed.error_no ?? 0
    if (errno !== 0) {
      const detail = parsed.errmsg ?? parsed.error_msg ?? ''
      throw new ReferenceAnythingError(
        `baidu: API error ${errno}${detail === '' ? '' : `: ${detail}`}`,
        errno === -9 ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_READ_FAILED',
      )
    }
    return parsed
  }

  /** Single exit point for HTTP, so cancellation maps to one error class. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init)
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ReferenceAnythingError('baidu: request cancelled', 'REFERENCE_CANCELLED', { cause })
      }
      // The message may quote the request URL, which carries the credential.
      throw new ReferenceAnythingError(
        `baidu: network request failed (${redact(String(cause))})`,
        'REFERENCE_READ_FAILED',
      )
    }
  }

  /** Credential status without disclosing the credential. */
  private async token1Status(): ReturnType<typeof bdpanTokenStatus> {
    return this.configPath === undefined
      ? await bdpanTokenStatus(this.now())
      : await bdpanTokenStatus(this.now(), this.configPath)
  }

  /** Load the credential, or explain how to get one. */
  private async requireToken(): Promise<BdpanToken> {
    const token = this.configPath === undefined
      ? await readBdpanToken(this.now())
      : await readBdpanToken(this.now(), this.configPath)
    if (token !== undefined) return token
    const status = await this.token1Status()
    const problem = status.ok ? 'no-token' : status.problem
    throw new ReferenceAnythingError(
      problem === 'expired'
        ? '百度网盘 credential has expired; run the baidu-drive skill\'s login.sh again'
        : '百度网盘 is not logged in; run the baidu-drive skill\'s login.sh',
      'SOURCE_UNAVAILABLE',
    )
  }

  /** Project one listing row, dropping anything without a usable id. */
  private fromListItem(item: RawListItem): DriveEntry | undefined {
    if (typeof item.fs_id !== 'string' || item.fs_id === '') return undefined
    const path = typeof item.path === 'string' ? item.path : ''
    const name = typeof item.server_filename === 'string' && item.server_filename !== ''
      ? item.server_filename
      : basename(path) || item.fs_id
    const modifiedAt = secondsToMs(item.server_mtime)
    return {
      kind: 'baidu',
      id: item.fs_id,
      name,
      path,
      size: typeof item.size === 'number' ? item.size : 0,
      isDirectory: item.isdir === 1,
      ...(modifiedAt === undefined ? {} : { modifiedAt }),
    }
  }

  /** Project one search hit. Note the key is `fsid` here, not `fs_id`. */
  private fromSearchHit(hit: RawSearchHit): DriveEntry | undefined {
    if (typeof hit.fsid !== 'string' || hit.fsid === '') return undefined
    const path = typeof hit.path === 'string' ? hit.path : ''
    const name = typeof hit.filename === 'string' && hit.filename !== ''
      ? hit.filename
      : basename(path) || hit.fsid
    const modifiedAt = secondsToMs(hit.server_mtime)
    return {
      kind: 'baidu',
      id: hit.fsid,
      name,
      path,
      size: typeof hit.size === 'number' ? hit.size : 0,
      isDirectory: hit.isdir === 1,
      ...(modifiedAt === undefined ? {} : { modifiedAt }),
    }
  }
}

/** `xpan/file?method=list` row, after {@link quoteBigIds}. */
interface RawListItem {
  readonly fs_id?: string
  readonly path?: string
  readonly server_filename?: string
  readonly size?: number
  readonly server_mtime?: number
  readonly isdir?: number
}

/** `xpan/multimedia?method=filemetas` row. */
interface RawMeta {
  readonly fs_id?: string
  readonly dlink?: string
  readonly size?: number
  readonly path?: string
  readonly filename?: string
  readonly server_mtime?: number
  readonly isdir?: number
}

/** `xpan/unisearch` hit. The id key loses its underscore in this response. */
interface RawSearchHit {
  readonly fsid?: string
  readonly path?: string
  readonly filename?: string
  readonly size?: number
  readonly server_mtime?: number
  readonly isdir?: number
  /** Passage recalled by semantic search — body text, never a summary field. */
  readonly content?: string
  readonly ocr?: string
}

/** `xpan/unisearch` response, grouped by source before it is flattened. */
interface UniSearchBody {
  readonly data?: readonly { readonly list?: readonly RawSearchHit[] }[]
}

/** Baidu reports times in Unix seconds; the package speaks milliseconds. */
function secondsToMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined
}

/** Last path segment, for a display name when the row carries none. */
function basename(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

/** Append the credential to a URL that already carries query parameters. */
function withToken(url: string, accessToken: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set('access_token', accessToken)
  return parsed.toString()
}
