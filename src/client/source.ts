import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatProvider } from '../wire.ts'
import { encodeReferenceUri } from '../uri-codec.ts'
import type { SearchResult, SessionCandidate, WorkspaceEntry } from './remote.ts'
import { PROVIDER_ICON_MARKER } from './provider-icons.tsx'

declare module '@deepseek-ai/dsh-client-ui-input-trigger/client' {
  interface InputTriggerCandidate {
    readonly conversation?: SearchResult
    readonly workspaceEntry?: WorkspaceEntry
    readonly sessionCandidate?: SessionCandidate
    readonly commandName?: string
    readonly skillName?: string
  }
}

const LABEL: Record<ChatProvider, string> = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok',
}
const CONVERSATION_SOURCE = 'External conversations'
const FILE_SOURCE = 'Files and folders'
const SESSION_SOURCE = 'DSH sessions'
const COMMAND_SOURCE = 'Commands'
const SKILL_SOURCE = 'Skills'

type SourceScope = 'commands' | 'skills' | 'files' | 'sessions' | 'conversations'
const PREFIX_SCOPE: Readonly<Record<string, SourceScope>> = {
  command: 'commands', commands: 'commands', cmd: 'commands',
  skill: 'skills', skills: 'skills',
  file: 'files', files: 'files', folder: 'files', folders: 'files', path: 'files',
  session: 'sessions', sessions: 'sessions', dsh: 'sessions',
  chat: 'conversations', conversation: 'conversations', conversations: 'conversations',
  chatgpt: 'conversations', claude: 'conversations', gemini: 'conversations', deepseek: 'conversations', grok: 'conversations',
}

interface ConversationReference {
  uriId: string
  label: string
}

function encodeConversationReference(reference: ConversationReference): string {
  return JSON.stringify(reference)
}

function decodeConversationReference(value: string): ConversationReference {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== 'object') throw new Error('invalid conversation reference')
  const { uriId, label } = parsed as { uriId?: unknown; label?: unknown }
  if (typeof uriId !== 'string' || typeof label !== 'string') throw new Error('invalid conversation reference')
  return { uriId, label }
}

function formatConversationMention(reference: ConversationReference): string {
  return `@[${reference.label}](${conversationReferenceUri(reference.uriId)})`
}

export function createConversationSource(search: (
  query: string, provider: ChatProvider | undefined, signal: AbortSignal,
) => Promise<readonly SearchResult[]>): InputTriggerSource {
  return {
    trigger: '@', name: CONVERSATION_SOURCE, order: 30,
    async candidates(_session, { query, signal }) {
      const scoped = scopedQuery(query, 'conversations')
      if (scoped === undefined) return []
      const parsed = parseQuery(query)
      if (parsed.provider === undefined && scoped !== query.trim()) parsed.query = scoped
      const rows = await search(parsed.query, parsed.provider, signal)
      return rows.map((row): InputTriggerCandidate => ({
        name: row.title,
        description: `${LABEL[row.provider]} · ${row.turnCount} turns · ${formatDate(row.updatedAt)}${row.partial ? ' · partial' : ''}`,
        icon: PROVIDER_ICON_MARKER[row.provider], conversation: row,
      }))
    },
    onPick({ candidate }) {
      const row = candidate.conversation
      if (!row) return undefined
      const title = `${LABEL[row.provider]} · ${row.title}`.replace(/[\[\]]/g, '')
      const reference = { uriId: row.uriId, label: title }
      return {
        insert: {
          source: CONVERSATION_SOURCE,
          ref: encodeConversationReference(reference),
          // The input's object replacement chip keeps the transport URI out
          // of the textarea while retaining a compact, recognizable label.
          label: `${PROVIDER_ICON_MARKER[row.provider]} ${title}`,
          clipboardText: formatConversationMention(reference),
        },
      }
    },
    codec: {
      clipboardText(ref) { return formatConversationMention(decodeConversationReference(ref)) },
      serialize(ref) { return Promise.resolve(formatConversationMention(decodeConversationReference(ref))) },
    },
  }
}

export function createWorkspaceSource(load: (sessionId: string, signal: AbortSignal) => Promise<readonly WorkspaceEntry[]>): InputTriggerSource {
  const cache = new Map<string, readonly WorkspaceEntry[]>()
  return {
    trigger: '@', name: FILE_SOURCE, order: 10,
    async candidates(session, { query, signal }) {
      const scoped = scopedQuery(query, 'files')
      if (scoped === undefined) return []
      let entries = cache.get(session.sessionId)
      if (!entries) { entries = await load(session.sessionId, signal); cache.set(session.sessionId, entries) }
      const needle = scoped.toLocaleLowerCase()
      return entries.filter(row => row.path.toLocaleLowerCase().includes(needle)).sort((a, b) => rankPath(a.path, needle) - rankPath(b.path, needle) || a.path.localeCompare(b.path)).slice(0, 12).map(row => ({
        name: row.path.split('/').at(-1) ?? row.path,
        description: row.path,
        icon: row.kind === 'directory' ? '📁' : '📄',
        workspaceEntry: row,
      }))
    },
    onPick({ candidate }) {
      const row = candidate.workspaceEntry
      if (!row) return undefined
      const label = row.path.split('/').at(-1) ?? row.path
      const ref = JSON.stringify({ path: row.path, label })
      return { insert: { source: FILE_SOURCE, ref, label: `${row.kind === 'directory' ? '📁' : '📄'} ${label}`, clipboardText: workspaceMention(ref) } }
    },
    codec: { clipboardText: workspaceMention, serialize: ref => Promise.resolve(workspaceMention(ref)) },
  }
}

export function createSessionSource(search: (sessionId: string, query: string, signal: AbortSignal) => Promise<readonly SessionCandidate[]>): InputTriggerSource {
  return {
    trigger: '@', name: SESSION_SOURCE, order: 20,
    async candidates(session, { query, signal }) {
      const scoped = scopedQuery(query, 'sessions')
      if (scoped === undefined) return []
      return (await search(session.sessionId, scoped, signal)).map(row => ({
        name: row.label, description: row.cwd ?? new Date(row.createdAt).toLocaleString(), icon: '💬', sessionCandidate: row,
      }))
    },
    onPick({ candidate }) {
      const row = candidate.sessionCandidate
      if (!row) return undefined
      const ref = JSON.stringify({ uri: row.sessionId, label: row.label })
      return { insert: { source: SESSION_SOURCE, ref, label: `💬 ${row.label}`, clipboardText: sessionMention(ref) } }
    },
    codec: { clipboardText: sessionMention, serialize: ref => Promise.resolve(sessionMention(ref)) },
  }
}

interface CommandCandidate { name: string; description?: string; input?: { hint?: string } }
interface SkillCandidate { name: string; description: string; modelInvocable?: boolean }

export function createCommandSource(load: (sessionId: SessionId, signal: AbortSignal) => Promise<readonly CommandCandidate[]>): InputTriggerSource {
  return {
    trigger: '@', name: COMMAND_SOURCE, order: 0,
    async candidates(session, { query, position, signal }) {
      if (position !== 'leading') return []
      const scoped = scopedQuery(query, 'commands')
      if (scoped === undefined) return []
      const needle = scoped.toLocaleLowerCase()
      return (await load(session.sessionId, signal))
        .filter(row => row.name.toLocaleLowerCase().includes(needle))
        .map(row => ({ name: row.name, description: row.description, hint: row.input?.hint, icon: '⌘', commandName: row.name }))
    },
    onPick({ candidate }) { return candidate.commandName ? { text: `/${candidate.commandName} ` } : undefined },
  }
}

export function createSkillSource(load: (sessionId: SessionId, signal: AbortSignal) => Promise<readonly SkillCandidate[]>): InputTriggerSource {
  const cache = new Map<string, readonly SkillCandidate[]>()
  return {
    trigger: '@', name: SKILL_SOURCE, order: 5,
    async candidates(session, { query, position, signal }) {
      if (position !== 'leading') return []
      const scoped = scopedQuery(query, 'skills')
      if (scoped === undefined) return []
      let rows = cache.get(session.sessionId)
      if (!rows) { rows = await load(session.sessionId, signal); cache.set(session.sessionId, rows) }
      const needle = scoped.toLocaleLowerCase()
      return rows.filter(row => row.name.toLocaleLowerCase().includes(needle)).map(row => ({
        name: row.name,
        description: `${row.modelInvocable === false ? 'user-only · ' : ''}${row.description}`,
        icon: '✦',
        skillName: row.name,
      }))
    },
    onPick({ candidate }) { return candidate.skillName ? { text: `/${candidate.skillName} ` } : undefined },
  }
}

function workspaceMention(ref: string): string {
  const value = JSON.parse(ref) as { path: string; label: string }
  const uri = `dsh-file:${base64Url(JSON.stringify(value.path))}`
  return `@[${escapeLabel(value.label)}](${uri})`
}

function sessionMention(ref: string): string {
  const value = JSON.parse(ref) as { uri: string; label: string }
  return `@[${escapeLabel(value.label)}](${value.uri})`
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function escapeLabel(value: string): string { return value.replace(/[\\\]]/gu, match => `\\${match}`) }
function rankPath(path: string, needle: string): number {
  if (!needle) return path.split('/').length
  const lower = path.toLocaleLowerCase(); const name = lower.split('/').at(-1) ?? lower
  return name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : lower.startsWith(needle) ? 3 : 4
}

export function conversationReferenceUri(uriId: string): string {
  return encodeReferenceUri({ source: 'web-chat', id: uriId })
}

export function parseQuery(value: string): { query: string; provider?: ChatProvider } {
  const match = value.trim().match(/^(chatgpt|claude|gemini|deepseek|grok)(?::|\s+|$)(.*)$/i)
  return match ? { provider: match[1]!.toLowerCase() as ChatProvider, query: (match[2] || '').trim() } : { query: value.trim() }
}

/** Route `type:name` autocomplete syntax to one @ source and strip its prefix. */
export function scopedQuery(value: string, scope: SourceScope): string | undefined {
  const trimmed = value.trim()
  const match = trimmed.match(/^([a-z-]+):(.*)$/iu)
  if (!match) return trimmed
  const requested = PREFIX_SCOPE[match[1]!.toLocaleLowerCase()]
  if (requested === undefined) return trimmed
  return requested === scope ? (match[2] ?? '').trim() : undefined
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleDateString()
}
