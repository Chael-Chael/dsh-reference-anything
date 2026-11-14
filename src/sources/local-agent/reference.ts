/**
 * Local Agent sessions as the `local` source of the `reference` tool.
 *
 * Ids are `<agent>[@<location>]:<relative path>[#<session>]` (see ids.ts). Each
 * read decodes the id, checks the Agent's switch, resolves the path inside the
 * named scan location (realpath-contained) and parses the whole session fresh;
 * nothing is cached across calls.
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { chatImportReference, chatImportTarget } from '../../chat-import-reader.ts'
import { agentKind, scanFormat } from '../../chat-import-discovery.ts'
import { localConversationRoots } from '../../local-conversation-reader.ts'
import { assertLocalScope, assertLocalSourceEnabled, embeddedAttachment, loadLocalReference, type DocumentAttachment, type LocalDocument } from '../../local-reference.ts'
import { LOCAL_REFERENCE_SOURCE, decodeLocalLocator } from '../../local-locator.ts'
import { defineReferenceSource, referenceError, type ReferenceDoc, type ReferenceDocChild, type ReferenceSourcePlugin } from '../../reference-source.ts'
import { ALL_LOCAL_AGENTS, type LocalAgent } from '../../wire.ts'
import { decodeLocalId, encodeLocalId, localCandidates, localIdFor, nameDefaultRoots, sessionOf, type LocalRoot } from './ids.ts'
import { inWorkspace } from './path.ts'
import type {} from './index.ts'

/** Routing key of local sessions in the `reference` tool. */
export const LOCAL_SOURCE = 'local'

function rootsOf(ctx: Context, agent: LocalAgent): LocalRoot[] {
  const service = ctx.get('referenceLocalAgents')
  if (service?.namedRoots) return service.namedRoots(agent)
  const own = localConversationRoots()[scanFormat(agent)]
  const roots = nameDefaultRoots((Array.isArray(own) ? own : own ? [own] : []).map(path => resolve(path)))
  const custom = service?.preferences.get().agentDirectories[agent]
  return custom ? [...roots, { name: 'custom', path: custom }] : roots
}

/** The local id for a conversation the scanner found, or undefined when it lies outside every scan location. */
export function localIdForTarget(ctx: Context, format: string, path: string, sessionId: string): string | undefined {
  const agent = agentKind(format) as LocalAgent
  if (!ALL_LOCAL_AGENTS.includes(agent)) return undefined
  return localIdFor(agent, rootsOf(ctx, agent), { path, sessionId })
}

/** Map the older local wire forms (`local-agent` chat-import ids, `dsh-local:` locators) to a local id. */
function claimLegacy(ctx: Context, id: string): string | undefined {
  if (decodeLocalId(id)) return id
  const target = chatImportTarget(id)
  if (target) return localIdForTarget(ctx, target.format, target.path, target.sessionId)
  if (id.startsWith('dsh-local:')) {
    const locator = decodeLocalLocator(id)
    return localIdForTarget(ctx, locator.source, locator.path, locator.sessionId)
  }
  return undefined
}

/** Model-side ref of the protocol before the single tool: `{ source: "local:<format>", path, sessionId }`. */
export function legacyLocalArgs(source: string, args: Readonly<Record<string, unknown>>): { source: string; id: string } | undefined {
  if (!source.startsWith('local:') || typeof args.path !== 'string' || typeof args.sessionId !== 'string') return undefined
  return { source: LOCAL_REFERENCE_SOURCE, id: chatImportReference({ format: source.slice('local:'.length), path: args.path, sessionId: args.sessionId }) }
}

function toolText(row: LocalDocument['tools'][number]): string {
  const tag = [row.kind, row.name, row.message ? `@${row.message}` : undefined].filter(Boolean).join(' ')
  return `[${tag}] ${row.text}`
}

/** The normalized local session as a reference document: messages, image children and a `tools` text child. */
export function localDoc(document: LocalDocument): ReferenceDoc {
  const children: ReferenceDocChild[] = document.attachments.map((attachment, index) => ({
    key: String(index + 1), title: attachment.name ?? `image ${index + 1}`, kind: 'image' as const,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}), ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.message ? { item: attachment.message } : {}), data: attachment,
  }))
  if (document.tools.length) children.push({ key: 'tools', title: `Tool calls and results (${document.tools.length})`, kind: 'text', content: document.tools.map(row => ({ text: toolText(row) })) })
  return {
    title: document.title || document.sessionId, revision: document.revision, partial: document.partial,
    ...(document.notice ? { notice: document.notice } : {}),
    content: document.messages.map(message => ({ role: message.checkpoint ? 'summary' as const : message.role, text: message.text })),
    children,
  }
}

const samePath = (a: string, b: string) => {
  const left = resolve(a), right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Decode an id and find the readable file it names; fallback locations must hold the same session. */
async function locate(ctx: Context, id: string, signal: AbortSignal): Promise<{ agent: LocalAgent; document: LocalDocument; path: string }> {
  const value = decodeLocalId(id)
  if (!value) throw referenceError('INVALID_ARGS', 'This is not a local session id; copy it from @ guidance, list or search.')
  const format = scanFormat(value.agent)
  assertLocalSourceEnabled(ctx, format)
  const candidates = localCandidates(value, rootsOf(ctx, value.agent))
  if (!candidates) throw referenceError('NOT_FOUND', `The scan location "${value.root ?? 'default'}" of ${value.agent} is no longer configured. Ask the user to restore it or reselect the session.`, 'relist')
  const sessionId = sessionOf(value)
  let lastError: unknown
  for (const path of [...candidates.named, ...candidates.fallback]) {
    signal.throwIfAborted()
    try {
      const document = await loadLocalReference(ctx, undefined, { source: format, path, sessionId }, undefined, signal)
      return { agent: value.agent, document, path }
    } catch (error) {
      signal.throwIfAborted()
      const code = (error as { code?: string }).code
      // Only a missing or different file allows the next location; every other failure is final.
      if (code !== 'NOT_FOUND') throw error
      lastError = error
    }
  }
  throw lastError ?? referenceError('NOT_FOUND', 'The session file no longer exists in its scan location.', 'relist')
}

/** The `local` plugin. */
export function localReferencePlugin(ctx: Context): ReferenceSourcePlugin {
  const service = () => {
    const found = ctx.get('referenceLocalAgents')
    if (!found) throw referenceError('SOURCE_UNAVAILABLE', 'Local Agent discovery is unavailable.')
    return found
  }
  const listing = async (cwd: string, agent: LocalAgent | undefined, signal: AbortSignal) => {
    const directory = await service().referenceDirectory(cwd, agent ? scanFormat(agent) : undefined, signal)
    const rows: Array<{ id: string; title: string; updatedAt?: number; cwd?: string; kind: string }> = []
    const seen = new Set<string>()
    for (const item of directory.items) {
      const id = claimLegacy(ctx, item.ref.id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      rows.push({ id, title: item.label, kind: decodeLocalId(id)!.agent, ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}), ...(item.cwd ? { cwd: item.cwd } : {}) })
    }
    const failed = [...new Set(directory.warnings.map(warning => warning.split(':')[0]!))]
    return { rows, ...(failed.length ? { notice: `Some Agents could not be listed completely: ${failed.join(', ')}.` } : {}) }
  }
  return defineReferenceSource({
    source: LOCAL_SOURCE,
    mentionSources: [LOCAL_REFERENCE_SOURCE],
    usage: 'Local Agent sessions (Codex, Claude Code, Kimi and others). Ids look like codex:2026/11/13/rollout-x.jsonl. list accepts agent to narrow to one Agent. Read an id for its messages; list an id for its images and its tools child (tool calls and results).',
    examples: ['{"source":"local","op":"list","args":{"agent":"codex","query":"cache"}}', '{"source":"local","id":"codex:2026/11/13/rollout-x.jsonl","op":"search","args":{"query":"decided"}}'],
    args: { agent: { type: 'string', description: 'Only this Agent, e.g. codex, claude-code, kimi.', ops: ['list', 'search'] } },
    claim: ref => ref.source === LOCAL_SOURCE ? (decodeLocalId(ref.id) ? ref.id : undefined) : ref.source === LOCAL_REFERENCE_SOURCE ? claimLegacy(ctx, ref.id) : undefined,
    async load(id, signal) { return localDoc((await locate(ctx, id, signal)).document) },
    async check(id) {
      const value = decodeLocalId(id)
      if (!value) throw referenceError('INVALID_ARGS', 'This is not a local session id.')
      assertLocalSourceEnabled(ctx, scanFormat(value.agent))
    },
    async fetch(id, child, maxBytes, signal) {
      const { agent, path, document } = await locate(ctx, id, signal)
      const payload = await embeddedAttachment(ctx, child.data as DocumentAttachment, maxBytes, signal)
      if (!payload) throw referenceError('SOURCE_UNAVAILABLE', 'The image bytes are unavailable in the original session.')
      await assertLocalScope(ctx, { source: scanFormat(agent), path, sessionId: document.sessionId }, signal)
      return payload
    },
    async list(query, args, call) {
      const agent = args.agent
      if (agent !== undefined && (typeof agent !== 'string' || !ALL_LOCAL_AGENTS.includes(agent as LocalAgent))) {
        throw referenceError('INVALID_ARGS', `Unknown agent; use one of ${ALL_LOCAL_AGENTS.join(', ')}.`)
      }
      if (agent) assertLocalSourceEnabled(ctx, scanFormat(agent))
      const { rows, notice } = await listing(call.cwd, agent as LocalAgent | undefined, call.signal)
      const matched = rows.filter(row => !query || row.title.includes(query) || row.id.includes(query))
      const ranked = matched.map(row => ({ row, here: !!row.cwd && inWorkspace(row.cwd, call.cwd) }))
        .sort((a, b) => Number(b.here) - Number(a.here) || (b.row.updatedAt ?? -Infinity) - (a.row.updatedAt ?? -Infinity) || (a.row.id < b.row.id ? -1 : 1))
      return { items: ranked.map(({ row }) => ({ id: row.id, title: row.title, kind: row.kind, ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}) })),
        ...(notice ? { notice } : {}) }
    },
    // D3: a session recorded in the asking session's own working directory needs no @.
    async ungated(id, call) {
      const value = decodeLocalId(id)
      if (!value) return false
      const { rows } = await listing(call.cwd, value.agent, call.signal)
      return rows.some(row => row.id === id && !!row.cwd && samePath(row.cwd, call.cwd))
    },
  })
}

export { encodeLocalId }
