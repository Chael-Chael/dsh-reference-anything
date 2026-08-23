import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import type { ChatProvider } from './store/spec.ts'
import type { ProviderConversationRow, ProviderTurnRow } from './store/store.ts'

const execFile = promisify(nodeExecFile)
export const MIN_OPENCLI_VERSION = '1.8.6'
export const MIN_ADAPTER_VERSION = '0.2.3'
/** Allows a 25 MiB attachment to cross JSON/base64 stdout with bounded headroom. */
export const DEFAULT_OPENCLI_MAX_STDOUT_BYTES = 40 * 1024 * 1024
export const OPENCLI_NPM_PACKAGE = '@jackwener/opencli'
const SITE: Record<ChatProvider, string> = {
  chatgpt: 'dsh-chatgpt', claude: 'dsh-claude', gemini: 'dsh-gemini',
  deepseek: 'dsh-deepseek', grok: 'dsh-grok', kimi: 'dsh-kimi',
}
const REQUIRED_ADAPTER_COMMANDS = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi'] as const
const ADAPTER_PLUGIN_NAME = 'dsh-chat-history'

export type OpenCliErrorCode = 'EXTENSION_NOT_CONNECTED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_NOT_LOGGED_IN'
  | 'PROVIDER_ACCOUNT_MISMATCH' | 'PROVIDER_RATE_LIMIT' | 'OPENCLI_CONFIGURATION' | 'OPENCLI_OUTPUT_TOO_LARGE' | 'OPENCLI_FAILED'
  | 'OPENCLI_INSTALL_FAILED' | 'ATTACHMENT_TOO_LARGE'

export class OpenCliError extends Error {
  constructor(message: string, readonly code: OpenCliErrorCode, options?: ErrorOptions) { super(message, options) }
}

export interface OpenCliRunnerOptions {
  executable?: string
  /** Fixed argv placed before OpenCLI arguments; useful for a Node-hosted wrapper or tests. */
  prefixArgs?: readonly string[]
  profile?: string
  timeoutMs?: number
  maxStdoutBytes?: number
}

/** Connection state of the Browser Bridge browser extension, mirroring `opencli daemon status`. */
export type ExtensionState = 'connected' | 'disconnected' | 'profile-required' | 'profile-disconnected' | 'daemon-offline'

export interface OpenCliHealth {
  version: string
  /** Raw `opencli daemon status` output, kept for display and debugging. */
  daemon: string
  pluginInstalled: boolean
  daemonRunning: boolean
  extensionConnected: boolean
  extensionState: ExtensionState
  extensionVersion?: string
  profileCount?: number
  opencliCompatible: boolean
  daemonVersion?: string
  daemonStale: boolean
  connectivityOk: boolean
  connectivityChecked: boolean
  pluginVersion?: string
  adapterCommandsReady: boolean
  adapterCompatible: boolean
  versionError?: string
  daemonError?: string
  pluginError?: string
  doctorError?: string
}

/** Result returned to the settings page after searching for an executable. */
export interface OpenCliDiscovery {
  found: boolean
  executable: string
  version: string
  error?: string
}

export interface DaemonStatus {
  daemonRunning: boolean
  extensionState: ExtensionState
  extensionConnected: boolean
  extensionVersion?: string
  profileCount?: number
}

/**
 * Parse the human-readable `opencli daemon status` output into structured
 * bridge state. Empty output — including a probe failure — degrades to
 * `daemon-offline` rather than throwing, so one broken probe never hides the
 * rest of the viability panel.
 */
export function parseDaemonStatus(output: string): DaemonStatus {
  const daemonRunning = /^Daemon:\s+(?:running|stale)\b/m.test(output)
  const connected = /^Extension:\s+connected\b/m.test(output)
  const version = connected ? output.match(/^Extension:\s+connected \((v)?([^)\s]+)\)/m)?.[2] : undefined
  const profileRequired = output.match(/^Extension:\s+(\d+) profiles? connected, none selected/m)
  const profileDisconnected = /^Extension:\s+requested profile not connected/m.test(output)
  const extensionState: ExtensionState = !daemonRunning ? 'daemon-offline'
    : connected ? 'connected'
    : profileRequired ? 'profile-required'
    : profileDisconnected ? 'profile-disconnected'
    : 'disconnected'
  const profileCount = profileRequired ? Number(profileRequired[1]) : undefined
  return {
    daemonRunning, extensionState, extensionConnected: extensionState === 'connected',
    ...(version ? { extensionVersion: version } : {}),
    ...(profileCount !== undefined ? { profileCount } : {}),
  }
}

export interface BrowserProfile { id: string; alias?: string; connected: boolean; isDefault: boolean }
export interface ProviderIndex { accountScope: string; sinceApplied: string; rows: ProviderConversationRow[] }

export class OpenCliRunner {
  readonly executable: string
  readonly profile: string
  readonly prefixArgs: readonly string[]
  readonly timeoutMs: number
  readonly maxStdoutBytes: number

  constructor(options: OpenCliRunnerOptions = {}) {
    this.executable = options.executable || 'opencli'
    this.profile = options.profile || ''
    this.prefixArgs = options.prefixArgs ?? []
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_OPENCLI_MAX_STDOUT_BYTES
  }

  async whoami(provider: ChatProvider, signal?: AbortSignal): Promise<string> {
    const rows = await this.json(SITE[provider], 'whoami', [], signal)
    const identity = stringField(rows[0], 'identity')
    if (!identity) throw new OpenCliError(`${provider} returned no stable account identity`, 'PROVIDER_NOT_LOGGED_IN')
    return createHash('sha256').update(`${provider}\0${identity}`).digest('hex')
  }

  /**
   * List a provider's conversations.
   * @param provider - which provider to list.
   * @param signal - cancellation from the caller.
   * @param since - ISO instant the adapter may stop paging at. Best-effort:
   * adapters that page in an order they cannot vouch for ignore it, and one
   * installed before the flag existed is retried without it rather than
   * failing the pass.
   * @returns the listed conversations.
   */
  async history(provider: ChatProvider, signal?: AbortSignal, since = ''): Promise<ProviderConversationRow[]> {
    const rows = await this.historyRows(provider, since, signal)
    return conversationRows(provider, rows)
  }

  /** Resolve account identity and history through one OpenCLI browser command. */
  async syncIndex(provider: ChatProvider, signal?: AbortSignal, since = '', accountScope = ''): Promise<ProviderIndex> {
    const args = [...(since ? ['--since', since] : []), ...(accountScope ? ['--accountScope', accountScope] : [])]
    const rows = await this.json(SITE[provider], 'sync-index', args, signal)
    const identity = rows.find(row => stringField(row, 'kind') === 'identity')
    const stableIdentity = stringField(identity, 'identity')
    if (!stableIdentity) throw new OpenCliError(`${provider} returned no stable account identity`, 'PROVIDER_NOT_LOGGED_IN')
    return {
      accountScope: createHash('sha256').update(`${provider}\0${stableIdentity}`).digest('hex'),
      sinceApplied: stringField(identity, 'sinceApplied'),
      rows: conversationRows(provider, rows.filter(row => stringField(row, 'kind') === 'conversation')),
    }
  }

  async detail(provider: ChatProvider, id: string, signal?: AbortSignal, accountScope = ''): Promise<ProviderTurnRow[]> {
    const rows = await this.json(SITE[provider], 'detail', [id, ...(accountScope ? ['--accountScope', accountScope] : [])], signal)
    return rows.map((raw, index) => {
      const role = stringField(raw, 'role')
      if (role !== 'user' && role !== 'assistant') throw new OpenCliError('provider detail returned an invalid role', 'OPENCLI_CONFIGURATION')
      return {
        conversationId: required(raw, 'conversationId'), ordinal: integerField(raw, 'ordinal', index),
        messageId: stringField(raw, 'messageId'), parentId: stringField(raw, 'parentId'),
        branchId: stringField(raw, 'branchId'), activeBranch: booleanField(raw, 'activeBranch', true),
        role, text: stringField(raw, 'text'), createdAt: stringField(raw, 'createdAt'),
        attachmentsJson: stringField(raw, 'attachmentsJson', '[]'), partial: booleanField(raw, 'partial'),
      }
    })
  }

  async attachment(
    provider: ChatProvider, locator: string, output: string, maxBytes: number, signal?: AbortSignal, accountScope = '',
  ): Promise<Record<string, unknown>> {
    const rows = await this.json(SITE[provider], 'attachment', [
      locator, '--output', output, '--maxBytes', String(maxBytes),
      ...(accountScope ? ['--accountScope', accountScope] : []),
    ], signal)
    return rows[0] ?? {}
  }

  async health(signal?: AbortSignal): Promise<OpenCliHealth> {
    return this.inspectHealth(true, signal)
  }

  /** Inspect local OpenCLI, daemon, extension and plugin state without an active connectivity probe. */
  async quickHealth(signal?: AbortSignal): Promise<OpenCliHealth> {
    return this.inspectHealth(false, signal)
  }

  private async inspectHealth(checkConnectivity: boolean, signal?: AbortSignal): Promise<OpenCliHealth> {
    const [version, daemon, plugins, doctor] = await Promise.all([
      this.probe(['--version'], signal), this.probe(['daemon', 'status'], signal), this.probe(['plugin', 'list'], signal),
      checkConnectivity ? this.probe(['doctor'], signal) : Promise.resolve({ value: '', diagnostic: '' }),
    ])
    const status = parseDaemonStatus(daemon.value)
    const cliVersion = normalizeVersion(version.value)
    const daemonVersion = daemon.value.match(/^Version:\s+v?([^\s(]+)/m)?.[1]
    const pluginVersion = plugins.value.match(/dsh-chat-history\s+@([^\s—]+)/i)?.[1]
    const pluginInstalled = /dsh-chat-history/i.test(plugins.value)
    const adapterLoadError = adapterPluginLoadError(plugins.diagnostic)
    const adapterCommandsReady = !adapterLoadError
      && REQUIRED_ADAPTER_COMMANDS.every(command => new RegExp(`\\b${command}\\b`, 'i').test(plugins.value))
    const opencliCompatible = versionAtLeast(cliVersion, MIN_OPENCLI_VERSION)
    const daemonStale = Boolean(status.daemonRunning && (!daemonVersion || normalizeVersion(daemonVersion) !== cliVersion))
    const connectivityOk = /\[OK\]\s+Connectivity:/i.test(doctor.value)
    return {
      version: cliVersion, daemon: daemon.value.trim(), pluginInstalled,
      daemonRunning: status.daemonRunning, extensionConnected: status.extensionConnected, extensionState: status.extensionState,
      opencliCompatible, daemonStale, connectivityOk, connectivityChecked: checkConnectivity,
      ...(status.extensionVersion ? { extensionVersion: status.extensionVersion } : {}),
      ...(status.profileCount !== undefined ? { profileCount: status.profileCount } : {}),
      ...(daemonVersion ? { daemonVersion: normalizeVersion(daemonVersion) } : {}),
      ...(pluginVersion ? { pluginVersion: normalizeVersion(pluginVersion) } : {}),
      adapterCommandsReady,
      adapterCompatible: pluginInstalled && adapterCommandsReady && versionAtLeast(pluginVersion ?? '', MIN_ADAPTER_VERSION),
      ...(version.error ? { versionError: version.error } : {}),
      ...(daemon.error ? { daemonError: daemon.error } : {}),
      ...(plugins.error || adapterLoadError ? { pluginError: plugins.error || adapterLoadError } : {}),
      ...('error' in doctor && doctor.error ? { doctorError: doctor.error } : {}),
    }
  }

  /** Lightweight executable validation used by automatic path discovery. */
  async version(signal?: AbortSignal): Promise<string> { return normalizeVersion(await this.raw(['--version'], signal)) }

  /** Confirm the executable also exposes OpenCLI's plugin command, not merely a semver-looking --version. */
  async verifyInstallation(signal?: AbortSignal): Promise<void> { await this.raw(['plugin', 'list'], signal) }

  async profiles(signal?: AbortSignal): Promise<BrowserProfile[]> {
    const output = await this.raw(['profile', 'list'], signal)
    const disconnected = output.indexOf('Disconnected saved profiles:')
    return output.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s{2}([A-Za-z0-9_-]+)(?:\s+([A-Za-z0-9_-]+))?(?:\s+default)?\s+—\s+(connected|not connected)/)
      if (!match) return []
      const position = output.indexOf(line)
      return [{ id: match[1]!, ...(match[2] && match[2] !== 'default' ? { alias: match[2] } : {}),
        connected: match[3] === 'connected' && (disconnected < 0 || position < disconnected), isDefault: /\sdefault\s+—/.test(line) }]
    })
  }

  async installPlugin(pluginUrl: string, signal?: AbortSignal): Promise<void> {
    const before = await this.command(['plugin', 'list'], signal)
    if (new RegExp(`\\b${ADAPTER_PLUGIN_NAME}\\b`, 'i').test(before.stdout)) {
      await this.raw(['plugin', 'update', ADAPTER_PLUGIN_NAME], signal)
    } else {
      await this.raw(['plugin', 'install', pluginUrl], signal)
    }

    const after = await this.command(['plugin', 'list'], signal)
    const loadError = adapterPluginLoadError(after.stderr)
    const commandsReady = REQUIRED_ADAPTER_COMMANDS.every(command => new RegExp(`\\b${command}\\b`, 'i').test(after.stdout))
    if (loadError || !commandsReady) {
      throw new OpenCliError(loadError || 'OpenCLI did not register all six conversation adapters', 'OPENCLI_CONFIGURATION')
    }
  }

  async restartDaemon(signal?: AbortSignal): Promise<void> { await this.raw(['daemon', 'restart'], signal) }

  private async probe(args: string[], signal?: AbortSignal): Promise<{ value: string; diagnostic?: string; error?: string }> {
    try {
      const result = await this.command(args, signal)
      return { value: result.stdout, ...(result.stderr.trim() ? { diagnostic: result.stderr.trim() } : {}) }
    }
    catch (error) { return { value: '', error: error instanceof Error ? error.message : String(error) } }
  }

  private async historyRows(
    provider: ChatProvider, since: string, signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    if (!since) return this.json(SITE[provider], 'history-all', [], signal)
    try {
      return await this.json(SITE[provider], 'history-all', ['--since', since], signal)
    } catch (error) {
      // An adapter installed before `--since` existed rejects the flag as a
      // configuration error. Walking the whole history is slower but correct,
      // and beats failing every background pass until the user remembers to
      // reinstall the OpenCLI plugin.
      if (!(error instanceof OpenCliError) || error.code !== 'OPENCLI_CONFIGURATION') throw error
      return this.json(SITE[provider], 'history-all', [], signal)
    }
  }

  private async json(site: string, operation: string, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    // Match the sync-index lifecycle: every command gets its own temporary
    // background tab, so providers and detail workers can run independently.
    const stdout = await this.raw([
      site, operation, ...args,
      '--site-session', 'ephemeral', '--window', 'background', '-f', 'json',
    ], signal)
    try {
      const parsed: unknown = JSON.parse(stdout)
      if (!Array.isArray(parsed) || parsed.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('expected object array')
      return parsed as Record<string, unknown>[]
    } catch (error) {
      throw new OpenCliError('OpenCLI returned malformed JSON', 'OPENCLI_CONFIGURATION', { cause: error })
    }
  }

  private async raw(args: string[], signal?: AbortSignal): Promise<string> {
    return (await this.command(args, signal)).stdout
  }

  private async command(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    const invocation = resolveInvocation(this.executable)
    const fullArgs = [...invocation.prefix, ...this.prefixArgs, ...(this.profile ? ['--profile', this.profile] : []), ...args]
    try {
      const result = await execFile(invocation.file, fullArgs, {
        encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: this.maxStdoutBytes,
        windowsHide: true, shell: false, signal, env: { ...process.env, OPENCLI_WINDOW: 'background' },
      })
      return { stdout: result.stdout, stderr: result.stderr }
    } catch (error: unknown) {
      const detail = error as { code?: number | string; killed?: boolean; signal?: string; stderr?: string; stdout?: string }
      if (detail.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new OpenCliError('OpenCLI output exceeded the configured limit', 'OPENCLI_OUTPUT_TOO_LARGE', { cause: error })
      if (detail.killed || detail.signal === 'SIGTERM') throw new OpenCliError('OpenCLI provider request timed out', 'PROVIDER_TIMEOUT', { cause: error })
      const stderr = String(detail.stderr || detail.stdout || '').trim().slice(0, 2_000)
      const exit = typeof detail.code === 'number' ? detail.code : undefined
      const code: OpenCliErrorCode = stderr.includes('DSH_ACCOUNT_SCOPE_MISMATCH') ? 'PROVIDER_ACCOUNT_MISMATCH'
        : stderr.includes('DSH_PROVIDER_RATE_LIMIT') ? 'PROVIDER_RATE_LIMIT'
        : stderr.includes('DSH_ATTACHMENT_TOO_LARGE') ? 'ATTACHMENT_TOO_LARGE'
        : exit === 69 ? 'EXTENSION_NOT_CONNECTED' : exit === 75 ? 'PROVIDER_TIMEOUT'
          : exit === 77 ? 'PROVIDER_NOT_LOGGED_IN' : exit === 78 ? 'OPENCLI_CONFIGURATION' : 'OPENCLI_FAILED'
      throw new OpenCliError(stderr || `OpenCLI exited with ${String(detail.code)}`, code, { cause: error })
    }
  }
}

/** Keep successful-process diagnostics: OpenCLI reports plugin import failures on stderr while exiting zero. */
function adapterPluginLoadError(diagnostic = ''): string {
  const lines = diagnostic.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /Plugin dsh-chat-history\//i.test(line))
  return [...new Set(lines)].join('\n').slice(0, 2_000)
}

/** Locate a working OpenCLI without asking a command-line newcomer for PATH details. */
export async function discoverOpenCli(configured = 'opencli', signal?: AbortSignal): Promise<OpenCliDiscovery> {
  const candidates = openCliCandidates(configured)
  let lastError = ''
  for (const executable of candidates) {
    try {
      const runner = new OpenCliRunner({ executable, timeoutMs: 15_000 })
      const version = await runner.version(signal)
      await runner.verifyInstallation(signal)
      if (version) return { found: true, executable, version }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { found: false, executable: configured, version: '', ...(lastError ? { error: lastError } : {}) }
}

/** Install or upgrade the supported OpenCLI package through this Node runtime's npm. */
export async function installOpenCli(signal?: AbortSignal): Promise<OpenCliDiscovery> {
  const npm = resolveNpmInvocation()
  if (!npm) {
    throw new OpenCliError('npm was not found next to the Node.js runtime; install Node.js/npm, then retry', 'OPENCLI_INSTALL_FAILED')
  }
  try {
    await execFile(npm.file, [...npm.prefix, 'install', '--global', `${OPENCLI_NPM_PACKAGE}@>=${MIN_OPENCLI_VERSION}`], {
      encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, shell: false, signal,
    })
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string }
    const output = String(detail.stderr || detail.stdout || '').trim().slice(0, 2_000)
    throw new OpenCliError(output || 'npm could not install OpenCLI globally', 'OPENCLI_INSTALL_FAILED', { cause: error })
  }
  const discovery = await discoverOpenCli('opencli', signal)
  if (!discovery.found) throw new OpenCliError(discovery.error || 'OpenCLI was installed but could not be located', 'OPENCLI_INSTALL_FAILED')
  return discovery
}

function openCliCandidates(configured: string): string[] {
  const candidates = [configured, 'opencli']
  const prefix = process.env.npm_config_prefix
  if (process.platform === 'win32') {
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'opencli.cmd'))
    if (prefix) candidates.push(join(prefix, 'opencli.cmd'))
  } else {
    if (prefix) candidates.push(join(prefix, 'bin', 'opencli'))
    candidates.push('/usr/local/bin/opencli', '/opt/homebrew/bin/opencli')
  }
  return [...new Set(candidates.filter(Boolean))]
}

function resolveNpmInvocation(): { file: string; prefix: string[] } | undefined {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && existsSync(npmExecPath)) {
    return /\.(?:c?js|mjs)$/i.test(npmExecPath)
      ? { file: process.execPath, prefix: [npmExecPath] }
      : { file: npmExecPath, prefix: [] }
  }
  const besideNode = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(besideNode)) return { file: process.execPath, prefix: [besideNode] }
  if (process.platform !== 'win32') return { file: 'npm', prefix: [] }
  return undefined
}

function normalizeVersion(value: string): string { return value.trim().replace(/^v/i, '').split(/\s+/)[0] ?? '' }

/** Numeric semver comparison for the stable x.y.z versions OpenCLI publishes. */
export function versionAtLeast(value: string, minimum: string): boolean {
  const parse = (input: string) => normalizeVersion(input).split('.').slice(0, 3).map(part => Number.parseInt(part, 10))
  const actual = parse(value); const required = parse(minimum)
  if (actual.length < 3 || actual.some(Number.isNaN)) return false
  for (let index = 0; index < 3; index++) {
    const left = actual[index] ?? 0; const right = required[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}

function resolveInvocation(configured: string): { file: string; prefix: string[] } {
  const explicit = resolve(configured)
  if (/\.cmd$/i.test(configured) && existsSync(explicit)) {
    const entry = join(explicit, '..', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')
    if (existsSync(entry)) return { file: process.execPath, prefix: [entry] }
  }
  if (process.platform === 'win32' && configured === 'opencli') {
    const entry = process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')
    if (entry && existsSync(entry)) return { file: process.execPath, prefix: [entry] }
  }
  return { file: configured, prefix: [] }
}

function stringField(row: Record<string, unknown> | undefined, key: string, fallback = ''): string {
  const value = row?.[key]
  return value === undefined || value === null ? fallback : String(value)
}
function conversationRows(provider: ChatProvider, rows: readonly Record<string, unknown>[]): ProviderConversationRow[] {
  return rows.map(raw => ({
    provider,
    accountScope: '',
    id: required(raw, 'id'), title: required(raw, 'title'), url: required(raw, 'url'),
    createdAt: stringField(raw, 'createdAt'), updatedAt: stringField(raw, 'updatedAt'),
    messageCount: integerField(raw, 'messageCount'), cursor: stringField(raw, 'cursor'),
    partial: booleanField(raw, 'partial'),
  }))
}
function required(row: Record<string, unknown>, key: string): string {
  const value = stringField(row, key).trim()
  if (!value) throw new OpenCliError(`provider row is missing ${key}`, 'OPENCLI_CONFIGURATION')
  return value
}
function integerField(row: Record<string, unknown>, key: string, fallback = 0): number {
  const value = Number(row[key] ?? fallback)
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback
}
function booleanField(row: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = row[key]
  if (value === undefined) return fallback
  return value === true || value === 'true' || value === 1 || value === '1'
}
