import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { OpenCliError } from './opencli.ts'
// @ts-expect-error -- shared executable adapter source, shipped alongside lib.
import * as deepseek from '../opencli-plugin/deepseek-scripts.js'
// @ts-expect-error -- shared executable adapter source, shipped alongside lib.
import * as kimi from '../opencli-plugin/kimi-scripts.js'

export type TokenProvider = 'deepseek' | 'kimi'
export function isTokenProvider(provider: string): provider is TokenProvider { return provider === 'deepseek' || provider === 'kimi' }
const origins = { deepseek: 'https://chat.deepseek.com', kimi: 'https://www.kimi.com' }
const scripts = { deepseek, kimi }
const MAX_JSON_BYTES = 32 * 1024 * 1024

/** Native binding loads only when the user connects or reads a connected account. */
export async function tokenEntry(id: string) {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring')
    return new AsyncEntry('dsh-reference-anything.web-chat', id, { linux: { store: 'secret-service' } })
  } catch {
    throw new Error('System credential store unavailable; unlock/configure your OS keyring. No plaintext fallback is used.')
  }
}

export async function readToken(id: string): Promise<{ token: string; accountScope: string }> {
  try {
    const raw = await (await tokenEntry(id)).getPassword()
    const value = JSON.parse(raw ?? 'null')
    if (!value || typeof value.token !== 'string' || !value.token || /[\r\n]/.test(value.token)
      || typeof value.accountScope !== 'string' || !/^[a-f0-9]{64}$/.test(value.accountScope)) throw new Error()
    return value
  } catch {
    throw new OpenCliError('Saved credential unavailable; unlock the system keyring or reconnect this account', 'PROVIDER_NOT_LOGGED_IN')
  }
}

async function boundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel()
    throw new OpenCliError('Provider response exceeds size limit', 'OPENCLI_OUTPUT_TOO_LARGE')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new OpenCliError('Provider response exceeds size limit', 'OPENCLI_OUTPUT_TOO_LARGE')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return Buffer.concat(chunks)
}

export class WebChatTokenClient {
  constructor(readonly provider: TokenProvider, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const url = new URL(path, origins[this.provider])
    if (url.origin !== origins[this.provider] || url.username || url.password) {
      throw new OpenCliError('Provider URL rejected', 'OPENCLI_CONFIGURATION')
    }
    signal?.throwIfAborted()
    try {
      const response = await this.fetcher(url, {
        method: init.method ?? 'GET', body: init.body, redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
      })
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        await response.body?.cancel()
        throw new OpenCliError(response.status === 429 ? 'Provider rate limit reached' : 'Login expired; reconnect this account',
          response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_NOT_LOGGED_IN')
      }
      return response
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof OpenCliError) throw error
      // Fetch failures must never expose request headers or provider-supplied text.
      throw new OpenCliError('Provider request failed or timed out', 'PROVIDER_TIMEOUT')
    }
  }

  private async evaluate(script: string, args: Record<string, string>, signal?: AbortSignal): Promise<Record<string, any>> {
    let requestError: unknown
    let requests = 0
    const guardedFetch = async (path: string, init: RequestInit = {}) => {
      try {
        if (++requests > 502) throw new OpenCliError('Provider pagination exceeded limit', 'OPENCLI_FAILED')
        const response = await this.request(path, init, signal)
        const bytes = await boundedBytes(response, MAX_JSON_BYTES)
        const contentType = response.headers.get('content-type') ?? ''
        if (!response.ok || !contentType.includes('application/json')) {
          // The existing adapters deliberately fall back on these two HTTP statuses.
          if (![404, 405].includes(response.status)) throw new OpenCliError('Provider returned an unexpected response', 'OPENCLI_FAILED')
          return new Response(Buffer.from(bytes).toString('utf8'), { status: response.status, headers: response.headers })
        }
        const payload = JSON.parse(Buffer.from(bytes).toString('utf8'))
        if (this.provider === 'deepseek' && (Number(payload.code ?? 0) !== 0 || Number(payload.data?.biz_code ?? 0) !== 0)) {
          throw new OpenCliError('DeepSeek rejected the credential or request; reconnect the account', 'PROVIDER_NOT_LOGGED_IN')
        }
        return new Response(Buffer.from(bytes).toString('utf8'), { status: response.status, headers: response.headers })
      } catch (error) { requestError = error; throw error }
    }
    try {
      // Only our bundled scripts execute here; responses and tokens are data, never source.
      const execute = runInNewContext(`(${script})`, {
        fetch: guardedFetch, URL, URLSearchParams,
        location: { origin: origins[this.provider] },
        localStorage: { getItem: () => this.provider === 'deepseek' ? JSON.stringify(this.token) : this.token },
      }, { timeout: 1000 }) as (args: Record<string, string>) => Promise<string>
      const result = JSON.parse(await execute(args))
      signal?.throwIfAborted()
      if (requestError) throw requestError
      if (result.code === 'AUTH') throw new OpenCliError('Login expired; reconnect this account', 'PROVIDER_NOT_LOGGED_IN')
      if (result.code === 'RATE_LIMIT') throw new OpenCliError('Provider rate limit reached', 'PROVIDER_RATE_LIMIT')
      if (result.ok !== true || result.rows?.some((row: { partial?: boolean }) => row.partial)) throw new OpenCliError('Provider response could not be read completely', 'OPENCLI_FAILED')
      return result
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof OpenCliError) throw error
      throw new OpenCliError('Provider response could not be read', 'OPENCLI_FAILED')
    }
  }

  async identity(signal?: AbortSignal): Promise<{ identity: string; accountScope: string }> {
    const result = await this.evaluate(scripts[this.provider].whoamiScript, {}, signal)
    if (typeof result.identity !== 'string' || !result.identity) throw new OpenCliError('Account identity unavailable', 'PROVIDER_NOT_LOGGED_IN')
    return { identity: result.identity, accountScope: createHash('sha256').update(`${this.provider}\0${result.identity}`).digest('hex') }
  }

  async run(operation: string, args: string[], savedScope: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const { identity, accountScope } = await this.identity(signal)
    const option = (name: string) => { const index = args.indexOf(`--${name}`); return index < 0 ? '' : args[index + 1] ?? '' }
    if (accountScope !== savedScope || operation !== 'sync-index' && option('accountScope') && option('accountScope') !== accountScope) {
      throw new OpenCliError('Conversation belongs to a different account; sync and reselect it', 'PROVIDER_ACCOUNT_MISMATCH')
    }
    if (operation === 'whoami') return [{ identity }]
    if (operation === 'sync-index' || operation === 'history-all') {
      const since = option('accountScope') === accountScope ? option('since') : ''
      const result = await this.evaluate(scripts[this.provider].historyScript, { since }, signal)
      if (!Array.isArray(result.rows)) throw new OpenCliError('Invalid conversation listing', 'OPENCLI_FAILED')
      const rows = [...new Map<string, Record<string, unknown>>(result.rows.map((row: Record<string, unknown>) => [String(row.id), row])).values()]
      return operation === 'sync-index'
        ? [{ kind: 'identity', identity, sinceApplied: since }, ...rows.map(row => ({ ...row, kind: 'conversation' }))]
        : rows
    }
    if (operation === 'detail') {
      const result = await this.evaluate(scripts[this.provider].detailScript, { id: args[0] ?? '' }, signal)
      if (!Array.isArray(result.rows)) throw new OpenCliError('Invalid conversation detail', 'OPENCLI_FAILED')
      return result.rows
    }
    if (operation === 'attachment') {
      const maxBytes = Number(option('maxBytes'))
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 25 * 1024 * 1024) throw new OpenCliError('Invalid attachment limit', 'OPENCLI_CONFIGURATION')
      const response = await this.request(args[0] ?? '', {}, signal)
      if (!response.ok) { await response.body?.cancel(); throw new OpenCliError('Attachment unavailable', 'OPENCLI_FAILED') }
      let bytes: Uint8Array
      try { bytes = await boundedBytes(response, maxBytes) }
      catch (error) {
        if (error instanceof OpenCliError && error.code === 'OPENCLI_OUTPUT_TOO_LARGE') throw new OpenCliError('Attachment exceeds size limit', 'ATTACHMENT_TOO_LARGE')
        throw error
      }
      await writeFile(option('output'), bytes, { flag: 'wx', mode: 0o600 })
      return [{ size: bytes.byteLength }]
    }
    throw new OpenCliError('Unsupported token operation', 'OPENCLI_CONFIGURATION')
  }
}
