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

/**
 * Release only the one-shot task tab. Browser Bridge deliberately keeps its
 * empty adapter container alive so the next sync can reuse it; if the user
 * closes that container, Browser Bridge recreates it on demand.
 */
async function inTemporaryTab(page, task) {
  try {
    return await task()
  } finally {
    try {
      await page.closeTab?.()
    } catch {
      // Preserve the provider result/error if the browser closed first.
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
      await page.goto(config.home, { settleMs: 500 })
      const result = await evaluate(page, config.whoamiScript, {}, `${config.site} whoami`)
      if (result?.code === 'AUTH') throw new AuthRequiredError(config.domain)
      if (result?.ok !== true || typeof result.identity !== 'string' || !result.identity) {
        throw new CommandExecutionError(`${config.site} whoami: ${result?.message || 'stable account identity unavailable'}`)
      }
      return [{ identity: result.identity }]
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
      await page.goto(config.home, { settleMs: 1200 })
      const identity = await evaluate(page, config.whoamiScript, {}, `${config.site} sync-index identity`)
      if (identity?.code === 'AUTH') throw new AuthRequiredError(config.domain)
      if (identity?.ok !== true || typeof identity.identity !== 'string' || !identity.identity) {
        throw new CommandExecutionError(`${config.site} sync-index: ${identity?.message || 'stable account identity unavailable'}`)
      }
      const accountScope = createHash('sha256').update(`${config.provider.toLocaleLowerCase()}\0${identity.identity}`).digest('hex')
      const effectiveSince = String(kwargs.accountScope || '') === accountScope ? since : ''
      const rows = assertResult(
        await evaluate(page, config.historyScript, { since: effectiveSince }, `${config.site} sync-index history`),
        config.domain,
        `${config.site} sync-index`,
      )
      return [
        { kind: 'identity', identity: identity.identity, sinceApplied: effectiveSince },
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
      await page.goto(config.home, { settleMs: 1200 })
      const rows = assertResult(
        await evaluate(page, config.historyScript, { since }, `${config.site} history-all`),
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
      const expectedScope = String(kwargs.accountScope || '').trim()
      if (expectedScope) {
        const identity = await evaluate(page, config.whoamiScript, {}, `${config.site} detail identity`)
        if (identity?.code === 'AUTH') throw new AuthRequiredError(config.domain)
        if (identity?.ok !== true || typeof identity.identity !== 'string' || !identity.identity) {
          throw new CommandExecutionError(`${config.site} detail: stable account identity unavailable`)
        }
        const actualScope = createHash('sha256').update(`${config.provider.toLocaleLowerCase()}\0${identity.identity}`).digest('hex')
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
      const result = await evaluate(page, ATTACHMENT_SCRIPT, {
        locator,
        origin: new URL(config.home).origin,
        maxBytes,
      }, `${config.site} attachment`)
      if (result?.code === 'AUTH') throw new AuthRequiredError(config.domain)
      if (result?.ok !== true || typeof result.base64 !== 'string') {
        throw new CommandExecutionError(`${config.site} attachment: ${result?.message || 'attachment unavailable'}`)
      }
      const bytes = Buffer.from(result.base64, 'base64')
      if (bytes.byteLength > maxBytes) throw new CommandExecutionError(`${config.site} attachment exceeds maxBytes`)
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

/** Browser Bridge lifecycle contract shared by every web-chat sync command. */
export const SYNC_BROWSER_SESSION = Object.freeze({
  siteSession: 'ephemeral',
  defaultWindowMode: 'background',
})

const ATTACHMENT_SCRIPT = String.raw`async function (args) {
  try {
    const target = new URL(args.locator, args.origin)
    if (target.origin !== args.origin) return JSON.stringify({ ok: false, message: 'cross-origin locator refused' })
    const response = await fetch(target.href, { credentials: 'include' })
    if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
    if (!response.ok) return JSON.stringify({ ok: false, message: 'attachment HTTP ' + response.status })
    const length = Number(response.headers.get('content-length') || 0)
    if (length > args.maxBytes) return JSON.stringify({ ok: false, message: 'attachment exceeds maxBytes' })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > args.maxBytes) return JSON.stringify({ ok: false, message: 'attachment exceeds maxBytes' })
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
