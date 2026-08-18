import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import type { ChatProvider } from './store/spec.ts'
import type { ProviderConversationRow, ProviderTurnRow } from './store/store.ts'

const execFile = promisify(nodeExecFile)
const SITE: Record<ChatProvider, string> = {
  chatgpt: 'dsh-chatgpt', claude: 'dsh-claude', gemini: 'dsh-gemini',
  deepseek: 'dsh-deepseek', grok: 'dsh-grok', kimi: 'dsh-kimi',
}

export type OpenCliErrorCode = 'EXTENSION_NOT_CONNECTED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_NOT_LOGGED_IN'
  | 'OPENCLI_CONFIGURATION' | 'OPENCLI_OUTPUT_TOO_LARGE' | 'OPENCLI_FAILED'

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
  versionError?: string
  daemonError?: string
  pluginError?: string
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
    this.maxStdoutBytes = options.maxStdoutBytes ?? 32 * 1024 * 1024
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

  async detail(provider: ChatProvider, id: string, signal?: AbortSignal): Promise<ProviderTurnRow[]> {
    const rows = await this.json(SITE[provider], 'detail', [id], signal)
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
    provider: ChatProvider, locator: string, output: string, maxBytes: number, signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const rows = await this.json(SITE[provider], 'attachment', [locator, '--output', output, '--maxBytes', String(maxBytes)], signal)
    return rows[0] ?? {}
  }

  async health(signal?: AbortSignal): Promise<OpenCliHealth> {
    const [version, daemon, plugins] = await Promise.all([
      this.probe(['--version'], signal), this.probe(['daemon', 'status'], signal), this.probe(['plugin', 'list'], signal),
    ])
    const status = parseDaemonStatus(daemon.value)
    return {
      version: version.value.trim(), daemon: daemon.value.trim(), pluginInstalled: /dsh-chat-history/i.test(plugins.value),
      daemonRunning: status.daemonRunning, extensionConnected: status.extensionConnected, extensionState: status.extensionState,
      ...(status.extensionVersion ? { extensionVersion: status.extensionVersion } : {}),
      ...(status.profileCount !== undefined ? { profileCount: status.profileCount } : {}),
      ...(version.error ? { versionError: version.error } : {}),
      ...(daemon.error ? { daemonError: daemon.error } : {}),
      ...(plugins.error ? { pluginError: plugins.error } : {}),
    }
  }

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
    await this.raw(['plugin', 'install', pluginUrl], signal)
  }

  async restartDaemon(signal?: AbortSignal): Promise<void> { await this.raw(['daemon', 'restart'], signal) }

  private async probe(args: string[], signal?: AbortSignal): Promise<{ value: string; error?: string }> {
    try { return { value: await this.raw(args, signal) } }
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
    // Pin adapter traffic to a background tab. OpenCLI otherwise lets the
    // process-wide OPENCLI_WINDOW environment variable override the adapter's
    // defaultWindowMode, which could make an unattended sync steal focus.
    const stdout = await this.raw([site, operation, ...args, '--window', 'background', '-f', 'json'], signal)
    try {
      const parsed: unknown = JSON.parse(stdout)
      if (!Array.isArray(parsed) || parsed.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('expected object array')
      return parsed as Record<string, unknown>[]
    } catch (error) {
      throw new OpenCliError('OpenCLI returned malformed JSON', 'OPENCLI_CONFIGURATION', { cause: error })
    }
  }

  private async raw(args: string[], signal?: AbortSignal): Promise<string> {
    const invocation = resolveInvocation(this.executable)
    const fullArgs = [...invocation.prefix, ...this.prefixArgs, ...(this.profile ? ['--profile', this.profile] : []), ...args]
    try {
      const result = await execFile(invocation.file, fullArgs, {
        encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: this.maxStdoutBytes,
        windowsHide: true, shell: false, signal,
      })
      return result.stdout
    } catch (error: unknown) {
      const detail = error as { code?: number | string; killed?: boolean; signal?: string; stderr?: string }
      if (detail.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new OpenCliError('OpenCLI output exceeded the configured limit', 'OPENCLI_OUTPUT_TOO_LARGE', { cause: error })
      if (detail.killed || detail.signal === 'SIGTERM') throw new OpenCliError('OpenCLI provider request timed out', 'PROVIDER_TIMEOUT', { cause: error })
      const exit = typeof detail.code === 'number' ? detail.code : undefined
      const code: OpenCliErrorCode = exit === 69 ? 'EXTENSION_NOT_CONNECTED' : exit === 75 ? 'PROVIDER_TIMEOUT'
        : exit === 77 ? 'PROVIDER_NOT_LOGGED_IN' : exit === 78 ? 'OPENCLI_CONFIGURATION' : 'OPENCLI_FAILED'
      const stderr = String(detail.stderr || '').trim().slice(0, 2_000)
      throw new OpenCliError(stderr || `OpenCLI exited with ${String(detail.code)}`, code, { cause: error })
    }
  }
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
