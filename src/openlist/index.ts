/**
 * Host-only OpenList lifecycle and administration service.
 *
 * This is deliberately the one place that can see a credential.  Its public
 * Remote-facing methods return the small safe DTOs below; `credentials()` is
 * for the local cloud-drive transport only and is never registered remotely.
 */
import { access, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import { ReferenceAnythingError } from '../errors.ts'
import {
  authenticateOpenList, installOpenList, ManagedOpenListRuntime, OpenListHostClient,
  OPENLIST_CREDENTIAL_DIRECTORY, OPENLIST_FIXED_VERSION, OPENLIST_RELEASE,
  readOpenListCredentials, recoverInterruptedReplacement, selectOpenListAsset, validateOpenListEndpoint,
  writeOpenListCredentials, type OpenListCredentials, type OpenListDriver,
  type OpenListMount, type OpenListMountInput, type OpenListSeams, type OpenListAdminMutationState,
} from './host.ts'

export const name = 'reference-openlist'
export const inject: readonly string[] = []

export interface OpenListStatus {
  readonly state: 'install' | 'downloading' | 'running' | 'failed' | 'upgrade'
  readonly installed: boolean
  readonly mode?: 'managed' | 'external'
  readonly version?: string
  /** URL.origin only (or loopback origin), never a credential-bearing URL. */
  readonly endpoint?: string
  readonly supportsRollback: boolean
  readonly upgradeAvailable: boolean
  readonly newerVersion?: boolean
  readonly error?: string
}

export interface OpenListExternalConnectInput { readonly endpoint: string, readonly username?: string, readonly password?: string, readonly token?: string }
type IcaclsRunner = (file: string, arguments_: readonly string[], options: { readonly windowsHide: boolean }) => Promise<unknown>
const execFile: IcaclsRunner = async (file, arguments_, options) => await promisify(execFileCallback)(file, [...arguments_], options)

/** Restrict a Windows credential/config path without passing it through a shell. */
export async function secureOpenListPermissions(path: string, directory: boolean, run: IcaclsRunner = execFile, windows = process.platform === 'win32', account = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : userInfo().username): Promise<void> {
  if (!windows) return
  const rights = directory ? '(OI)(CI)F' : 'F'
  // Each invocation is execFile, so `path` stays a literal argument rather
  // than a shell fragment. Reset removes any pre-existing explicit grants.
  await run('icacls', [path, '/reset'], { windowsHide: true })
  await run('icacls', [path, '/inheritance:r'], { windowsHide: true })
  await run('icacls', [path, '/grant:r', `${account}:${rights}`], { windowsHide: true })
}

export function productionOpenListSeams(): OpenListSeams { return { securePermissions: secureOpenListPermissions } }

declare module '@deepseek-ai/cordis' {
  interface Context { openListManager: OpenListService }
}

export class OpenListService extends Service {
  static inject = inject
  private readonly seams: OpenListSeams
  private readonly runtime: ManagedOpenListRuntime
  private credentialsValue: OpenListCredentials | undefined
  private credentialsGeneration = 0
  private lifecycle: OpenListStatus['state'] = 'install'
  private failure: string | undefined
  private operation: Promise<void> | undefined
  private tokenRefresh: Promise<OpenListCredentials> | undefined
  private driversHealthy = true
  private mountsHealthy = true

  constructor(ctx: Context, seams: OpenListSeams = productionOpenListSeams()) { super(ctx, 'openListManager'); this.seams = seams; this.runtime = new ManagedOpenListRuntime(seams) }

  protected async [Service.init](): Promise<void> {
    this.credentialsValue = await readOpenListCredentials(undefined, this.seams)
    // A managed instance is a local convenience, not a process ownership
    // claim over an arbitrary externally started server.  Only this runtime's
    // child is stopped by the disposer below.
    if (this.credentialsValue?.mode === 'managed') {
      const version = this.credentialsValue.version
      if (version === undefined || !await this.binaryExists(version)) { this.lifecycle = 'failed'; this.failure = 'Managed OpenList version is unavailable' }
      else try { await this.startManaged(this.binaryPath(version), version) } catch { this.lifecycle = 'failed'; this.failure = 'Managed OpenList could not be started' }
    }
    this.ctx.effect(() => async () => { await this.runtime.stop() }, 'reference-openlist.stop-owned-process')
  }

  async status(signal?: AbortSignal): Promise<OpenListStatus> {
    signal?.throwIfAborted()
    const versions = await this.installedVersions()
    signal?.throwIfAborted()
    const installed = versions.length > 0
    let externalHealthy = false
    if (this.credentialsValue?.mode === 'external') {
      try { await new OpenListHostClient(this.credentialsValue, this.seams).connect(signal); externalHealthy = true; if (this.failure === 'External OpenList connection failed') this.failure = undefined }
      catch { this.failure = 'External OpenList connection failed' }
    }
    const running = this.runtime.running || externalHealthy
    const managedVersion = this.credentialsValue?.mode === 'managed' ? this.credentialsValue.version : undefined
    const comparison = managedVersion === undefined ? 0 : compareVersions(managedVersion, OPENLIST_FIXED_VERSION)
    const upgradeAvailable = managedVersion !== undefined && comparison < 0
    const newerVersion = managedVersion !== undefined && comparison > 0
    const compatibilityError = newerVersion ? 'Managed OpenList version is newer than the supported version' : undefined
    const state = this.failure !== undefined || newerVersion ? 'failed' : this.operation !== undefined ? this.lifecycle : upgradeAvailable ? 'upgrade' : running ? 'running' : 'install'
    return {
      state, installed, ...(this.credentialsValue?.mode === undefined ? {} : { mode: this.credentialsValue.mode }),
      ...(this.credentialsValue?.mode === 'managed' && this.credentialsValue.version !== undefined ? { version: this.credentialsValue.version } : {}),
      ...(this.credentialsValue === undefined ? {} : { endpoint: endpointOrigin(this.credentialsValue.endpoint) }),
      supportsRollback: this.credentialsValue?.mode === 'managed' && versions.some(version => compareVersions(version, this.credentialsValue?.version ?? OPENLIST_FIXED_VERSION) < 0), upgradeAvailable, newerVersion, ...((this.failure ?? compatibilityError) === undefined ? {} : { error: this.failure ?? compatibilityError }),
    }
  }

  async install(signal?: AbortSignal): Promise<OpenListStatus> {
    if (this.credentialsValue?.mode === 'external') throw new ReferenceAnythingError('Disconnect external OpenList before managed installation', 'REFERENCE_INVALID_CONFIG')
    await this.exclusive('downloading', async () => {
      signal?.throwIfAborted()
      const previous = this.credentialsValue; const wasRunning = this.runtime.running
      if (wasRunning && previous?.mode === 'managed') await this.runtime.stop()
      try {
        // Prove the credential commit path before `admin random` mutates the database.
        if (previous?.mode === 'managed') await writeOpenListCredentials(previous, undefined, this.seams, signal)
        const installed = await (this.seams.install ?? installOpenList)(OPENLIST_CREDENTIAL_DIRECTORY, undefined, this.seams, undefined, undefined, signal, true)
        let replacementCommitted = false
        const adminMutation: { state: OpenListAdminMutationState } = { state: 'not-started' }
        try {
          // The transaction handle owns the backup, marker, and process-local
          // replacement lock. Every possible cancellation point belongs inside
          // this protected region so ownership cannot leak.
          signal?.throwIfAborted()
          const adminPassword = await this.runtime.setAdminPassword(installed.path, this.dataDirectory(), undefined, signal, state => { adminMutation.state = state })
          // A returned parsed password is authoritative even for a test seam or
          // older runtime implementation that does not invoke the callback.
          adminMutation.state = 'committed'
          // From this commit onward the old password is invalid. Persist the new
          // password before any restart/auth attempt, retaining only a stale JWT.
          const provisional = { endpoint: previous?.endpoint ?? 'http://127.0.0.1:1', token: previous?.token ?? 'pending', password: adminPassword, mode: 'managed' as const, version: installed.version }
          this.setCredentials(provisional)
          await writeOpenListCredentials(provisional, undefined, this.seams)
          // `:1`/`pending` is only a fail-closed credential placeholder for a
          // fresh install. It must never become the managed server's preferred
          // port when retrying an interrupted first start.
          const preferredPort = provisional.token === 'pending' ? undefined : managedLoopbackPort(provisional.endpoint)
          let endpoint: string
          try { endpoint = await this.runtime.start(installed.path, this.dataDirectory(), preferredPort, signal) }
          catch (error) {
            if (preferredPort === undefined || isAbortError(error, signal)) throw error
            endpoint = await this.runtime.start(installed.path, this.dataDirectory(), undefined, signal)
          }
          const token = await authenticateOpenList(endpoint, 'admin', adminPassword, this.seams.fetch ?? fetch, signal)
          const credentials = { endpoint, token, password: adminPassword, mode: 'managed' as const, version: installed.version }
          await writeOpenListCredentials(credentials, undefined, this.seams)
          this.setCredentials(credentials)
          await this.client().configureManagedIndex(signal)
          await installed.finish(true)
          replacementCommitted = true
        } catch (error) {
          let failure = error
          if (adminMutation.state === 'unknown') {
            // The child may have committed a new database password before a
            // timeout, crash, or unparsable output. Never put the possibly
            // stale prior password back into service. Persist a deliberately
            // unusable record so a subsequent process also fails closed.
            const unknown = { endpoint: previous?.endpoint ?? 'http://127.0.0.1:1', token: 'unknown-after-admin-random', mode: 'managed' as const, version: previous?.version ?? installed.version }
            this.setCredentials(unknown)
            try { await writeOpenListCredentials(unknown, undefined, this.seams) }
            catch (persistError) {
              // Removing this one exact Host credential file is safer than
              // leaving a known-stale password available after an unknown commit.
              await (this.seams.unlink ?? unlink)(join(OPENLIST_CREDENTIAL_DIRECTORY, 'credentials.json')).catch(() => undefined)
              failure = persistError
            }
          }
          throw failure
        } finally {
          if (!replacementCommitted) await installed.finish(false)
        }
      } catch (error) {
        let stopped = true
        try { await this.runtime.stop() } catch { stopped = false }
        let recovery = this.credentialsValue?.mode === 'managed' ? this.credentialsValue : previous?.mode === 'managed' ? previous : undefined
        // `admin random` changes the shared database, independently of which
        // binary version starts it. If an upgrade/repair later fails, restart
        // the previous executable with the NEW password and persist that
        // version/password pair; the stale password must never return.
        if (recovery?.mode === 'managed' && previous?.mode === 'managed' && recovery.password !== previous.password && previous.version !== undefined) {
          recovery = repairRecoveryCredentials(previous, recovery)
          this.setCredentials(recovery)
          await writeOpenListCredentials(recovery, undefined, this.seams)
        }
        if (recovery !== undefined) {
          this.setCredentials(recovery)
          if (wasRunning && stopped && recovery.version !== undefined) await this.startManaged(this.binaryPath(recovery.version), recovery.version, undefined).catch(() => { this.setCredentials(recovery) })
        }
        throw error
      }
    }, signal)
    return this.status()
  }

  async upgrade(input: { rollback?: boolean } = {}, signal?: AbortSignal): Promise<OpenListStatus> {
    if (input.rollback !== true) return this.install(signal) // fixed manifest: explicit repair
    await this.exclusive('upgrade', async () => {
      const current = this.credentialsValue?.version ?? OPENLIST_FIXED_VERSION
      const target = (await this.installedVersions()).filter(version => compareVersions(version, current) < 0).sort(compareVersions).at(-1)
      if (target === undefined || this.credentialsValue?.mode !== 'managed') throw new ReferenceAnythingError('OpenList rollback is not available', 'REFERENCE_INVALID_CONFIG')
      const previous = this.credentialsValue
      await this.runtime.stop()
      try { await this.startManaged(this.binaryPath(target), target, signal) } catch (error) {
        if (previous?.mode === 'managed') { this.setCredentials(previous); await this.startManaged(this.binaryPath(previous.version), previous.version, undefined).catch(() => undefined) }
        throw error
      }
    }, signal)
    return this.status()
  }

  async connectExternal(input: OpenListExternalConnectInput, signal?: AbortSignal): Promise<OpenListStatus> {
    await this.exclusive('downloading', async () => {
      signal?.throwIfAborted(); const endpoint = validateOpenListEndpoint(input.endpoint)
      const token = typeof input.token === 'string' && input.token !== ''
        ? input.token
        : await authenticateOpenList(endpoint, input.username ?? '', input.password ?? '', this.seams.fetch ?? fetch, signal)
      const credentials: OpenListCredentials = { endpoint, token, mode: 'external' }
      await new OpenListHostClient(credentials, this.seams).connect(signal)
      await this.runtime.stop()
      try {
        await writeOpenListCredentials(credentials, undefined, this.seams, signal)
        this.setCredentials(credentials)
      } catch (error) { this.setCredentials(undefined); throw error }
    }, signal)
    return this.status()
  }

  async disconnect(signal?: AbortSignal): Promise<OpenListStatus> {
    signal?.throwIfAborted()
    // Retain the restricted credential file for a managed install so it can
    // auto-start next time; disconnecting only stops its active connection.
    const external = this.credentialsValue?.mode === 'external'
    if (this.credentialsValue?.mode === 'managed') {
      // Stopping the owned child commits the disconnect. Once it succeeds,
      // finish clearing in-memory state even if cancellation arrives meanwhile.
      signal?.throwIfAborted()
      await this.runtime.stop()
    }
    if (external) {
      // Deletion is the disconnect commit boundary. Once it succeeds, report
      // the committed state even when its caller subsequently cancels.
      signal?.throwIfAborted()
      try { await (this.seams.unlink ?? unlink)(join(OPENLIST_CREDENTIAL_DIRECTORY, 'credentials.json')) } catch (cause) {
        if (!(typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT')) throw new ReferenceAnythingError('OpenList credentials could not be removed', 'REFERENCE_READ_FAILED')
      }
    }
    this.setCredentials(undefined)
    return this.status()
  }

  async drivers(signal?: AbortSignal): Promise<OpenListDriver[]> { try { const value = await this.client().driverInfo(signal); this.driversHealthy = true; this.updateAdminHealth(); return value } catch (error) { this.driversHealthy = false; this.updateAdminHealth(); throw error } }
  async mounts(signal?: AbortSignal): Promise<OpenListMount[]> { try { const value = await this.client().mounts(signal); this.mountsHealthy = true; this.updateAdminHealth(); return value } catch (error) { this.mountsHealthy = false; this.updateAdminHealth(); throw error } }
  async createMount(input: OpenListMountInput & { id?: string }, signal?: AbortSignal): Promise<OpenListMount> {
    const client = this.client()
    const driver = (await client.driverInfo(signal)).find(value => value.name === input.driver)
    if (driver === undefined) throw new ReferenceAnythingError('OpenList driver is unavailable', 'REFERENCE_INVALID_CONFIG')
    const addition = validateDriverAddition(driver, client.fillSecretDefaults(input.driver, input.addition), input.id !== undefined)
    const result = input.id === undefined ? await client.createMount({ ...input, addition }, signal) : await client.updateMountPatch(input.id, addition, signal)
    this.bumpGeneration()
    if (input.id === undefined && this.credentialsValue?.mode === 'managed') {
      void client.updateIndex(result.name || input.mountPath).catch(() => client.reindexMount(undefined).then(() => undefined).catch(() => undefined))
    }
    return result
  }
  async disableMount(id: string, disabled = true, signal?: AbortSignal): Promise<void> { await this.client().disableMount(id, disabled, signal); this.bumpGeneration() }
  async removeMount(id: string, signal?: AbortSignal): Promise<void> { await this.client().removeMount(id, signal); this.bumpGeneration() }
  async reindexMount(id: string, signal?: AbortSignal): Promise<{ supported: true }> { signal?.throwIfAborted(); return this.client().reindexMount(id, signal) }

  /** Host-local only; used by OpenListDriveProvider and never exposed in a DTO. */
  async credentials(refresh = false): Promise<OpenListCredentials | undefined> {
    if (refresh && this.credentialsValue?.mode === 'managed') return { ...await this.refreshManagedToken() }
    return this.credentialsValue === undefined ? undefined : { ...this.credentialsValue, generation: this.credentialsGeneration }
  }
  /** Monotonic host-local credential revision for cloud-drive cache invalidation. */
  credentialGeneration(): number { return this.credentialsGeneration }

  private client(): OpenListHostClient {
    if (this.credentialsValue === undefined) throw new ReferenceAnythingError('OpenList is not connected', 'SOURCE_UNAVAILABLE')
    return new OpenListHostClient(this.credentialsValue, this.seams, this.credentialsValue.mode === 'managed' ? signal => this.refreshManagedToken(signal) : undefined, this.credentialsValue.mode === 'managed')
  }
  private async refreshManagedToken(signal?: AbortSignal): Promise<OpenListCredentials> {
    if (this.tokenRefresh !== undefined) return this.tokenRefresh
    const current = this.credentialsValue
    if (current?.mode !== 'managed' || current.password === undefined) throw new ReferenceAnythingError('OpenList session cannot be refreshed', 'SOURCE_UNAVAILABLE')
    const operation = (async () => {
      const token = await authenticateOpenList(current.endpoint, 'admin', current.password!, this.seams.fetch ?? fetch, signal)
      const next = { ...current, token }
      await writeOpenListCredentials(next, undefined, this.seams, signal)
      this.setCredentials(next)
      return next
    })()
    this.tokenRefresh = operation
    try { return await operation } finally { if (this.tokenRefresh === operation) this.tokenRefresh = undefined }
  }
  private dataDirectory(): string { return join(OPENLIST_CREDENTIAL_DIRECTORY, 'managed') }
  private binaryPath(version = OPENLIST_FIXED_VERSION): string { return join(OPENLIST_CREDENTIAL_DIRECTORY, 'bin', version, selectOpenListAsset(OPENLIST_RELEASE).binary) }
  private async installed(): Promise<boolean> { const version = this.credentialsValue?.version; return version !== undefined && await this.binaryExists(version) }
  private async installedVersions(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(join(OPENLIST_CREDENTIAL_DIRECTORY, 'bin'), { withFileTypes: true })
    } catch (cause) {
      if (typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT') return []
      throw new ReferenceAnythingError('Could not inspect installed OpenList versions', 'REFERENCE_READ_FAILED')
    }
    const versions = entries.filter(entry => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name)).map(entry => entry.name)
    return (await Promise.all(versions.map(async version => await this.binaryExists(version) ? version : undefined))).filter((version): version is string => version !== undefined)
  }
  private async binaryExists(version: string): Promise<boolean> {
    const target = this.binaryPath(version); const directory = join(OPENLIST_CREDENTIAL_DIRECTORY, 'bin', version); const binary = selectOpenListAsset(OPENLIST_RELEASE).binary
    await recoverInterruptedReplacement(target, join(directory, `.${binary}.replacement-backup`), join(directory, `.${binary}.replacement-pending`), this.seams)
    try { await access(target); return true } catch (cause) {
      if (typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT') return false
      throw new ReferenceAnythingError('Could not inspect the OpenList executable', 'REFERENCE_READ_FAILED')
    }
  }
  private async startManaged(binary = this.binaryPath(), version = OPENLIST_FIXED_VERSION, signal?: AbortSignal): Promise<void> {
    if (!await this.binaryExists(version)) throw new ReferenceAnythingError('Managed OpenList version is unavailable', 'SOURCE_UNAVAILABLE')
    const credentials = this.credentialsValue
    if (credentials?.mode !== 'managed' || credentials.password === undefined) throw new ReferenceAnythingError('Managed OpenList credentials are unavailable', 'SOURCE_UNAVAILABLE')
    const preferredPort = credentials.token === 'pending' ? undefined : managedLoopbackPort(credentials.endpoint)
    let endpoint: string
    try { endpoint = await this.runtime.start(binary, this.dataDirectory(), preferredPort, signal) }
    catch (error) {
      if (preferredPort === undefined || isAbortError(error, signal)) throw error
      endpoint = await this.runtime.start(binary, this.dataDirectory(), undefined, signal)
    }
    try {
      const token = await authenticateOpenList(endpoint, 'admin', credentials.password, this.seams.fetch ?? fetch, signal)
      const next = { endpoint, token, password: credentials.password, mode: 'managed' as const, version }
      await writeOpenListCredentials(next, undefined, this.seams, signal)
      this.setCredentials(next)
      await this.client().configureManagedIndex(signal)
    } catch (error) {
      try { await this.runtime.stop() } finally { this.setCredentials(credentials) }
      throw error
    }
  }
  private setCredentials(credentials: OpenListCredentials | undefined): void { this.credentialsValue = credentials; this.credentialsGeneration += 1 }
  private updateAdminHealth(): void { if (!this.driversHealthy || !this.mountsHealthy) this.failure = 'OpenList connection failed'; else if (this.failure === 'OpenList connection failed') this.failure = undefined }
  private bumpGeneration(): void { this.credentialsGeneration += 1 }
  private async exclusive(state: OpenListStatus['state'], action: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (this.operation !== undefined) throw new ReferenceAnythingError('OpenList operation is already in progress', 'REFERENCE_SYNC_IN_PROGRESS')
    this.failure = undefined; this.lifecycle = state
    const operation = action()
    this.operation = operation
    try { await operation } catch (error) {
      if (isAbortError(error, signal)) throw abortError(signal)
      this.failure = 'OpenList operation failed'
      throw new ReferenceAnythingError('OpenList operation failed', 'REFERENCE_READ_FAILED')
    } finally { if (this.operation === operation) this.operation = undefined }
  }
}

function endpointOrigin(endpoint: string): string {
  try { return new URL(endpoint).origin } catch { return 'remote' }
}

function managedLoopbackPort(endpoint: string): number | undefined {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined
    const port = Number(url.port)
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
  } catch { return undefined }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10))
  const a = parse(left); const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** Preserve the database's newly-randomized password while rolling back code. */
export function repairRecoveryCredentials(previous: OpenListCredentials, current: OpenListCredentials): OpenListCredentials {
  if (previous.mode !== 'managed' || current.mode !== 'managed' || current.password === undefined || previous.version === undefined) return current
  return { ...current, endpoint: previous.endpoint, token: previous.token, password: current.password, version: previous.version }
}

function validateDriverAddition(driver: OpenListDriver, supplied: Record<string, unknown>, sparse: boolean): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  const known = new Set(driver.fields.map(field => field.name))
  if (Object.keys(supplied).some(name => !known.has(name))) throw new ReferenceAnythingError('OpenList driver fields are invalid', 'REFERENCE_INVALID_CONFIG')
  for (const field of driver.fields) {
    let value = supplied[field.name]
    if (value === undefined && !sparse) value = field.default
    if (value === undefined) {
      if (field.required && !sparse && field.hasDefault !== true) throw new ReferenceAnythingError('OpenList driver fields are incomplete', 'REFERENCE_INVALID_CONFIG')
      continue
    }
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new ReferenceAnythingError('OpenList driver field type is invalid', 'REFERENCE_INVALID_CONFIG')
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ReferenceAnythingError('OpenList driver field type is invalid', 'REFERENCE_INVALID_CONFIG')
    } else if (typeof value !== 'string' || field.required && value.trim() === '') {
      throw new ReferenceAnythingError('OpenList driver field type is invalid', 'REFERENCE_INVALID_CONFIG')
    }
    if (field.type === 'select' && field.options !== undefined && !field.options.some(option => option.value === value)) throw new ReferenceAnythingError('OpenList driver option is invalid', 'REFERENCE_INVALID_CONFIG')
    output[field.name] = value
  }
  return output
}

function abortError(signal?: AbortSignal): Error { return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError') }
function isAbortError(error: unknown, signal?: AbortSignal): boolean { return signal?.aborted === true || error instanceof DOMException && error.name === 'AbortError' || error instanceof Error && error.name === 'AbortError' }

export default OpenListService
