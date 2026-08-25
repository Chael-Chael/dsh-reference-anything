/** OpenList's private HTTP transport. URLs and credentials never leave this module. */
import { ReferenceAnythingError } from '../../../errors.ts'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { authenticateOpenList, readOpenListCredentials, validateOpenListEndpoint, type OpenListCredentials } from '../../../openlist/host.ts'
import { normalizeOpenListPath } from '../registry.ts'
import type { DriveEntry, DriveProvider, DriveProviderOptions, DriveReadResult } from '../types.ts'
import { drain, type FetchLike, totalFromResponse } from './http.ts'

interface OpenListNode {
  readonly name?: unknown
  readonly path?: unknown
  readonly size?: unknown
  readonly is_dir?: unknown
  readonly isDir?: unknown
  readonly modified?: unknown
  readonly updated_at?: unknown
  readonly raw_url?: unknown
  readonly rawUrl?: unknown
  readonly parent?: unknown
}

/** Construction seam intentionally kept host-side; never place this in plugin config or wire types. */
export interface OpenListProviderOptions extends DriveProviderOptions {
  readonly endpoint?: string
  readonly username?: string
  readonly password?: string
  readonly token?: string
  /** Host-local credential access; this is intentionally not configuration. */
  readonly credentials?: (refresh?: boolean) => Promise<OpenListCredentials | undefined>
  /** Limits the safe fallback when an external index/search backend fails. */
  readonly walkDirectories?: number
  /** DNS seam used to enforce raw-download SSRF policy in tests and production. */
  readonly resolveHost?: (hostname: string) => Promise<readonly { readonly address: string }[]>
  readonly rawRequest?: (url: URL, address: string, init: RequestInit) => Promise<Response>
}

/** Lists and reads a configured OpenList instance through its file-system API. */
export class OpenListDriveProvider implements DriveProvider {
  readonly kind = 'openlist' as const
  readonly displayName = 'OpenList'
  supportsRange: boolean | undefined = undefined

  private endpoint: string | undefined
  private readonly root: string
  private readonly fetchImpl: FetchLike
  private token: string | undefined
  private readonly username: string | undefined
  private readonly password: string | undefined
  private readonly credentialPath: string | undefined
  private readonly credentialSource: ((refresh?: boolean) => Promise<OpenListCredentials | undefined>) | undefined
  private readonly maxWalkDirectories: number
  private readonly resolveHost: (hostname: string) => Promise<readonly { readonly address: string }[]>
  private readonly rawRequest: (url: URL, address: string, init: RequestInit) => Promise<Response>
  private readonly entries = new Map<string, DriveEntry>()
  private readonly rawUrls = new Map<string, string>()
  private credentialFingerprint: string | undefined

  constructor(options: OpenListProviderOptions = {}) {
    this.endpoint = options.endpoint === undefined ? undefined : validateOpenListEndpoint(options.endpoint)
    this.root = normalizeOpenListPath(options.root ?? '/')
    this.fetchImpl = options.fetch ?? fetch
    this.resolveHost = options.resolveHost ?? (options.fetch === undefined ? async hostname => await lookup(hostname, { all: true }) : async () => [{ address: '203.0.113.1' }])
    this.rawRequest = options.rawRequest ?? (options.fetch === undefined ? pinnedRawRequest : async (url, _address, init) => await this.fetchImpl(url.href, init))
    this.maxWalkDirectories = Math.max(1, Math.min(100, options.walkDirectories ?? 24))
    this.token = options.token
    this.username = options.username
    this.password = options.password
    this.credentialPath = options.configPath
    this.credentialSource = options.credentials
  }

  async credentialed(): Promise<boolean> {
    await this.prepareCredentials()
    return this.endpoint !== undefined && this.token !== undefined
  }

  async list(query: string, limit: number, signal?: AbortSignal): Promise<readonly DriveEntry[]> {
    const bounded = Math.max(0, Math.min(100, Math.trunc(limit)))
    if (bounded === 0) return []
    const needle = query.trim()
    if (needle.startsWith('/')) return this.listDirectory(needle.replace(/\/+$/u, '') || '/', bounded, signal)
    if (needle === '') return this.listDirectory(this.root, bounded, signal)
    try {
      const data = await this.api('/api/fs/search', {
        parent: this.root, keywords: needle, scope: 0, case_sensitive: false, page: 1, per_page: bounded,
      }, signal)
      return this.nodes(data).map(node => this.remember(node, typeof node.parent === 'string' ? node.parent : this.root)).slice(0, bounded)
    } catch (cause) {
      if (cause instanceof ReferenceAnythingError && cause.code === 'REFERENCE_CANCELLED') throw cause
      if (!(cause instanceof OpenListIndexUnavailable)) throw cause
      // Search commonly delegates to an optional external index. A failed index
      // is not a failed drive: bounded local walking returns useful partial hits.
      return this.walkFor(needle, bounded, signal)
    }
  }

  async describe(id: string, signal?: AbortSignal): Promise<DriveEntry | undefined> {
    const path = normalizeOpenListPath(id)
    const cached = this.entries.get(path)
    if (cached !== undefined) return cached
    try {
      const data = await this.api('/api/fs/get', { path }, signal)
      const node = object(data)
      return this.remember(node, parentOf(path))
    } catch (cause) {
      if (cause instanceof ReferenceAnythingError && cause.code === 'REFERENCE_NOT_FOUND') return undefined
      throw cause
    }
  }

  async extractedText(): Promise<string | undefined> { return undefined }

  async read(id: string, start: number, end: number, signal?: AbortSignal): Promise<DriveReadResult> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
      throw new ReferenceAnythingError('openlist: invalid byte range', 'REFERENCE_INVALID_URI')
    }
    await this.prepareCredentials()
    if (this.endpoint === undefined || this.token === undefined) throw new ReferenceAnythingError('OpenList is not connected', 'SOURCE_UNAVAILABLE')
    const path = normalizeOpenListPath(id)
    let url = this.rawUrls.get(path) ?? await this.resolveRawUrl(path, signal)
    let response = await this.fetchRaw(url, start, end, signal)
    if ([400, 401, 403, 404].includes(response.status) && this.rawUrls.has(path)) {
      await cancelResponse(response)
      this.rawUrls.delete(path)
      url = await this.resolveRawUrl(path, signal)
      response = await this.fetchRaw(url, start, end, signal)
    }
    if (!response.ok) { await cancelResponse(response); throw new ReferenceAnythingError(`openlist: raw download failed with HTTP ${response.status}`, 'REFERENCE_READ_FAILED') }
    const ranged = response.status === 206
    this.supportsRange = ranged
    return { bytes: await drain(response, end - start), ranged, ...totalFromResponse(response) === undefined ? {} : { totalSize: totalFromResponse(response)! } }
  }

  private async listDirectory(path: string, limit: number, signal?: AbortSignal): Promise<readonly DriveEntry[]> {
    const data = await this.api('/api/fs/list', { path, page: 1, per_page: limit, refresh: false }, signal)
    return this.nodes(data).map(node => this.remember(node, path)).slice(0, limit)
  }

  private async walkFor(query: string, limit: number, signal?: AbortSignal, markIncomplete = true): Promise<readonly DriveEntry[]> {
    const queue = [this.root]
    const visited = new Set<string>()
    const hits: DriveEntry[] = []
    while (queue.length > 0 && visited.size < this.maxWalkDirectories && hits.length < limit) {
      const directory = queue.shift()!
      if (visited.has(directory)) continue
      visited.add(directory)
      let children: readonly DriveEntry[]
      try { children = await this.listDirectory(directory, 100, signal) } catch (cause) {
        if (cause instanceof ReferenceAnythingError && cause.code === 'REFERENCE_CANCELLED') throw cause
        if (directory === this.root) throw cause
        continue
      }
      for (const child of children) {
        if (child.isDirectory && !visited.has(child.id)) queue.push(child.id)
        if (!child.isDirectory && child.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) hits.push(child)
        if (hits.length >= limit) break
      }
    }
    return markIncomplete ? hits.map(entry => ({ ...entry, searchIncomplete: true })) : hits
  }

  private async resolveRawUrl(path: string, signal?: AbortSignal): Promise<string> {
    const data = object(await this.api('/api/fs/get', { path }, signal))
    const raw = typeof data.raw_url === 'string' ? data.raw_url : typeof data.rawUrl === 'string' ? data.rawUrl : undefined
    if (raw === undefined || !/^https?:\/\//i.test(raw)) throw new ReferenceAnythingError('openlist: file has no raw download URL', 'REFERENCE_READ_FAILED')
    this.rawUrls.set(path, raw)
    this.remember(data, parentOf(path))
    return raw
  }

  private async fetchRaw(url: string, start: number, end: number, signal?: AbortSignal): Promise<Response> {
    try {
      let current = url
      for (let hop = 0; hop <= 5; hop += 1) {
        const target = await resolveRawDownloadTarget(current, this.resolveHost, this.endpoint)
        let response: Response | undefined
        for (const address of target.addresses) {
          signal?.throwIfAborted()
          try { response = await this.rawRequest(target.url, address, { redirect: 'manual', headers: { Range: `bytes=${start}-${end - 1}` }, signal }); break } catch {
            if (signal?.aborted) throw signal.reason
          }
        }
        if (response === undefined) throw new Error('all validated addresses failed')
        if (![301, 302, 303, 307, 308].includes(response.status)) return response
        await response.body?.cancel().catch(() => undefined)
        if (hop === 5) throw new Error('redirect limit')
        const location = response.headers.get('location')
        if (location === null) throw new Error('redirect missing location')
        const next = new URL(location, current)
        if (new URL(current).protocol === 'https:' && next.protocol === 'http:') throw new Error('redirect downgrade')
        current = next.href
      }
      throw new Error('redirect limit')
    } catch {
      if (signal?.aborted) throw new ReferenceAnythingError('openlist: request cancelled', 'REFERENCE_CANCELLED')
      throw new ReferenceAnythingError('openlist: raw download failed', 'REFERENCE_READ_FAILED')
    }
  }

  private async api(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.prepareCredentials()
    if (this.endpoint === undefined || this.token === undefined) throw new ReferenceAnythingError('OpenList is not connected', 'SOURCE_UNAVAILABLE')
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (this.endpoint === undefined || this.token === undefined) throw new ReferenceAnythingError('OpenList is not connected', 'SOURCE_UNAVAILABLE')
        const response = await this.fetchImpl(`${this.endpoint}${path}`, { method: 'POST', signal, headers: { Authorization: this.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        try { return await classifyApiResponse(response, path) } catch (cause) {
          if (!(cause instanceof OpenListAuthRequired) || attempt !== 0 || this.credentialSource === undefined) throw cause
          await this.prepareCredentials(true)
        }
      }
      throw new ReferenceAnythingError('openlist: API request failed', 'REFERENCE_READ_FAILED')
    } catch (cause) {
      if (cause instanceof OpenListIndexUnavailable) throw cause
      if (cause instanceof ReferenceAnythingError) throw cause
      if (signal?.aborted) throw new ReferenceAnythingError('openlist: request cancelled', 'REFERENCE_CANCELLED')
      throw new ReferenceAnythingError('openlist: API request failed', 'REFERENCE_READ_FAILED')
    }
  }

  private nodes(data: unknown): OpenListNode[] {
    const row = object(data)
    const value = Array.isArray(row.content) ? row.content : Array.isArray(data) ? data : []
    return value.filter((node): node is OpenListNode => node !== null && typeof node === 'object')
  }

  private remember(node: OpenListNode | Record<string, unknown>, parent: string): DriveEntry {
    const name = typeof node.name === 'string' && node.name !== '' ? node.name : 'unnamed'
    const path = normalizeOpenListPath(typeof node.path === 'string' ? node.path : `${parent}/${name}`)
    const modified = modifiedAt(node.modified) ?? modifiedAt(node.updated_at)
    const entry: DriveEntry = { kind: 'openlist', id: path, path, name, size: finite(node.size), isDirectory: node.is_dir === true || node.isDir === true, ...modified === undefined ? {} : { modifiedAt: modified } }
    this.entries.set(path, entry)
    return entry
  }

  private async prepareCredentials(refresh = false): Promise<void> {
    // A manager source is authoritative and read on every operation.  A
    // disconnect or token rotation must invalidate cached signed URLs before
    // the provider ever makes another filesystem request.
    if (this.credentialSource !== undefined) {
      const supplied = await this.credentialSource(refresh)
      if (supplied === undefined || supplied.token === undefined) { this.endpoint = undefined; this.token = undefined; this.credentialFingerprint = undefined; this.rawUrls.clear(); this.entries.clear(); return }
      const endpoint = validateOpenListEndpoint(supplied.endpoint)
      const fingerprint = `${endpoint}\0${supplied.token}\0${supplied.generation ?? 0}`
      if (this.credentialFingerprint !== fingerprint) { this.rawUrls.clear(); this.entries.clear(); this.credentialFingerprint = fingerprint }
      this.endpoint = endpoint; this.token = supplied.token
      return
    }
    if (this.endpoint !== undefined && this.token !== undefined) return
    const credentials = await readOpenListCredentials(this.credentialPath)
    if (credentials !== undefined) { this.endpoint = validateOpenListEndpoint(credentials.endpoint); this.token = credentials.token; return }
    if (this.endpoint !== undefined && this.username !== undefined) this.token = await authenticateOpenList(this.endpoint, this.username, this.password ?? '', this.fetchImpl)
  }
}

class OpenListIndexUnavailable extends Error { constructor() { super('OpenList search index is unavailable') } }
class OpenListAuthRequired extends Error {}

async function classifyApiResponse(response: Response, path: string): Promise<unknown> {
  if (response.status === 401) { await cancelResponse(response); throw new OpenListAuthRequired() }
  if (response.status === 404) { await cancelResponse(response); throw new ReferenceAnythingError('openlist: file not found', 'REFERENCE_NOT_FOUND') }
  if (!response.ok) {
    if (path === '/api/fs/search' && (response.status === 501 || response.status === 503)) { await cancelResponse(response); throw new OpenListIndexUnavailable() }
    if (path === '/api/fs/search' && response.status === 500) {
      const message = await response.text().catch(() => '')
      if (message.trim() === '' || /(search\s+not\s+available|index.{0,24}(none|unavailable|disabled|not\s+(available|configured|found))|no.{0,12}index)/i.test(message)) throw new OpenListIndexUnavailable()
    } else await cancelResponse(response)
    throw new ReferenceAnythingError(`openlist: API failed with HTTP ${response.status}`, 'REFERENCE_READ_FAILED')
  }
  const payload: unknown = await response.json(); const envelope = object(payload)
  if (envelope.code === 401) throw new OpenListAuthRequired()
  if (typeof envelope.code === 'number' && envelope.code !== 200) {
    if (path === '/api/fs/search' && typeof envelope.message === 'string' && /(search\s+not\s+available|index.{0,24}(none|unavailable|disabled|not\s+(available|configured|found))|no.{0,12}index)/i.test(envelope.message)) throw new OpenListIndexUnavailable()
    throw new ReferenceAnythingError('openlist: API request failed', envelope.code === 404 ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_READ_FAILED')
  }
  return envelope.data ?? payload
}

export async function validateRawDownloadUrl(value: string, resolveHost: (hostname: string) => Promise<readonly { readonly address: string }[]> = async hostname => await lookup(hostname, { all: true }), trustedEndpoint?: string): Promise<URL> {
  return (await resolveRawDownloadTarget(value, resolveHost, trustedEndpoint)).url
}

async function resolveRawDownloadTarget(value: string, resolveHost: (hostname: string) => Promise<readonly { readonly address: string }[]>, trustedEndpoint?: string): Promise<{ url: URL, addresses: readonly string[] }> {
  let url: URL
  try { url = new URL(value) } catch { throw new ReferenceAnythingError('openlist: raw download URL rejected', 'REFERENCE_READ_FAILED') }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') throw new ReferenceAnythingError('openlist: raw download URL rejected', 'REFERENCE_READ_FAILED')
  const trustedOrigin = trustedEndpoint === undefined ? undefined : new URL(validateOpenListEndpoint(trustedEndpoint)).origin
  const trustedHttp = url.protocol === 'http:' && trustedOrigin !== undefined && url.origin === trustedOrigin && isTrustedLoopbackOrigin(url)
  if (url.protocol !== 'https:' && !trustedHttp) throw new ReferenceAnythingError('openlist: raw download URL rejected', 'REFERENCE_READ_FAILED')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!trustedHttp && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata' || hostname === 'instance-data' || hostname === 'metadata.google.internal' || hostname === 'metadata.google' || hostname === 'metadata.azure.internal')) throw new ReferenceAnythingError('openlist: raw download URL rejected', 'REFERENCE_READ_FAILED')
  let addresses: readonly { readonly address: string }[]
  try { addresses = isIP(hostname) ? [{ address: hostname }] : await resolveHost(hostname) } catch { throw new ReferenceAnythingError('openlist: raw download URL rejected', 'REFERENCE_READ_FAILED') }
  if (addresses.length === 0 || addresses.some(row => trustedHttp ? !isLoopbackAddress(row.address) : unsafeAddress(row.address))) throw new ReferenceAnythingError('openlist: raw download URL rejected', 'REFERENCE_READ_FAILED')
  return { url, addresses: [...new Set(addresses.map(row => row.address))] }
}

function unsafeAddress(address: string): boolean {
  const value = address.toLowerCase().split('%')[0]!
  if (isIP(value) === 4) {
    const parts = value.split('.').map(Number); const [a, b, c] = parts
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 100 && b! >= 64 && b! <= 127 || a === 198 && (b === 18 || b === 19) || a! >= 224 || a === 192 && b === 0 && c === 0
  }
  if (isIP(value) === 6) {
    if (!isGlobalUnicastIPv6(value)) return true
    const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
    if (mapped !== undefined) return unsafeAddress(mapped)
    const hexMapped = value.match(/::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/)
    if (hexMapped !== null) {
      const high = Number.parseInt(hexMapped[1]!, 16); const low = Number.parseInt(hexMapped[2]!, 16)
      return unsafeAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`)
    }
    return false
  }
  return true
}

/** Conservative IANA-special-purpose exclusions; unknown unicast stays usable. */
export function isGlobalUnicastIPv6(value: string): boolean {
  const address = value.toLowerCase().split('%')[0]!
  if (isIP(address) !== 6) return false
  const words = ipv6Words(address)
  if (words === undefined) return false
  const [a, b, c, d] = words
  // The entire IPv4-compatible ::/96 family has legacy platform-dependent
  // routing semantics and must never be treated as public IPv6.
  if (words.slice(0, 6).every(word => word === 0)) return false
  if (words.slice(0, 7).every(word => word === 0) && words[7]! <= 1) return false
  if ((a! & 0xff00) === 0xff00 || (a! & 0xfe00) === 0xfc00 || (a! & 0xff80) === 0xfe80) return false
  // IANA special-purpose ranges that are not globally forwardable: discard,
  // SRv6 SIDs, documentation and benchmarking assignments.
  if (a === 0x0100 && b === 0 && c === 0 && d === 0 || a === 0x5f00 || a === 0x3fff && (b! & 0xf000) === 0) return false
  if (a === 0x2001 && (b === 0 || b === 2 && c === 0 || b === 4 && c === 0x0112 || b === 0x0db8 || (b! & 0xfff0) === 0x0010 || (b! & 0xfff0) === 0x0020)) return false
  // Translation/mapped forms and 6to4 can smuggle a non-global IPv4 address.
  if (address.includes('::ffff:') || /^64:ff9b(?::|$)/.test(address) || /^64:ff9b:1(?::|$)/.test(address)) return false
  if (/^2002:/.test(address)) {
    const match = address.match(/^2002:([a-f0-9]{1,4}):([a-f0-9]{1,4})/)
    if (match === null) return false
    const high = Number.parseInt(match[1]!, 16); const low = Number.parseInt(match[2]!, 16)
    return !unsafeAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`)
  }
  // Discard-only, ORCHID and benchmarking/documentation assignments.
  if (/^100::/.test(address) || /^2001:(?:0|10|20)(?::|$)/.test(address)) return false
  return true
}

function isLoopbackAddress(address: string): boolean { const value = address.toLowerCase().split('%')[0]!; return value === '::1' || value === '127.0.0.1' }
function isTrustedLoopbackOrigin(url: URL): boolean { const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase(); return host === 'localhost' || isLoopbackAddress(host) }

function ipv6Words(address: string): readonly number[] | undefined {
  const halves = address.split('::')
  if (halves.length > 2) return undefined
  const parse = (part: string): number[] | undefined => {
    if (part === '') return []
    const result: number[] = []
    for (const token of part.split(':')) {
      if (token.includes('.')) {
        const octets = token.split('.').map(Number)
        if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
        result.push(octets[0]! * 256 + octets[1]!, octets[2]! * 256 + octets[3]!)
      } else {
        const word = Number.parseInt(token, 16)
        if (!/^[a-f0-9]{1,4}$/i.test(token) || !Number.isInteger(word)) return undefined
        result.push(word)
      }
    }
    return result
  }
  const left = parse(halves[0]!)
  const right = parse(halves[1] ?? '')
  if (left === undefined || right === undefined) return undefined
  const missing = 8 - left.length - right.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined
  return [...left, ...Array.from({ length: missing }, () => 0), ...right]
}

/** Connect to the already-validated address while authenticating the original TLS hostname. */
export function pinnedRawRequest(url: URL, address: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false
    let responseStream: import('node:http').IncomingMessage | undefined
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => { headers[name] = value })
    headers.host = url.host
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: url.protocol, hostname: address, port: url.port === '' ? undefined : Number(url.port), path: `${url.pathname}${url.search}`, method: 'GET', headers,
      ...(url.protocol === 'https:' ? { servername: url.hostname, rejectUnauthorized: true } : {}), signal: init.signal ?? undefined, agent: false,
    }, response => {
      responseStream = response
      try {
        const status = response.statusCode
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) { response.destroy(); fail(new Error('invalid upstream status')); return }
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
          else if (value !== undefined) responseHeaders.set(name, String(value))
        }
        const noBody = status === 204 || status === 205 || status === 304
        if (noBody) response.destroy()
        else {
          const clear = (): void => clearTimeout(totalTimeout)
          response.once('end', clear)
          response.once('close', clear)
        }
        succeed(new Response(noBody ? null : Readable.toWeb(response) as unknown as BodyInit, { status, statusText: response.statusMessage, headers: responseHeaders }), noBody)
      } catch { response.destroy(); fail(new Error('invalid upstream response')) }
    })
    const totalTimeout = setTimeout(() => {
      const error = new Error('raw request timed out')
      responseStream?.destroy(error)
      request.destroy(error)
    }, 10_000)
    totalTimeout.unref?.()
    const finish = (clearTimer = true): boolean => {
      if (settled) return false
      settled = true
      if (clearTimer) clearTimeout(totalTimeout)
      return true
    }
    const succeed = (response: Response, clearTimer: boolean): void => { if (finish(clearTimer)) resolve(response) }
    const fail = (cause: unknown): void => {
      if (!finish()) return
      // Parser failures (for example an out-of-range status) can leave the
      // underlying socket open even though ClientRequest emitted `error`.
      // Close both handles before rejecting so callers and their servers do
      // not retain an unusable connection until the peer times out.
      request.destroy()
      request.socket?.destroy()
      const error = cause instanceof Error ? cause : new Error('invalid upstream response')
      const parserCode = typeof (error as Error & { code?: unknown }).code === 'string' ? (error as Error & { code: string }).code : ''
      reject(parserCode === 'HPE_INVALID_STATUS' || /invalid response status/i.test(error.message) ? new Error('invalid upstream status') : error)
    }
    request.once('error', fail)
    request.end()
  })
}

async function cancelResponse(response: Response): Promise<void> {
  if (response.body === null) return
  await Promise.race([
    response.body.cancel().catch(() => undefined),
    new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); timer.unref?.() }),
  ])
}

function object(value: unknown): Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {} }
function finite(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }
function parentOf(path: string): string { const cut = path.lastIndexOf('/'); return cut <= 0 ? '/' : path.slice(0, cut) }
function modifiedAt(value: unknown): number | undefined { if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000; if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined } return undefined }
