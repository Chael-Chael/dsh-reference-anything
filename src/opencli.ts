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
  deepseek: 'dsh-deepseek', grok: 'dsh-grok',
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

  async history(provider: ChatProvider, signal?: AbortSignal): Promise<ProviderConversationRow[]> {
    const rows = await this.json(SITE[provider], 'history-all', [], signal)
    return rows.map((raw) => ({
      provider,
      accountScope: '',
      id: required(raw, 'id'), title: required(raw, 'title'), url: required(raw, 'url'),
      createdAt: stringField(raw, 'createdAt'), updatedAt: stringField(raw, 'updatedAt'),
      messageCount: integerField(raw, 'messageCount'), cursor: stringField(raw, 'cursor'),
      partial: booleanField(raw, 'partial'),
    }))
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

  async health(signal?: AbortSignal): Promise<{ version: string; daemon: string; pluginInstalled: boolean }> {
    const version = (await this.raw(['--version'], signal)).trim()
    const daemon = (await this.raw(['daemon', 'status'], signal)).trim()
    const plugins = await this.raw(['plugin', 'list'], signal)
    return { version, daemon, pluginInstalled: /dsh-chat-history/i.test(plugins) }
  }

  private async json(site: string, operation: string, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const stdout = await this.raw([site, operation, ...args, '-f', 'json'], signal)
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
