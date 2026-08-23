import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { cli, Strategy } from '@jackwener/opencli/registry'
import { sinceGuardSource } from './since-guard.js'
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '@jackwener/opencli/errors'

export { sinceGuardSource }

const HISTORY_COLUMNS = [
  'provider', 'accountScope', 'id', 'title', 'url', 'createdAt', 'updatedAt',
  'messageCount', 'cursor', 'partial',
]

const SYNC_INDEX_COLUMNS = ['kind', 'identity', 'sinceApplied', ...HISTORY_COLUMNS]

const DETAIL_COLUMNS = [
  'conversationId', 'ordinal', 'messageId', 'parentId', 'branchId',
  'activeBranch', 'role', 'text', 'createdAt', 'attachmentsJson', 'partial',
]

function parseEvaluate(value, operation) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new CommandExecutionError(`${operation}: provider page returned malformed JSON: ${String(error)}`)
  }
}

async function evaluate(page, script, args, operation) {
  const source = `(() => { const __args = ${JSON.stringify(args)}; return (${script})(__args); })()`
  return parseEvaluate(await page.evaluate(source), operation)
}

/** Refuse an identity that does not match the account scope captured by sync. */
export function verifyAccountScope(provider, site, expectedScope, identity) {
  if (!expectedScope) return
  const actualScope = createHash('sha256').update(`${provider.toLocaleLowerCase()}\0${identity}`).digest('hex')
  if (actualScope !== expectedScope) {
    throw new CommandExecutionError(`DSH_ACCOUNT_SCOPE_MISMATCH: ${site} attachment: attachment belongs to a different logged-in account`)
  }
}

/** Preserve omission compatibility while rejecting malformed supplied scopes. */
export function parseExpectedAccountScope(value) {
  if (value === undefined || value === null) return ''
  const scope = String(value).trim()
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new ArgumentError('accountScope must be a 64-character lowercase hexadecimal hash')
  return scope
}

function assertResult(result, domain, operation) {
  if (result?.code === 'AUTH') throw new AuthRequiredError(domain, result.message || `${operation} requires login`)
  if (result?.code === 'RATE_LIMIT') {
    throw new CommandExecutionError(`${operation}: ${result.message || 'provider rate limit reached'}`)
  }
  if (result?.ok !== true || !Array.isArray(result.rows)) {
    throw new CommandExecutionError(`${operation}: ${result?.message || 'provider adapter did not return rows'}`)
  }
  return result.rows
}

function assertIdentityResult(result, domain, operation) {
  if (result?.code === 'AUTH') throw new AuthRequiredError(domain, result.message)
  if (result?.code === 'RATE_LIMIT') {
    throw new CommandExecutionError(`DSH_PROVIDER_RATE_LIMIT: ${operation}: ${result.message || 'provider rate limit reached'}`)
  }
  if (result?.ok !== true || typeof result.identity !== 'string' || !result.identity) {
    throw new CommandExecutionError(`${operation}: ${result?.message || 'stable account identity unavailable'}`)
  }
  return result.identity
}

const PROVIDER_READY_TIMEOUT_MS = 1200
const PROVIDER_READY_INITIAL_DELAY_MS = 50
const PROVIDER_READY_MAX_DELAY_MS = 400

function terminalProviderResult(result) {
  return result?.ok === true || result?.code === 'AUTH' || result?.code === 'RATE_LIMIT'
}

function terminalIdentityResult(result) {
  return result?.code === 'AUTH' || result?.code === 'RATE_LIMIT'
    || (result?.ok === true && typeof result.identity === 'string' && result.identity.length > 0)
}

/**
 * Run the provider API as the readiness probe. The happy path performs one
 * evaluate immediately after navigation; transient bootstrap failures retry
 * with bounded exponential backoff instead of waiting for the whole SPA DOM
 * to become quiet first.
 */
export async function evaluateWhenProviderReady(page, script, args, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? PROVIDER_READY_TIMEOUT_MS
  const maxDelayMs = options.maxDelayMs ?? PROVIDER_READY_MAX_DELAY_MS
  const accepts = options.accepts ?? terminalProviderResult
  const deadline = Date.now() + timeoutMs
  let delayMs = options.initialDelayMs ?? PROVIDER_READY_INITIAL_DELAY_MS
  let lastResult
  let lastError
  for (;;) {
    try {
      lastResult = await evaluate(page, script, args, operation)
      lastError = undefined
      if (accepts(lastResult)) return lastResult
    } catch (error) {
      lastError = error
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      if (lastError) throw lastError
      return lastResult
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, remaining)))
    delayMs = Math.min(Math.max(delayMs * 2, 1), maxDelayMs)
  }
}

/**
 * Each command owns an ephemeral Browser Bridge tab. Close that tab after the
 * command finishes while preserving the provider result or failure.
 */
async function inTemporaryTab(page, task) {
  try {
    return await task()
  } finally {
    try {
      await page.closeTab?.()
    } catch {
      // Preserve the provider result/error if the tab or browser closed first.
    }
  }
}

export function registerProvider(config) {
  const browserSession = SYNC_BROWSER_SESSION

  cli({
    site: config.site,
    name: 'whoami',
    access: 'read',
    description: `Resolve the stable ${config.provider} account identity for local scoping`,
    domain: config.domain,
    strategy: Strategy.COOKIE,
    browser: true,
    ...browserSession,
    navigateBefore: false,
    args: [],
    columns: ['identity'],
    func: async (page) => inTemporaryTab(page, async () => {
      await page.goto(config.home, { waitUntil: 'none' })
      const result = await evaluateWhenProviderReady(
        page, config.whoamiScript, {}, `${config.site} whoami`, { accepts: terminalIdentityResult },
      )
      return [{ identity: assertIdentityResult(result, config.domain, `${config.site} whoami`) }]
    }),
  })

  cli({
    site: config.site,
    name: 'sync-index',
    access: 'read',
    description: `Resolve the ${config.provider} account and list its conversation history in one browser session`,
    domain: config.domain,
    strategy: Strategy.COOKIE,
    browser: true,
    ...browserSession,
    navigateBefore: false,
    args: [{
      name: 'since',
      help: 'ISO 8601 instant; stop paging once the listing predates it. Honoured only while the provider pages newest-first',
    }, { name: 'accountScope', help: 'Previously observed hashed account scope; mismatch forces a full listing' }],
    columns: SYNC_INDEX_COLUMNS,
    func: async (page, kwargs) => inTemporaryTab(page, async () => {
      const since = String(kwargs.since || '').trim()
      if (since && Number.isNaN(Date.parse(since))) throw new ArgumentError('since must be an ISO 8601 instant')
      await page.goto(config.home, { waitUntil: 'none' })
      const identity = await evaluateWhenProviderReady(
        page, config.whoamiScript, {}, `${config.site} sync-index identity`, { accepts: terminalIdentityResult },
      )
      const stableIdentity = assertIdentityResult(identity, config.domain, `${config.site} sync-index`)
      const accountScope = createHash('sha256').update(`${config.provider.toLocaleLowerCase()}\0${stableIdentity}`).digest('hex')
      const effectiveSince = String(kwargs.accountScope || '') === accountScope ? since : ''
      const rows = assertResult(
        await evaluate(page, config.historyScript, { since: effectiveSince }, `${config.site} sync-index history`),
        config.domain,
        `${config.site} sync-index`,
      )
      return [
        { kind: 'identity', identity: stableIdentity, sinceApplied: effectiveSince },
        ...rows.map(row => ({ kind: 'conversation', identity: '', sinceApplied: '', ...row })),
      ]
    }),
  })

  cli({
    site: config.site,
    name: 'history-all',
    access: 'read',
    description: `List the ${config.provider} web conversation history, whole or since an instant`,
    domain: config.domain,
    strategy: Strategy.COOKIE,
    browser: true,
    ...browserSession,
    navigateBefore: false,
    args: [{
      name: 'since',
      help: 'ISO 8601 instant; stop paging once the listing predates it. Honoured only while the provider pages newest-first',
    }],
    columns: HISTORY_COLUMNS,
    func: async (page, kwargs) => inTemporaryTab(page, async () => {
      const since = String(kwargs.since || '').trim()
      if (since && Number.isNaN(Date.parse(since))) throw new ArgumentError('since must be an ISO 8601 instant')
      await page.goto(config.home, { waitUntil: 'none' })
      const rows = assertResult(
        await evaluateWhenProviderReady(page, config.historyScript, { since }, `${config.site} history-all`),
        config.domain,
        `${config.site} history-all`,
      )
      return rows
    }),
  })

  cli({
    site: config.site,
    name: 'detail',
    access: 'read',
    description: `Read one complete ${config.provider} conversation`,
    domain: config.domain,
    strategy: Strategy.COOKIE,
    browser: true,
    ...browserSession,
    navigateBefore: false,
    args: [
      { name: 'id', positional: true, required: true, help: 'Provider conversation id' },
      { name: 'accountScope', help: 'Expected hashed account scope; mismatch refuses the read' },
    ],
    columns: DETAIL_COLUMNS,
    func: async (page, kwargs) => inTemporaryTab(page, async () => {
      const id = String(kwargs.id || '').trim()
      if (!id) throw new ArgumentError('id must be a non-empty conversation id')
      await page.goto(config.home, { settleMs: 600 })
      const expectedScope = parseExpectedAccountScope(kwargs.accountScope)
      if (expectedScope) {
        const identity = await evaluate(page, config.whoamiScript, {}, `${config.site} detail identity`)
        const stableIdentity = assertIdentityResult(identity, config.domain, `${config.site} detail`)
        const actualScope = createHash('sha256').update(`${config.provider.toLocaleLowerCase()}\0${stableIdentity}`).digest('hex')
        if (actualScope !== expectedScope) {
          throw new CommandExecutionError(`DSH_ACCOUNT_SCOPE_MISMATCH: ${config.site} detail: conversation belongs to a different logged-in account`)
        }
      }
      let result = await evaluate(page, config.detailScript, { id }, `${config.site} detail`)
      if (result?.ok !== true && result?.code !== 'AUTH' && result?.code !== 'RATE_LIMIT' && config.fallbackScript) {
        await page.goto(config.conversationUrl(id), { settleMs: 1800 })
        result = await evaluate(page, config.fallbackScript, { id }, `${config.site} detail fallback`)
      }
      const rows = assertResult(result, config.domain, `${config.site} detail`)
      if (rows.length === 0) throw new EmptyResultError(`${config.site} detail`, `No messages found for ${id}`)
      return rows
    }),
  })

  cli({
    site: config.site,
    name: 'attachment',
    access: 'read',
    description: `Materialize one authorized ${config.provider} attachment`,
    domain: config.domain,
    strategy: Strategy.COOKIE,
    browser: true,
    ...browserSession,
    navigateBefore: false,
    args: [
      { name: 'locator', positional: true, required: true, help: 'Stable same-origin attachment locator' },
      { name: 'output', required: true, help: 'Absolute output file path' },
      { name: 'maxBytes', type: 'int', default: 26214400, help: 'Maximum decoded bytes' },
      { name: 'accountScope', help: 'Expected hashed account scope; mismatch refuses the download' },
    ],
    columns: ['attachmentId', 'name', 'mimeType', 'size', 'status', 'localPath'],
    func: async (page, kwargs) => inTemporaryTab(page, async () => {
      const locator = String(kwargs.locator || '').trim()
      const output = resolve(String(kwargs.output || ''))
      const maxBytes = Number(kwargs.maxBytes ?? 26_214_400)
      if (!locator) throw new ArgumentError('locator must not be empty')
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 26_214_400) {
        throw new ArgumentError('maxBytes must be between 1 and 26214400')
      }
      await page.goto(config.home, { settleMs: 500 })
      const expectedScope = parseExpectedAccountScope(kwargs.accountScope)
      if (expectedScope) {
        const identity = await evaluateWhenProviderReady(
          page, config.whoamiScript, {}, `${config.site} attachment identity`, { accepts: terminalIdentityResult },
        )
        const stableIdentity = assertIdentityResult(identity, config.domain, `${config.site} attachment`)
        verifyAccountScope(config.provider, config.site, expectedScope, stableIdentity)
      }
      const result = await evaluate(page, ATTACHMENT_SCRIPT, {
        locator,
        origin: new URL(config.home).origin,
        maxBytes,
      }, `${config.site} attachment`)
      if (result?.code === 'AUTH') throw new AuthRequiredError(config.domain)
      if (result?.code === 'TOO_LARGE') {
        throw new CommandExecutionError(`DSH_ATTACHMENT_TOO_LARGE: ${config.site} attachment exceeds maxBytes`)
      }
      if (result?.ok !== true || typeof result.base64 !== 'string') {
        throw new CommandExecutionError(`${config.site} attachment: ${result?.message || 'attachment unavailable'}`)
      }
      const bytes = Buffer.from(result.base64, 'base64')
      if (bytes.byteLength > maxBytes) {
        throw new CommandExecutionError(`DSH_ATTACHMENT_TOO_LARGE: ${config.site} attachment exceeds maxBytes`)
      }
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, bytes)
      return [{
        attachmentId: locator,
        name: result.name || output.split(/[\\/]/).pop() || 'attachment',
        mimeType: result.mimeType || 'application/octet-stream',
        size: bytes.byteLength,
        status: 'available',
        localPath: output,
      }]
    }),
  })
}

/** Browser Bridge lifecycle shared by every web-chat command. */
export const SYNC_BROWSER_SESSION = Object.freeze({
  siteSession: 'ephemeral',
  defaultWindowMode: 'background',
})

export const ATTACHMENT_SCRIPT = String.raw`async function (args) {
  try {
    const cancelBody = async body => {
      try { await body?.cancel?.() } catch {}
    }
    const target = new URL(args.locator, args.origin)
    if (target.origin !== args.origin) return JSON.stringify({ ok: false, message: 'cross-origin locator refused' })
    const response = await fetch(target.href, { credentials: 'include', redirect: 'error' })
    if (response.url && new URL(response.url).origin !== args.origin) {
      await cancelBody(response.body)
      return JSON.stringify({ ok: false, message: 'cross-origin redirect refused' })
    }
    if (response.status === 401 || response.status === 403) {
      await cancelBody(response.body)
      return JSON.stringify({ ok: false, code: 'AUTH' })
    }
    if (!response.ok) {
      await cancelBody(response.body)
      return JSON.stringify({ ok: false, message: 'attachment HTTP ' + response.status })
    }
    const length = Number(response.headers.get('content-length') || 0)
    const declaredLength = Number.isFinite(length) && length > 0 ? length : 0
    if (declaredLength > args.maxBytes) {
      await cancelBody(response.body)
      return JSON.stringify({ ok: false, code: 'TOO_LARGE', message: 'attachment exceeds maxBytes' })
    }
    const chunks = []
    let total = 0
    if (response.body) {
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
          if (total + chunk.byteLength > args.maxBytes) {
            try { await reader.cancel() } catch {}
            return JSON.stringify({ ok: false, code: 'TOO_LARGE', message: 'attachment exceeds maxBytes' })
          }
          chunks.push(chunk)
          total += chunk.byteLength
        }
      } catch (error) {
        try { await reader.cancel() } catch {}
        throw error
      } finally {
        try { reader.releaseLock?.() } catch {}
      }
    }
    if (declaredLength && total < declaredLength) {
      return JSON.stringify({ ok: false, message: 'attachment download was truncated' })
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    let binary = ''
    for (let at = 0; at < bytes.length; at += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(at, Math.min(bytes.length, at + 0x8000)))
    }
    return JSON.stringify({
      ok: true,
      base64: btoa(binary),
      mimeType: response.headers.get('content-type') || 'application/octet-stream',
      name: target.pathname.split('/').pop() || 'attachment',
    })
  } catch (error) {
    return JSON.stringify({ ok: false, message: String(error && error.message || error) })
  }
}`

export const domFallbackScript = String.raw`async function (args) {
  const nodes = Array.from(document.querySelectorAll('[data-message-author-role], user-query, model-response, [class*="message"]'))
  const rows = []
  let ordinal = 0
  for (const node of nodes) {
    if (node.parentElement && node.parentElement.closest('[data-message-author-role], user-query, model-response') !== node) continue
    const attr = (node.getAttribute('data-message-author-role') || '').toLowerCase()
    const tag = node.tagName.toLowerCase()
    const role = attr === 'user' || tag === 'user-query' || /user|human/i.test(node.className || '') ? 'user'
      : attr === 'assistant' || tag === 'model-response' || /assistant|model-response|claude/i.test(node.className || '') ? 'assistant'
      : null
    const text = (node.innerText || node.textContent || '').trim()
    if (!role || !text) continue
    rows.push({
      conversationId: args.id,
      ordinal: ordinal++,
      messageId: node.getAttribute('data-message-id') || '',
      parentId: '', branchId: '', activeBranch: true,
      role, text, createdAt: '', attachmentsJson: '[]', partial: true,
    })
  }
  return JSON.stringify({ ok: rows.length > 0, rows, message: rows.length ? '' : 'DOM fallback found no messages' })
}`
