/**
 * Host-only OpenList management. Nothing in this module is exported over a
 * Typert remote: endpoints, credentials, and raw URLs stay in the Host.
 */
import { createHash, randomBytes } from 'node:crypto'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir, platform, arch } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { ReferenceAnythingError } from '../errors.ts'

/** Deliberately fixed; upgrades are a conscious manifest change. */
export const OPENLIST_FIXED_VERSION = 'v4.2.2'
export const OPENLIST_CREDENTIAL_DIRECTORY = join(homedir(), '.dsh', 'reference-anything', 'openlist')
export const OPENLIST_CREDENTIAL_FILE = join(OPENLIST_CREDENTIAL_DIRECTORY, 'credentials.json')

export interface OpenListAsset { readonly platform: string, readonly arch: string, readonly url: string, readonly sha256: string, readonly archive: 'tar.gz' | 'zip', readonly binary: string }
export interface OpenListReleaseManifest { readonly version: string, readonly assets: readonly OpenListAsset[] }
/** SHA-256 values were computed from the six named GitHub v4.2.2 release assets. */
export const OPENLIST_RELEASE: OpenListReleaseManifest = { version: OPENLIST_FIXED_VERSION, assets: [
  { platform: 'win32', arch: 'x64', archive: 'zip', binary: 'openlist.exe', sha256: '2b8bbf264939392a5608e405e51125136fe7c513260103813f3951c633875b64', url: 'https://github.com/OpenListTeam/OpenList/releases/download/v4.2.2/openlist-windows-amd64.zip' },
  { platform: 'win32', arch: 'arm64', archive: 'zip', binary: 'openlist.exe', sha256: '2a352401d92c538b2376f37d8cb49eadd34398998e03689515d8d41fac3e7263', url: 'https://github.com/OpenListTeam/OpenList/releases/download/v4.2.2/openlist-windows-arm64.zip' },
  { platform: 'linux', arch: 'x64', archive: 'tar.gz', binary: 'openlist', sha256: 'c4781f22ffd6bc6854bfbc0ecba7b0aaf5e6cf416c9d36d87fb335df14ab8cb6', url: 'https://github.com/OpenListTeam/OpenList/releases/download/v4.2.2/openlist-linux-amd64.tar.gz' },
  { platform: 'linux', arch: 'arm64', archive: 'tar.gz', binary: 'openlist', sha256: '04b2a4894c9228407e1a9b6cedefc7d6d948f1f07827878325c02462ae2274f3', url: 'https://github.com/OpenListTeam/OpenList/releases/download/v4.2.2/openlist-linux-arm64.tar.gz' },
  { platform: 'darwin', arch: 'x64', archive: 'tar.gz', binary: 'openlist', sha256: '9d0fef008bea91dda99428895df92bb476386f90af4a06fe7c041dd13ca5b7a3', url: 'https://github.com/OpenListTeam/OpenList/releases/download/v4.2.2/openlist-darwin-amd64.tar.gz' },
  { platform: 'darwin', arch: 'arm64', archive: 'tar.gz', binary: 'openlist', sha256: '19998745ff530db36c3a6f307b1c9c864d6db78d2084b35ffdec0f3ea524bad4', url: 'https://github.com/OpenListTeam/OpenList/releases/download/v4.2.2/openlist-darwin-arm64.tar.gz' },
] }

export interface OpenListCredentials { readonly endpoint: string, readonly username?: string, readonly password?: string, readonly token?: string, readonly mode?: 'managed' | 'external', readonly version?: string, /** Host-only cache revision. */ readonly generation?: number }
export type OpenListAdminMutationState = 'not-started' | 'committed' | 'unknown'
/** Safe administration facts.  No storage addition, credentials, or raw URLs cross this boundary. */
export interface OpenListMount {
  readonly id: string; readonly name: string; readonly driver: string; readonly enabled: boolean
  readonly status?: 'ready' | 'disabled' | 'error'; readonly error?: string; readonly capacityUsed?: number; readonly capacityTotal?: number
  readonly indexStatus?: 'idle' | 'running' | 'complete' | 'failed'; readonly indexProgress?: number; readonly indexCount?: number
}
export interface OpenListDriverField { readonly name: string, readonly label: string, readonly type: 'text' | 'password' | 'number' | 'boolean' | 'select', readonly secret: boolean, readonly required: boolean, readonly hasDefault?: boolean, readonly default?: string | number | boolean, readonly options?: readonly { readonly label: string, readonly value: string }[] }
export interface OpenListDriver { readonly name: string, readonly description?: string, readonly quickAuth: boolean, readonly fields: readonly OpenListDriverField[] }
/** Host-only mount creation values. `addition` is serialized only on the Host. */
export interface OpenListMountInput { readonly mountPath: string, readonly driver: string, readonly addition: Record<string, unknown>, readonly order?: number, readonly remark?: string }
export interface OpenListSeams {
  readonly fetch?: typeof fetch
  readonly spawn?: typeof nodeSpawn
  readonly readFile?: typeof readFile
  readonly writeFile?: typeof writeFile
  readonly mkdir?: typeof mkdir
  readonly chmod?: typeof chmod
  readonly rename?: typeof rename
  readonly copyFile?: typeof copyFile
  readonly unlink?: typeof unlink
  readonly fsyncFile?: (path: string) => Promise<void>
  /** Required on Windows to apply a restrictive ACL (for example via icacls). */
  readonly securePermissions?: (path: string, directory: boolean) => Promise<void>
  readonly sleep?: (ms: number) => Promise<void>
  /** Test/integration seam for the executable replacement transaction. */
  readonly install?: typeof installOpenList
}

/**
 * Process-local ownership of executable replacement transactions. A recovery
 * probe must only repair state left by a dead process, never state that a live
 * installer in this process still owns.
 */
const activeExecutableReplacements = new Map<string, symbol>()
/**
 * `admin random` mutates the database before its output can be observed. Keep
 * ownership until the operating-system child handle confirms `close`, even
 * when the caller has already received a timeout error.
 */
const activeAdminMutations = new Map<string, symbol>()

function acquireExecutableReplacement(target: string): symbol {
  if (activeExecutableReplacements.has(target)) throw new ReferenceAnythingError('OpenList executable replacement is already in progress', 'REFERENCE_SYNC_IN_PROGRESS')
  const owner = Symbol(target)
  activeExecutableReplacements.set(target, owner)
  return owner
}

function releaseExecutableReplacement(target: string, owner: symbol): void {
  if (activeExecutableReplacements.get(target) === owner) activeExecutableReplacements.delete(target)
}

function acquireAdminMutation(dataDirectory: string): { key: string, owner: symbol } {
  const key = resolve(dataDirectory)
  if (activeAdminMutations.has(key)) throw new ReferenceAnythingError('OpenList administrator password change is already in progress', 'REFERENCE_SYNC_IN_PROGRESS')
  const owner = Symbol(key)
  activeAdminMutations.set(key, owner)
  return { key, owner }
}

function releaseAdminMutation(key: string, owner: symbol): void {
  if (activeAdminMutations.get(key) === owner) activeAdminMutations.delete(key)
}

/** Exchange external username/password for the raw OpenList token. */
export async function authenticateOpenList(endpoint: string, username: string, password: string, fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetchImpl(`${validateOpenListEndpoint(endpoint)}/api/auth/login`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
    if (!response.ok) throw new Error('login rejected')
    const payload = object(await response.json())
    const data = object(payload.data ?? payload)
    if (typeof payload.code === 'number' && payload.code !== 200) throw new Error('login rejected')
    if (typeof data.token !== 'string' || data.token === '') throw new Error('missing token')
    return data.token
  } catch (error) {
    if (isAbortError(error, signal)) throw abortError(signal)
    throw new ReferenceAnythingError('OpenList authentication failed', 'SOURCE_UNAVAILABLE')
  }
}

/** Download only a manifest-pinned binary after validating its SHA-256. */
export async function installOpenList(
  dataRoot: string,
  manifest: OpenListReleaseManifest = OPENLIST_RELEASE,
  seams: OpenListSeams = {},
  os = platform(),
  cpu = arch(),
  signal?: AbortSignal,
  retainBackup = false,
): Promise<{ version: string, path: string, finish: (success: boolean) => Promise<void> }> {
  signal?.throwIfAborted()
  const asset = selectOpenListAsset(manifest, os, cpu)
  const fetchImpl = seams.fetch ?? fetch
  let response: Response
  try { response = await fetchImpl(asset.url, { signal }) } catch (cause) { if (isAbortError(cause, signal)) throw abortError(signal); throw new ReferenceAnythingError('OpenList download failed', 'REFERENCE_READ_FAILED', { cause }) }
  if (!response.ok) throw new ReferenceAnythingError(`OpenList download failed with HTTP ${response.status}`, 'REFERENCE_READ_FAILED')
  const bytes = new Uint8Array(await response.arrayBuffer())
  signal?.throwIfAborted()
  if (!verifyOpenListAsset(bytes, asset.sha256)) throw new ReferenceAnythingError('OpenList download SHA-256 verification failed', 'REFERENCE_READ_FAILED')
  const binary = unpackOpenListBinary(bytes, asset)
  const directory = join(dataRoot, 'bin', manifest.version)
  const target = join(directory, asset.binary)
  await (seams.mkdir ?? mkdir)(directory, { recursive: true, mode: 0o700 })
  await securePath(directory, true, seams.chmod ?? chmod, seams, os === 'win32')
  const temporary = join(directory, `.${asset.binary}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  const backup = join(directory, `.${asset.binary}.replacement-backup`)
  const marker = join(directory, `.${asset.binary}.replacement-pending`)
  const simulatedFilesystem = seams.writeFile !== undefined && seams.rename === undefined
  const move = seams.rename ?? (simulatedFilesystem ? async () => undefined : rename); const remove = seams.unlink ?? (simulatedFilesystem ? async () => undefined : unlink)
  const owner = acquireExecutableReplacement(target)
  let ownershipRetained = false
  let backedUp = false; let committed = false
  try {
    await (seams.writeFile ?? writeFile)(temporary, binary, { mode: 0o700, flag: 'wx' })
    await (seams.fsyncFile ?? (seams.writeFile === undefined ? fsyncPath : async () => undefined))(temporary)
    await secureExecutable(temporary, seams.chmod ?? chmod, seams, os === 'win32')
    signal?.throwIfAborted()
    await recoverInterruptedReplacement(target, backup, marker, seams, os === 'win32', owner)
    if (os === 'win32') {
      try {
        await (seams.writeFile ?? writeFile)(marker, 'pending', { mode: 0o600, flag: 'wx' })
        await securePath(marker, false, seams.chmod ?? chmod, seams, true)
        await move(target, backup); backedUp = true
      } catch (cause) { if (!isMissing(cause)) throw cause }
    } else {
      try { await (seams.copyFile ?? copyFile)(target, backup); backedUp = true } catch (cause) { if (!isMissing(cause)) throw cause }
    }
    await move(temporary, target); committed = true
    // Rename preserves the already-restricted mode/ACL of the temporary file.
    // Avoid a second post-commit permission operation that could fail after
    // the replacement has become visible.
    if (!retainBackup) {
      if (backedUp) await remove(backup)
      if (os === 'win32') await remove(marker).catch(cause => { if (!isMissing(cause)) throw cause })
    }
    ownershipRetained = retainBackup
  } catch {
    await remove(temporary).catch(() => undefined)
    if (backedUp) {
      if (!committed) await move(backup, target).catch(() => undefined)
      else await move(backup, target).catch(() => undefined)
    }
    throw new ReferenceAnythingError('Could not atomically install OpenList', 'REFERENCE_READ_FAILED')
  } finally {
    if (!ownershipRetained) releaseExecutableReplacement(target, owner)
  }
  let finishState: 'active' | 'committed' | 'rolled-back' = 'active'
  let rollbackRestored = false
  const finish = async (success: boolean): Promise<void> => {
    if (!retainBackup) return
    if (finishState !== 'active') return
    try {
      if (!success) {
        if (backedUp && !rollbackRestored) {
          if (os === 'win32') await remove(target).catch(cause => { if (!isMissing(cause)) throw cause })
          await move(backup, target)
          rollbackRestored = true
        }
        if (os === 'win32') await remove(marker).catch(cause => { if (!isMissing(cause)) throw cause })
        finishState = 'rolled-back'
        releaseExecutableReplacement(target, owner)
        return
      }
      if (os === 'win32') {
        // Removing the durable pending marker is the Windows commit point.
        // Until this succeeds the backup must remain available to finish(false).
        await remove(marker).catch(cause => { if (!isMissing(cause)) throw cause })
        finishState = 'committed'
        releaseExecutableReplacement(target, owner)
        // The replacement is durable now. A locked backup is harmless stale
        // cleanup state and must never make the caller roll back the new target.
        if (backedUp) await remove(backup).catch(() => undefined)
        return
      }
      if (backedUp) await remove(backup)
      finishState = 'committed'
      releaseExecutableReplacement(target, owner)
    } catch { throw new ReferenceAnythingError(success ? 'Could not finalize OpenList executable replacement' : 'Could not restore OpenList executable', 'REFERENCE_READ_FAILED') }
  }
  return { version: manifest.version, path: target, finish }
}

/** Extract only the expected executable; archive paths never reach the filesystem. */
export function unpackOpenListBinary(archive: Uint8Array, asset: OpenListAsset): Uint8Array {
  if (asset.binary === '' || asset.binary.includes('/') || asset.binary.includes('\\') || asset.binary.includes('..')) throw new ReferenceAnythingError('OpenList manifest binary name is unsafe', 'REFERENCE_INVALID_CONFIG')
  const bytes = asset.archive === 'tar.gz' ? tarEntry(new Uint8Array(gunzipSync(archive)), asset.binary) : zipEntry(archive, asset.binary)
  if (bytes === undefined) throw new ReferenceAnythingError('OpenList archive did not contain its expected binary', 'REFERENCE_READ_FAILED')
  return bytes
}

/** Select exactly the release asset for this OS and CPU architecture. */
export function selectOpenListAsset(manifest: OpenListReleaseManifest, os = platform(), cpu = arch()): OpenListAsset {
  if (manifest.version !== OPENLIST_FIXED_VERSION) throw new ReferenceAnythingError(`OpenList manifest must pin ${OPENLIST_FIXED_VERSION}`, 'REFERENCE_INVALID_CONFIG')
  const asset = manifest.assets.find(item => item.platform === os && item.arch === cpu)
  if (asset === undefined) throw new ReferenceAnythingError(`OpenList ${manifest.version} has no verified asset for ${os}/${cpu}`, 'REFERENCE_INVALID_CONFIG')
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) throw new ReferenceAnythingError('OpenList asset has no verifiable SHA-256', 'REFERENCE_INVALID_CONFIG')
  return asset
}

export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
export function verifyOpenListAsset(bytes: Uint8Array, expected: string): boolean { return /^[a-f0-9]{64}$/i.test(expected) && sha256(bytes).toLowerCase() === expected.toLowerCase() }

/** Validate an endpoint without leaking its full value in a diagnostic. */
export function validateOpenListEndpoint(value: string, managed = false): string {
  let url: URL
  try { url = new URL(value) } catch { throw new ReferenceAnythingError('OpenList endpoint is invalid', 'REFERENCE_INVALID_CONFIG') }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new ReferenceAnythingError('OpenList endpoint must not contain credentials or a query', 'REFERENCE_INVALID_CONFIG')
  const loopback = isLoopback(url.hostname)
  if (managed && !loopback) throw new ReferenceAnythingError('Managed OpenList must listen only on loopback', 'REFERENCE_INVALID_CONFIG')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ReferenceAnythingError('Remote OpenList endpoints require HTTPS (HTTP is allowed only on loopback)', 'REFERENCE_INVALID_CONFIG')
  }
  return url.href.replace(/\/$/, '')
}

export function isLoopback(host: string): boolean { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase()) }

/** Ask the kernel for a loopback port. Start immediately afterwards to minimize the normal port race. */
export async function chooseOpenListPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('could not allocate OpenList port')); return }
      server.close(error => error === undefined ? resolve(address.port) : reject(error))
    })
  })
}

export async function readOpenListCredentials(path = OPENLIST_CREDENTIAL_FILE, seams: OpenListSeams = {}): Promise<OpenListCredentials | undefined> {
  try {
    const text = await (seams.readFile ?? readFile)(path, 'utf8')
    const data: unknown = JSON.parse(text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
    const row = data as Record<string, unknown>
    if (typeof row.endpoint !== 'string') return undefined
    const endpoint = validateOpenListEndpoint(row.endpoint)
    if (typeof row.token !== 'string' || row.token === '') return undefined
    return { endpoint, token: row.token, ...(row.mode === 'managed' || row.mode === 'external' ? { mode: row.mode } : {}), ...(typeof row.password === 'string' && row.password !== '' ? { password: row.password } : {}), ...(typeof row.version === 'string' && /^v\d+\.\d+\.\d+$/.test(row.version) ? { version: row.version } : {}) }
  } catch { return undefined }
}

export async function writeOpenListCredentials(credentials: OpenListCredentials, path = OPENLIST_CREDENTIAL_FILE, seams: OpenListSeams = {}, signal?: AbortSignal): Promise<void> {
  const endpoint = validateOpenListEndpoint(credentials.endpoint)
  if (credentials.token === undefined || credentials.token === '') throw new ReferenceAnythingError('OpenList token is required', 'REFERENCE_INVALID_CONFIG')
  const makeDir = seams.mkdir ?? mkdir
  const write = seams.writeFile ?? writeFile
  const mode = seams.chmod ?? chmod
  const directory = dirname(path)
  await makeDir(directory, { recursive: true, mode: 0o700 })
  await securePath(directory, true, mode, seams)
  // Rename is the credential commit boundary, so readers see either the old
  // complete token or the new complete token, never a truncated JSON file.
  signal?.throwIfAborted()
  const temporary = join(directory, `.credentials-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  await write(temporary, JSON.stringify({ endpoint, token: credentials.token, ...(credentials.mode === undefined ? {} : { mode: credentials.mode }), ...(credentials.password === undefined ? {} : { password: credentials.password }), ...(credentials.version === undefined ? {} : { version: credentials.version }) }), { encoding: 'utf8', mode: 0o600 })
  await securePath(temporary, false, mode, seams)
  signal?.throwIfAborted()
  try { await (seams.rename ?? rename)(temporary, path) } catch {
    await (seams.unlink ?? unlink)(temporary).catch(() => undefined)
    throw new ReferenceAnythingError('Could not persist OpenList credentials', 'REFERENCE_READ_FAILED')
  }
}

/** A Host-private authenticated API wrapper with redacted errors and safe mount shapes. */
export class OpenListHostClient {
  private readonly fetchImpl: typeof fetch
  private readonly secretDefaults = new Map<string, Map<string, unknown>>()
  constructor(private credentials: OpenListCredentials, seams: OpenListSeams = {}, private readonly refreshToken?: (signal?: AbortSignal) => Promise<OpenListCredentials>, private readonly managed = false) {
    validateOpenListEndpoint(credentials.endpoint)
    this.fetchImpl = seams.fetch ?? fetch
  }
  async connect(signal?: AbortSignal): Promise<void> {
    const me = object(await this.request('/api/me', 'GET', undefined, signal))
    // OpenList's administrator is the built-in user id 1. Older responses may
    // omit it, but an explicit non-admin identity must never be accepted.
    if (typeof me.id === 'number' && me.id !== 1 || typeof me.role === 'number' && me.role !== 2 || typeof me.role === 'string' && me.role.toLowerCase() !== 'admin') {
      throw new ReferenceAnythingError('OpenList administrator access is required', 'SOURCE_UNAVAILABLE')
    }
  }
  async drivers(signal?: AbortSignal): Promise<string[]> { return (await this.driverInfo(signal)).map(driver => driver.name) }
  async driverInfo(signal?: AbortSignal): Promise<OpenListDriver[]> {
    const data = await this.request('/api/admin/driver/list', 'GET', undefined, signal)
    const root = object(data)
    const list: unknown[] = Array.isArray(data) ? data : Array.isArray(root.content) ? root.content as unknown[] : Object.entries(root).map(([name, value]) => ({ name, ...object(value) }))
    return list.flatMap((value): OpenListDriver[] => {
      if (typeof value === 'string') return [{ name: value, quickAuth: isApiPagesQuickDriver(value), fields: [] }]
      const row = object(value)
      if (typeof row.name !== 'string' || row.name === '') return []
      // In OpenList v4, `common` describes the storage model and `config`
      // describes the driver itself. Only `additional` is serialized into a
      // storage's addition JSON.
      const rawFields = asArray(row.additional)
      const driverSecretDefaults = new Map<string, unknown>()
      const fields = rawFields.flatMap((field): OpenListDriverField[] => {
        const info = object(field); const name = typeof info.name === 'string' ? info.name : typeof info.key === 'string' ? info.key : ''
        if (name === '') return []
        const rawType = typeof info.type === 'string' ? info.type.toLowerCase() : 'text'
        const numeric = /^(number|integer|int|int32|int64|uint|uint32|uint64|float|float32|float64)$/.test(rawType)
        const secret = rawType === 'password' || rawType === 'secret' || isSensitiveDriverField(name)
        const type: OpenListDriverField['type'] = secret && (rawType === 'password' || rawType === 'secret') ? 'password' : numeric ? 'number' : rawType === 'boolean' || rawType === 'bool' ? 'boolean' : rawType === 'select' || rawType === 'enum' ? 'select' : 'text'
        const options = parseDriverOptions(info.options ?? info.values)
        const typedDefault = typedDriverDefault(type, info.default ?? info.default_value ?? info.value)
        if (secret && typedDefault !== undefined) driverSecretDefaults.set(name, typedDefault)
        return [{ name, label: typeof info.label === 'string' ? info.label : typeof info.title === 'string' ? info.title : name, type, secret, required: info.required === true || info.required === 'true', ...(secret && typedDefault !== undefined ? { hasDefault: true } : {}), ...(secret || typedDefault === undefined ? {} : { default: typedDefault }), ...(options.length === 0 ? {} : { options }) }]
      })
      this.secretDefaults.set(row.name, driverSecretDefaults)
      return [{ name: row.name, ...(typeof row.description === 'string' ? { description: row.description } : {}), quickAuth: isApiPagesQuickDriver(row.name), fields }]
    })
  }
  fillSecretDefaults(driver: string, supplied: Record<string, unknown>): Record<string, unknown> { return { ...Object.fromEntries(this.secretDefaults.get(driver) ?? []), ...supplied } }
  async mounts(signal?: AbortSignal): Promise<OpenListMount[]> {
    const rows = this.mountRows(await this.request('/api/admin/storage/list', 'GET', undefined, signal))
    const progress = await this.indexProgress(signal).catch(() => undefined)
    return progress === undefined ? rows : rows.map(row => ({ ...row, ...progress }))
  }
  async createMount(input: OpenListMountInput, signal?: AbortSignal): Promise<OpenListMount> { const data = object(await this.request('/api/admin/storage/create', 'POST', storageBody(input, {}, this.managed), signal)); return { id: typeof data.id === 'number' || typeof data.id === 'string' ? String(data.id) : '', name: input.mountPath, driver: input.driver, enabled: true, status: 'error', error: 'OpenList storage is starting' } }
  async updateMount(id: string, input: OpenListMountInput, signal?: AbortSignal): Promise<OpenListMount> { const parsedId = positiveStorageId(id); await this.request('/api/admin/storage/update', 'POST', { id: parsedId, ...storageBody(input) }, signal); return { id: String(parsedId), name: input.mountPath, driver: input.driver, enabled: true } }
  /** Reauthentication patches only credential fields onto the full host-side row. */
  async updateMountPatch(id: string, additionPatch: Record<string, unknown>, signal?: AbortSignal): Promise<OpenListMount> {
    const parsedId = positiveStorageId(id)
    const row = await this.storageRow(parsedId, signal)
    const currentAddition = parseStorageAddition(row.addition)
    const input: OpenListMountInput = {
      mountPath: typeof row.mount_path === 'string' ? row.mount_path : typeof row.name === 'string' ? row.name : '',
      driver: typeof row.driver === 'string' ? row.driver : '',
      addition: { ...currentAddition, ...additionPatch },
      ...(finiteNumber(row.order) === undefined ? {} : { order: finiteNumber(row.order) }),
      ...(typeof row.remark === 'string' ? { remark: row.remark } : {}),
    }
    if (input.mountPath === '' || input.driver === '') throw new ReferenceAnythingError('OpenList storage is malformed', 'REFERENCE_READ_FAILED')
    // The full row never crosses the Remote boundary. Preserve all upstream
    // v4 fields (including future fields) and replace only the safe patch.
    await this.request('/api/admin/storage/update', 'POST', { ...row, id: parsedId, ...storageBody(input, row) }, signal)
    return this.mountRow(row)
  }
  async removeMount(id: string, signal?: AbortSignal): Promise<void> { await this.request(`/api/admin/storage/delete?id=${encodeURIComponent(id)}`, 'POST', undefined, signal) }
  async disableMount(id: string, disabled = true, signal?: AbortSignal): Promise<void> { positiveStorageId(id); await this.request(`/api/admin/storage/${disabled ? 'disable' : 'enable'}?id=${encodeURIComponent(id)}`, 'POST', undefined, signal) }
  async configureManagedIndex(signal?: AbortSignal): Promise<void> {
    const data = await this.request('/api/admin/setting/get?keys=search_index,auto_update_index', 'GET', undefined, signal)
    const items = (Array.isArray(data) ? data : Array.isArray(object(data).content) ? object(data).content as unknown[] : []).map(object)
    const desired = new Map([['search_index', 'database'], ['auto_update_index', 'true']])
    const saved: Record<string, unknown>[] = items.filter(item => typeof item.key === 'string' && desired.has(item.key)).map(item => ({ ...item, value: desired.get(String(item.key))! }))
    for (const [key, value] of desired) if (!saved.some(item => item.key === key)) saved.push({ key, value })
    await this.request('/api/admin/setting/save', 'POST', saved, signal)
  }
  async updateIndex(mountPath: string, signal?: AbortSignal): Promise<void> {
    const result = object(await this.request('/api/admin/index/update', 'POST', { paths: [mountPath], max_depth: 20 }, signal))
    if (result.__index_running === true) return
  }
  async reindexMount(_id?: string, signal?: AbortSignal): Promise<{ supported: true }> {
    const result = object(await this.request('/api/admin/index/build', 'POST', undefined, signal))
    if (result.__index_running === true) return { supported: true }
    return { supported: true }
  }
  async indexProgress(signal?: AbortSignal): Promise<Pick<OpenListMount, 'indexStatus' | 'indexProgress' | 'indexCount'> | undefined> {
    const row = object(await this.request('/api/admin/index/progress', 'GET', undefined, signal))
    const count = finiteNumber(row.obj_count); const done = typeof row.is_done === 'boolean' ? row.is_done : undefined
    const failed = typeof row.error === 'string' && row.error.trim() !== ''
    if (count === undefined && done === undefined && !failed) return undefined
    return { indexStatus: failed ? 'failed' : done === true ? 'complete' : 'running', indexProgress: done === true ? 1 : 0, ...(count === undefined ? {} : { indexCount: count }) }
  }
  private async request(path: string, method: 'GET' | 'POST', body: unknown, signal?: AbortSignal, retried = false): Promise<unknown> {
    if (this.credentials.token === undefined) throw new ReferenceAnythingError('OpenList token is missing', 'SOURCE_UNAVAILABLE')
    try {
      const response = await this.fetchImpl(`${validateOpenListEndpoint(this.credentials.endpoint)}${path}`, { method, signal, headers: { Authorization: this.credentials.token, ...method === 'POST' ? { 'Content-Type': 'application/json' } : {} }, ...body === undefined ? {} : { body: JSON.stringify(body) } })
      if (response.status === 401 && !retried && this.refreshToken !== undefined) { this.credentials = await this.refreshToken(signal); return this.request(path, method, body, signal, true) }
      const payload: unknown = await response.json().catch(() => ({}))
      const row = object(payload)
      if (row.code === 401 && !retried && this.refreshToken !== undefined) { this.credentials = await this.refreshToken(signal); return this.request(path, method, body, signal, true) }
      const indexRunning = path.startsWith('/api/admin/index/') && (response.status === 400 || row.code === 400) && typeof row.message === 'string' && /(running|building|indexing|in progress)/i.test(row.message)
      if (indexRunning) return { __index_running: true }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (typeof row.code === 'number' && row.code !== 200) throw new Error('API rejected request')
      return row.data ?? payload
    } catch (error) { if (isAbortError(error, signal)) throw abortError(signal); throw new ReferenceAnythingError(`OpenList ${path.split('?')[0]} failed`, 'REFERENCE_READ_FAILED') }
  }
  private mountRows(data: unknown): OpenListMount[] { const content: unknown[] = Array.isArray(data) ? data : Array.isArray(object(data).content) ? object(data).content as unknown[] : []; return content.map((row: unknown) => this.mountRow(row)) }
  private async storageRow(id: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const data = await this.request('/api/admin/storage/list', 'GET', undefined, signal)
    const rows: unknown[] = Array.isArray(data) ? data : Array.isArray(object(data).content) ? object(data).content as unknown[] : []
    const row = rows.map(object).find(value => String(value.id) === String(id))
    if (row === undefined) throw new ReferenceAnythingError('OpenList storage was not found', 'REFERENCE_NOT_FOUND')
    return row
  }
  private mountRow(value: unknown): OpenListMount {
    const row = object(value); const details = object(row.mount_details); const disabled = row.disabled === true
    const capacityUsed = finiteNumber(row.used) ?? finiteNumber(row.capacity_used) ?? finiteNumber(details.used_space)
    const capacityTotal = finiteNumber(row.total) ?? finiteNumber(row.capacity_total) ?? finiteNumber(details.total_space)
    const progress = finiteNumber(row.index_progress)
    const indexStatus = indexState(row.index_status)
    const status = typeof row.status === 'string' ? row.status : ''
    return { id: typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '', name: typeof row.mount_path === 'string' ? row.mount_path : typeof row.name === 'string' ? row.name : '', driver: typeof row.driver === 'string' ? row.driver : '', enabled: !disabled, ...(disabled ? { status: 'disabled' as const } : status === 'work' ? { status: 'ready' as const } : { status: 'error' as const, error: 'OpenList storage needs attention' }), ...(capacityUsed === undefined ? {} : { capacityUsed }), ...(capacityTotal === undefined ? {} : { capacityTotal }), ...(indexStatus === undefined ? {} : { indexStatus }), ...(progress === undefined ? {} : { indexProgress: Math.min(1, Math.max(0, progress > 1 ? progress / 100 : progress)) }) }
  }
}

/** Owns only a process it launched; it never kills a user-managed OpenList. */
export class ManagedOpenListRuntime {
  private child: ChildProcess | undefined
  constructor(private readonly seams: OpenListSeams = {}) {}
  get running(): boolean { return this.child !== undefined && this.child.exitCode === null }
  async start(binary: string, dataDirectory: string, port?: number, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (this.running) throw new ReferenceAnythingError('Managed OpenList is already running', 'REFERENCE_SYNC_IN_PROGRESS')
    const selectedPort = port ?? await chooseOpenListPort()
    const endpoint = validateOpenListEndpoint(`http://127.0.0.1:${selectedPort}`, true)
    await writeManagedOpenListConfig(dataDirectory, selectedPort, this.seams, signal)
    signal?.throwIfAborted()
    let spawned: ChildProcess
    try { spawned = (this.seams.spawn ?? nodeSpawn)(binary, ['server', '--data', dataDirectory], { stdio: 'ignore', windowsHide: true }) } catch { throw new ReferenceAnythingError('Managed OpenList could not be started', 'REFERENCE_READ_FAILED') }
    this.child = spawned
    spawned.once('exit', () => { if (this.child === spawned) this.child = undefined })
    try {
      await Promise.race([waitForOpenListReady(endpoint, spawned, this.seams.fetch ?? fetch, this.seams), childFailure(spawned), waitForAbort(signal)])
      signal?.throwIfAborted()
    } catch (error) {
      if (this.child === spawned) await this.stop().catch(() => undefined)
      if (isAbortError(error, signal)) throw abortError(signal)
      throw new ReferenceAnythingError('Managed OpenList did not become ready', 'REFERENCE_READ_FAILED')
    }
    return endpoint
  }
  /** Generate an administrator password without exposing it in argv. */
  async setAdminPassword(binary: string, dataDirectory: string, _password?: string, signal?: AbortSignal, mutationState?: (state: OpenListAdminMutationState) => void): Promise<string> {
    // Cancellation is safe only before spawning. `admin random` mutates the
    // database, so after spawn we must learn and return the committed password.
    signal?.throwIfAborted()
    const mutation = acquireAdminMutation(dataDirectory)
    let child: ChildProcess
    try { child = (this.seams.spawn ?? nodeSpawn)(binary, ['admin', 'random', '--data', dataDirectory], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
    catch { releaseAdminMutation(mutation.key, mutation.owner); throw new ReferenceAnythingError('Could not generate OpenList admin password', 'REFERENCE_READ_FAILED') }
    // From successful spawn until a password is parsed, the database mutation
    // may have committed even when the process later fails or times out.
    mutationState?.('unknown')
    // Only `close` proves that all process resources are gone. In particular,
    // neither kill() returning true nor an `error` event releases the lock.
    child.once('close', () => releaseAdminMutation(mutation.key, mutation.owner))
    const output = collectChildOutput(child)
    try { await waitForChildClose(child) }
    catch {
      try { child.kill() } catch {}
      try { await waitForChildClose(child, 500) }
      catch {
        try { child.kill('SIGKILL') } catch {}
        try { await waitForChildClose(child, 500) } catch {}
      }
      throw new ReferenceAnythingError('Could not generate OpenList admin password', 'REFERENCE_READ_FAILED')
    }
    const password = parseRandomAdminPassword(await output)
    if (password === undefined) throw new ReferenceAnythingError('Could not parse generated OpenList admin password', 'REFERENCE_READ_FAILED')
    mutationState?.('committed')
    return password
  }
  async stop(): Promise<void> {
    const child = this.child; if (child === undefined) return
    if (child.exitCode === null) child.kill()
    try {
      await waitForProcessTermination(child, 500)
    } catch {
      if (child.exitCode === null) child.kill('SIGKILL')
      try { await waitForProcessTermination(child, 500) } catch {
        throw new ReferenceAnythingError('Managed OpenList did not exit', 'REFERENCE_READ_FAILED')
      }
    }
    if (this.child === child) this.child = undefined
  }
}

/** v4.2.2 reads `scheme.address` and `scheme.http_port` from data/config.json. */
export async function writeManagedOpenListConfig(dataDirectory: string, port: number, seams: OpenListSeams = {}, signal?: AbortSignal): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ReferenceAnythingError('OpenList port is invalid', 'REFERENCE_INVALID_CONFIG')
  await (seams.mkdir ?? mkdir)(dataDirectory, { recursive: true, mode: 0o700 })
  const configPath = join(dataDirectory, 'config.json')
  const existing = await readJsonObject(configPath, seams)
  const existingScheme = object(existing.scheme)
  const config = { ...existing, jwt_secret: typeof existing.jwt_secret === 'string' && existing.jwt_secret !== '' ? existing.jwt_secret : randomBytes(24).toString('hex'), token_expires_in: typeof existing.token_expires_in === 'number' ? existing.token_expires_in : 48, database: Object.keys(object(existing.database)).length === 0 ? { type: 'sqlite3', db_file: join(dataDirectory, 'data.db'), table_prefix: 'x_' } : existing.database, scheme: { ...existingScheme, address: '127.0.0.1', http_port: port, https_port: -1, force_https: false }, temp_dir: typeof existing.temp_dir === 'string' ? existing.temp_dir : join(dataDirectory, 'temp'), bleve_dir: typeof existing.bleve_dir === 'string' ? existing.bleve_dir : join(dataDirectory, 'bleve') }
  await securePath(dataDirectory, true, seams.chmod ?? chmod, seams)
  const temporary = join(dataDirectory, `.config-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  await (seams.writeFile ?? writeFile)(temporary, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 })
  await securePath(temporary, false, seams.chmod ?? chmod, seams)
  signal?.throwIfAborted()
  try { await (seams.rename ?? rename)(temporary, configPath) } catch { throw new ReferenceAnythingError('Could not replace OpenList config', 'REFERENCE_READ_FAILED') }
}

function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
async function fsyncPath(path: string): Promise<void> { const handle = await import('node:fs/promises').then(module => module.open(path, 'r+')); try { await handle.sync() } finally { await handle.close() } }
function isMissing(cause: unknown): boolean { return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT' }
function collectChildOutput(child: ChildProcess): Promise<string> { return new Promise(resolve => { let value = ''; const append = (chunk: unknown) => { if (value.length >= 16_384) return; value += String(chunk).slice(0, 16_384 - value.length) }; child.stdout?.on('data', append); child.stderr?.on('data', append); child.once('close', () => resolve(value)) }) }
export function parseRandomAdminPassword(output: string): string | undefined { const matches = output.split(/\r?\n/).flatMap(line => { const match = line.match(/^password:\s*(\S+)\s*$/); return match?.[1] && match[1].length >= 8 ? [match[1]] : [] }); return matches.at(-1) }
function finiteNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined }
function typedDriverDefault(type: OpenListDriverField['type'], value: unknown): string | number | boolean | undefined {
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true'
    return undefined
  }
  if (type === 'number') {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return typeof value === 'string' ? value : undefined
}
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : value !== null && typeof value === 'object' ? Object.entries(value as Record<string, unknown>).map(([name, field]) => ({ name, ...object(field) })) : [] }
function parseDriverOptions(value: unknown): { label: string, value: string }[] {
  const raw = typeof value === 'string' ? value.split(',') : asArray(value)
  return raw.flatMap((option): { label: string, value: string }[] => typeof option === 'string' ? option.trim() === '' ? [] : [{ label: option.trim(), value: option.trim() }] : typeof object(option).value === 'string' ? [{ label: typeof object(option).label === 'string' ? object(option).label as string : object(option).value as string, value: object(option).value as string }] : [])
}
export function isSensitiveDriverField(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return /(pwd|pass|token|secret|cookie|auth|credential|private|key|salt|sign|captcha|code)/.test(normalized)
}
function indexState(value: unknown): OpenListMount['indexStatus'] | undefined { return value === 'idle' || value === 'running' || value === 'complete' || value === 'failed' ? value : undefined }
function storageBody(input: OpenListMountInput, existing: Record<string, unknown> = {}, managedDefault = false): Record<string, unknown> {
  if (!input.mountPath.startsWith('/') || input.mountPath.includes('..')) throw new ReferenceAnythingError('OpenList mount path must be absolute', 'REFERENCE_INVALID_CONFIG')
  return { mount_path: input.mountPath, driver: input.driver, addition: JSON.stringify(input.addition), order: input.order ?? finiteNumber(existing.order) ?? 0, remark: input.remark ?? (typeof existing.remark === 'string' ? existing.remark : ''), cache_expiration: finiteNumber(existing.cache_expiration) ?? 30, ...(Object.hasOwn(existing, 'web_proxy') ? { web_proxy: existing.web_proxy === true } : managedDefault ? { web_proxy: true } : {}), webdav_policy: typeof existing.webdav_policy === 'string' ? existing.webdav_policy : 'native_proxy', down_proxy_url: typeof existing.down_proxy_url === 'string' ? existing.down_proxy_url : '', extract_folder: typeof existing.extract_folder === 'string' ? existing.extract_folder : 'front', enable_sign: existing.enable_sign === true, order_by: typeof existing.order_by === 'string' ? existing.order_by : 'name', order_direction: typeof existing.order_direction === 'string' ? existing.order_direction : 'asc' }
}

const API_PAGES_QUICK_DRIVERS = new Set(['onedrive', 'onedriveapp', 'aliyundrive', 'aliyundriveopen', 'aliyunpan', 'baidu', 'baidunetdisk', 'baiduphoto', 'quark', 'quarktv', '115', '115cloud', '123pan', '123panopen', '123panlink', 'dropbox', 'googledrive', 'googlephoto', 'googlephotos', 'yandex', 'yandexdisk'])
export function isApiPagesQuickDriver(name: string): boolean { return API_PAGES_QUICK_DRIVERS.has(name.toLowerCase().replace(/[^a-z0-9]/g, '')) }
function parseStorageAddition(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try { return object(JSON.parse(value)) } catch { return {} }
}
function tarEntry(bytes: Uint8Array, binary: string): Uint8Array | undefined {
  let offset = 0
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) return undefined
    const name = ascii(header.subarray(0, 100)); const size = Number.parseInt(ascii(header.subarray(124, 136)).trim(), 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new ReferenceAnythingError('OpenList archive is malformed', 'REFERENCE_READ_FAILED')
    const data = offset + 512; const end = data + size
    if (end > bytes.byteLength) throw new ReferenceAnythingError('OpenList archive is truncated', 'REFERENCE_READ_FAILED')
    if (name.split('/').at(-1) === binary && !name.includes('..')) return bytes.slice(data, end)
    offset = data + Math.ceil(size / 512) * 512
  }
  return undefined
}
function zipEntry(bytes: Uint8Array, binary: string): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true); const method = view.getUint16(offset + 8, true); const compressed = view.getUint32(offset + 18, true); const plain = view.getUint32(offset + 22, true); const nameLength = view.getUint16(offset + 26, true); const extraLength = view.getUint16(offset + 28, true)
    if ((flags & 8) !== 0) throw new ReferenceAnythingError('OpenList zip uses unsupported data descriptors', 'REFERENCE_READ_FAILED')
    const start = offset + 30 + nameLength + extraLength; const end = start + compressed
    if (end > bytes.byteLength) throw new ReferenceAnythingError('OpenList archive is truncated', 'REFERENCE_READ_FAILED')
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)); const data = bytes.subarray(start, end)
    if (name.split('/').at(-1) === binary && !name.includes('..')) return method === 0 ? data.slice() : method === 8 ? new Uint8Array(inflateRawSync(data)) : (() => { throw new ReferenceAnythingError('OpenList zip compression is unsupported', 'REFERENCE_READ_FAILED') })()
    if (plain < 0) throw new ReferenceAnythingError('OpenList archive is malformed', 'REFERENCE_READ_FAILED')
    offset = end
  }
  return undefined
}
function ascii(bytes: Uint8Array): string { return new TextDecoder().decode(bytes).replace(/\0.*$/, '') }
function positiveStorageId(value: string): number { if (!/^\d+$/.test(value)) throw new ReferenceAnythingError('OpenList storage id is invalid', 'REFERENCE_INVALID_CONFIG'); const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw new ReferenceAnythingError('OpenList storage id is invalid', 'REFERENCE_INVALID_CONFIG'); return id }
async function readJsonObject(path: string, seams: OpenListSeams): Promise<Record<string, unknown>> {
  let text: string
  try { text = await (seams.readFile ?? readFile)(path, 'utf8') } catch (cause) {
    if (typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT') return {}
    throw new ReferenceAnythingError('Could not read existing OpenList config', 'REFERENCE_READ_FAILED')
  }
  try { const value: unknown = JSON.parse(text); if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object'); return value as Record<string, unknown> } catch { throw new ReferenceAnythingError('Existing OpenList config is malformed', 'REFERENCE_INVALID_CONFIG') }
}
async function waitForOpenListReady(endpoint: string, child: ChildProcess, fetchImpl: typeof fetch, seams: OpenListSeams): Promise<void> {
  // A first OpenList start initializes every bundled offline-download driver.
  // Some of those drivers probe unavailable localhost services and can make a
  // perfectly healthy start take close to a minute on Windows. Keep the
  // individual probes short, but allow enough total time for that one-time
  // initialization to finish.
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new Error('child exited')
    try {
      const ping = await fetchImpl(`${endpoint}/ping`, { method: 'GET', signal: AbortSignal.timeout(500) })
      if (ping.ok && (await ping.text()) === 'pong' && child.exitCode === null) return
    } catch {}
    // A refused connection returns immediately, so the delay (rather than the
    // 500 ms request timeout) defines the real wall-clock startup window.
    await (seams.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(500)
  }
  throw new Error('timeout')
}
function childFailure(child: ChildProcess): Promise<never> { return new Promise((_, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error(`exit ${code ?? 'unknown'}`))) }) }
function waitForAbort(signal?: AbortSignal): Promise<never> {
  if (signal === undefined) return new Promise<never>(() => undefined)
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError(signal)), { once: true }))
}
function waitForChildClose(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timeout); child.removeListener('error', onError); child.removeListener('close', onClose); callback() }
    const timeout = setTimeout(() => finish(() => reject(new Error('admin password command timed out'))), timeoutMs)
    const onError = () => finish(() => reject(new Error('spawn error')))
    const onClose = (code: number | null) => finish(() => code === 0 ? resolve() : reject(new Error(`exit ${code ?? 'unknown'}`)))
    child.once('error', onError)
    child.once('close', onClose)
  })
}
function waitForProcessTermination(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('process exit timed out')) }, timeoutMs)
    const cleanup = () => { clearTimeout(timeout); child.removeListener('exit', onExit); child.removeListener('error', onError) }
    const onExit = () => { cleanup(); resolve() }
    const onError = () => { cleanup(); reject(new Error('process exit failed')) }
    child.once('exit', onExit); child.once('error', onError)
    // Avoid missing a synchronous exit between the first check and listeners.
    if (child.exitCode !== null) onExit()
  })
}
function abortError(signal?: AbortSignal): Error { return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError') }
function isAbortError(error: unknown, signal?: AbortSignal): boolean { return signal?.aborted === true || error instanceof DOMException && error.name === 'AbortError' || error instanceof Error && error.name === 'AbortError' }
async function securePath(path: string, directory: boolean, chmodImpl: typeof chmod, seams: OpenListSeams, windows = platform() === 'win32'): Promise<void> {
  if (windows) {
    if (seams.securePermissions === undefined) throw new ReferenceAnythingError('OpenList credential storage requires a Windows ACL seam', 'REFERENCE_READ_FAILED')
    await seams.securePermissions(path, directory).catch(() => { throw new ReferenceAnythingError('Could not secure OpenList credentials', 'REFERENCE_READ_FAILED') })
    return
  }
  await chmodImpl(path, directory ? 0o700 : 0o600).catch(() => { throw new ReferenceAnythingError('Could not secure OpenList credentials', 'REFERENCE_READ_FAILED') })
}

async function secureExecutable(path: string, chmodImpl: typeof chmod, seams: OpenListSeams, windows: boolean): Promise<void> {
  if (windows) {
    if (seams.securePermissions === undefined) throw new ReferenceAnythingError('OpenList executable requires a Windows ACL seam', 'REFERENCE_READ_FAILED')
    await seams.securePermissions(path, false).catch(() => { throw new ReferenceAnythingError('Could not secure OpenList executable', 'REFERENCE_READ_FAILED') })
    return
  }
  await chmodImpl(path, 0o700).catch(() => { throw new ReferenceAnythingError('Could not secure OpenList executable', 'REFERENCE_READ_FAILED') })
}

/** Recover the only crash window in Windows' two-rename executable replacement. */
export async function recoverInterruptedReplacement(target: string, backup: string, marker: string, seams: OpenListSeams = {}, windows = process.platform === 'win32', owner?: symbol): Promise<void> {
  if (!windows) return
  const activeOwner = activeExecutableReplacements.get(target)
  if (activeOwner !== undefined && activeOwner !== owner) return
  const read = seams.readFile ?? readFile; const move = seams.rename ?? rename; const remove = seams.unlink ?? unlink
  try { await read(marker, 'utf8') } catch (cause) {
    if (isMissing(cause)) {
      // A backup without a pending marker belongs to a replacement whose
      // commit point completed but whose best-effort cleanup was interrupted.
      try { await remove(backup) } catch (cleanupCause) {
        if (!isMissing(cleanupCause)) throw new ReferenceAnythingError('Could not clean up a committed OpenList executable replacement', 'REFERENCE_READ_FAILED')
      }
      return
    }
    throw new ReferenceAnythingError('Could not inspect OpenList replacement recovery state', 'REFERENCE_READ_FAILED')
  }
  try {
    try { await read(target) } catch (cause) {
      if (!isMissing(cause)) throw cause
      try { await move(backup, target) } catch (restoreCause) {
        // A fresh install can crash after writing the marker but before any
        // previous target existed. There is nothing to restore in that case.
        if (!isMissing(restoreCause)) throw restoreCause
      }
    }
    await remove(marker)
    await remove(backup).catch(cause => { if (!isMissing(cause)) throw cause })
  } catch { throw new ReferenceAnythingError('Could not recover interrupted OpenList executable replacement', 'REFERENCE_READ_FAILED') }
}
