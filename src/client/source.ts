import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatProvider, InputRenderMode } from '../wire.ts'
import { parseProviderQuery } from '../search.ts'
import { encodeReferenceUri } from '../uri-codec.ts'
import type { SearchResult, SessionCandidate, WorkspaceEntry } from './remote.ts'
import {
  COMMAND_ICON_MARKER, PICKER_ICON_MARKER, PROVIDER_ICON_MARKER, SESSION_ICON_MARKER, SKILL_ICON_MARKER,
  type PickerIconKind,
} from './provider-icons.tsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { REFERENCE_ANYTHING_NS } from './locale.ts'

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
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok', kimi: 'Kimi',
}
type T = TranslateNS<typeof REFERENCE_ANYTHING_NS>

// DSH persists this name on every selected chip and resolves its codec by the
// same value later. It is therefore an identifier, not a translatable label.
export const CONVERSATION_SOURCE = 'External conversations'
export const FILE_SOURCE = 'Files and folders'
export const SESSION_SOURCE = 'DSH sessions'
export const COMMAND_SOURCE = 'Commands'
export const SKILL_SOURCE = 'Skills'

type WorkspaceIconKind = Extract<PickerIconKind,
  'folder' | 'file' | 'image' | 'text' | 'code' | 'data' | 'archive' |
  'spreadsheet' | 'audio' | 'video' | 'presentation' | 'font'>

const WORKSPACE_EXTENSION_KIND: Readonly<Partial<Record<string, WorkspaceIconKind>>> = Object.freeze({
  // Image
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image',
  bmp: 'image', ico: 'image', tif: 'image', tiff: 'image', heic: 'image', heif: 'image',
  // Plain text and document-like files
  txt: 'text', md: 'text', mdx: 'text', rtf: 'text', log: 'text', tex: 'text', pdf: 'text',
  doc: 'text', docx: 'text', odt: 'text', epub: 'text',
  // Source code
  js: 'code', jsx: 'code', ts: 'code', tsx: 'code', mjs: 'code', cjs: 'code', html: 'code', htm: 'code',
  css: 'code', scss: 'code', sass: 'code', less: 'code', vue: 'code', svelte: 'code', astro: 'code',
  py: 'code', rb: 'code', php: 'code', java: 'code', kt: 'code', kts: 'code', c: 'code', h: 'code',
  cpp: 'code', hpp: 'code', cc: 'code', cs: 'code', go: 'code', rs: 'code', swift: 'code',
  sh: 'code', bash: 'code', zsh: 'code', fish: 'code', ps1: 'code', bat: 'code', cmd: 'code',
  sql: 'code', proto: 'code', graphql: 'code', gql: 'code', lua: 'code', r: 'code', scala: 'code',
  dart: 'code', ex: 'code', exs: 'code', erl: 'code', hrl: 'code', fs: 'code', fsx: 'code', vb: 'code', ipynb: 'code',
  // Structured/config data
  json: 'data', jsonc: 'data', yaml: 'data', yml: 'data', toml: 'data', xml: 'data', ini: 'data',
  cfg: 'data', conf: 'data', properties: 'data', env: 'data', lock: 'data',
  // Archives and packages
  zip: 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive', '7z': 'archive',
  rar: 'archive', tgz: 'archive', deb: 'archive', rpm: 'archive', apk: 'archive',
  // Tables
  csv: 'spreadsheet', tsv: 'spreadsheet', xls: 'spreadsheet', xlsx: 'spreadsheet', xlsm: 'spreadsheet',
  ods: 'spreadsheet', numbers: 'spreadsheet',
  // Audio/video
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', opus: 'audio',
  wma: 'audio', aiff: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video', wmv: 'video', m4v: 'video',
  mpeg: 'video', mpg: 'video',
  // Slide decks and fonts
  ppt: 'presentation', pptx: 'presentation', odp: 'presentation', key: 'presentation',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
})

const EXTENSIONLESS_WORKSPACE_KIND: Readonly<Record<string, WorkspaceIconKind>> = Object.freeze({
  readme: 'text', license: 'text', notice: 'text', changelog: 'text',
  dockerfile: 'code', makefile: 'code', justfile: 'code', 'cmakelists.txt': 'code',
  '.gitignore': 'data', '.gitattributes': 'data', '.editorconfig': 'data', '.npmrc': 'data', '.env': 'data',
})

/** Classify from the already-listed path only; this never stats or reads the file. */
export function workspaceIconKind(row: WorkspaceEntry): WorkspaceIconKind {
  if (row.kind === 'directory') return 'folder'
  const basename = row.path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  const named = EXTENSIONLESS_WORKSPACE_KIND[basename]
  if (named !== undefined) return named
  const dot = basename.lastIndexOf('.')
  const extension = dot >= 0 ? basename.slice(dot + 1) : ''
  return WORKSPACE_EXTENSION_KIND[extension] ?? 'file'
}

type SourceScope = 'commands' | 'skills' | 'files' | 'sessions' | 'conversations'
export interface PickerSourceOptions { order: number; limit: number; renderMode?: InputRenderMode }
/** Wait briefly for a pause in typing before issuing a live search. */
const SEARCH_DEBOUNCE_MS = 100
const PREFIX_SCOPE: Readonly<Record<string, SourceScope>> = {
  command: 'commands', commands: 'commands', cmd: 'commands',
  skill: 'skills', skills: 'skills',
  file: 'files', files: 'files', folder: 'files', folders: 'files', path: 'files',
  session: 'sessions', sessions: 'sessions', dsh: 'sessions',
  chat: 'conversations', conversation: 'conversations', conversations: 'conversations',
  '外部对话': 'conversations', '外部对话记录': 'conversations',
  chatgpt: 'conversations', claude: 'conversations', gemini: 'conversations', deepseek: 'conversations', grok: 'conversations', kimi: 'conversations',
}

/**
 * Debounce a query-driven fetch without retaining any previous results.
 *
 * A new keystroke aborts the caller's signal, so the superseded fetch never
 * starts. Every completed search always reaches the Host for live results.
 */
export interface SearchDebounce<V> {
  run(query: string, signal: AbortSignal, fetch: () => Promise<readonly V[]>): Promise<readonly V[]>
}

export function createSearchDebounce<V>(): SearchDebounce<V> {
  return {
    async run(query, signal, fetch) {
      if (query.trim() && !await settle(SEARCH_DEBOUNCE_MS, signal)) return []
      return fetch()
    },
  }
}

function settle(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const onAbort = (): void => { clearTimeout(timer); resolve(false) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true) }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
  query: string, provider: ChatProvider | undefined, signal: AbortSignal, limit: number,
) => Promise<readonly SearchResult[]>, t: T = fallback, options: PickerSourceOptions = { order: 30, limit: 6 }): InputTriggerSource {
  return {
    trigger: '@', name: CONVERSATION_SOURCE, order: options.order,
    async candidates(_session, { query, signal }) {
      const scoped = scopedQuery(query, 'conversations')
      if (scoped === undefined) return []
      const parsed = parseQuery(query)
      if (parsed.provider === undefined && scoped !== query.trim()) parsed.query = scoped
      const rows = await search(parsed.query, parsed.provider, signal, 50)
      return disambiguate(rows.map((row): InputTriggerCandidate => ({
        name: row.title.trim() || 'Untitled',
        description: row.matchedVia === 'content' && row.snippet
          ? row.snippet
          : t('conversation.description', { provider: LABEL[row.provider], date: formatDate(row.updatedAt, t) }),
        icon: PROVIDER_ICON_MARKER[row.provider], conversation: row,
      })))
    },
    onPick({ candidate }) {
      const row = candidate.conversation
      if (!row) return undefined
      // Keep the provider separator adjacent and outside DSH's `@name`
      // character class. A spaced label such as `@Grok · Title` is otherwise
      // projected by the user-bubble renderer as a native `@Grok` pill.
      const title = `${LABEL[row.provider]}·${row.title}`.replace(/[\[\]]/g, '')
      const reference = { uriId: row.uriId, label: title }
      if (options.renderMode === 'raw-text') return { text: formatConversationMention(reference) }
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

export function createWorkspaceSource(load: (sessionId: string, signal: AbortSignal) => Promise<readonly WorkspaceEntry[]>, t: T = fallback, options: PickerSourceOptions = { order: 10, limit: 6 }): InputTriggerSource {
  return {
    trigger: '@', name: FILE_SOURCE, order: options.order,
    async candidates(session, { query, signal }) {
      const scoped = scopedQuery(query, 'files')
      if (scoped === undefined) return []
      const entries = await load(session.sessionId, signal)
      const needle = scoped.toLocaleLowerCase()
      return entries.filter(row => row.path.toLocaleLowerCase().includes(needle)).sort((a, b) => rankPath(a.path, needle) - rankPath(b.path, needle) || a.path.localeCompare(b.path)).slice(0, 50).map(row => {
        const iconKind = workspaceIconKind(row)
        return {
          name: row.path.split('/').at(-1) ?? row.path,
          description: row.path,
          icon: PICKER_ICON_MARKER[iconKind],
          workspaceEntry: row,
        }
      })
    },
    onPick({ candidate }) {
      const row = candidate.workspaceEntry
      if (!row) return undefined
      // A basename alone makes two selected files such as src/index.ts and
      // tests/index.ts indistinguishable once their mentions are rendered to
      // the model. Keep the workspace-relative path as the visible label.
      const label = row.path
      const ref = JSON.stringify({ path: row.path, label })
      if (options.renderMode === 'raw-text') return { text: workspaceMention(ref) }
      return { insert: { source: FILE_SOURCE, ref, label: `${PICKER_ICON_MARKER[workspaceIconKind(row)]} ${label}`, clipboardText: workspaceMention(ref) } }
    },
    codec: { clipboardText: workspaceMention, serialize: ref => Promise.resolve(workspaceMention(ref)) },
  }
}

export function createSessionSource(search: (sessionId: string, query: string, signal: AbortSignal) => Promise<readonly SessionCandidate[]>, t: T = fallback, options: PickerSourceOptions = { order: 20, limit: 6 }): InputTriggerSource {
  return {
    trigger: '@', name: SESSION_SOURCE, order: options.order,
    async candidates(session, { query, signal }) {
      const scoped = scopedQuery(query, 'sessions')
      if (scoped === undefined) return []
      return (await search(session.sessionId, scoped, signal)).slice(0, 50).map(row => ({
        name: row.label, description: row.cwd ?? new Date(row.createdAt).toLocaleString(), icon: SESSION_ICON_MARKER, sessionCandidate: row,
      }))
    },
    onPick({ candidate }) {
      const row = candidate.sessionCandidate
      if (!row) return undefined
      const ref = JSON.stringify({ uri: row.sessionId, label: row.label })
      if (options.renderMode === 'raw-text') return { text: sessionMention(ref) }
      return { insert: { source: SESSION_SOURCE, ref, label: `${SESSION_ICON_MARKER} ${row.label}`, clipboardText: sessionMention(ref) } }
    },
    codec: { clipboardText: sessionMention, serialize: ref => Promise.resolve(sessionMention(ref)) },
  }
}

interface CommandCandidate { name: string; description?: string; input?: { hint?: string } }
interface SkillCandidate { name: string; description: string; modelInvocable?: boolean }

export function createCommandSource(load: (sessionId: SessionId, signal: AbortSignal) => Promise<readonly CommandCandidate[]>, t: T = fallback, options: PickerSourceOptions = { order: 0, limit: 6 }): InputTriggerSource {
  return {
    trigger: '@', name: COMMAND_SOURCE, order: options.order,
    async candidates(session, { query, signal }) {
      const scoped = scopedQuery(query, 'commands')
      if (scoped === undefined) return []
      const needle = scoped.toLocaleLowerCase()
      return (await load(session.sessionId, signal))
        .filter(row => row.name.toLocaleLowerCase().includes(needle))
        .slice(0, 50).map(row => ({ name: row.name, description: row.description, hint: row.input?.hint, icon: COMMAND_ICON_MARKER, commandName: row.name }))
    },
    onPick({ candidate }) { return candidate.commandName ? { text: `/${candidate.commandName}` } : undefined },
  }
}

export function createSkillSource(load: (sessionId: SessionId, signal: AbortSignal) => Promise<readonly SkillCandidate[]>, t: T = fallback, options: PickerSourceOptions = { order: 5, limit: 6 }): InputTriggerSource {
  return {
    trigger: '@', name: SKILL_SOURCE, order: options.order,
    async candidates(session, { query, signal }) {
      const scoped = scopedQuery(query, 'skills')
      if (scoped === undefined) return []
      const rows = await load(session.sessionId, signal)
      const needle = scoped.toLocaleLowerCase()
      return rows.filter(row => row.name.toLocaleLowerCase().includes(needle)).slice(0, 50).map(row => ({
        name: row.name,
        description: `${row.modelInvocable === false ? t('skill.userOnly') : ''}${row.description}`,
        icon: SKILL_ICON_MARKER,
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

/**
 * Split a leading provider scope off a menu query.
 *
 * Delegates to the Host's own parser so both ends agree on what counts as a
 * prefix — including the `:` and `/` separators that survive `@` token
 * detection, and short spellings like `gpt:` and `ds:`.
 */
export function parseQuery(value: string): { query: string; provider?: ChatProvider } {
  return parseProviderQuery(value)
}

/**
 * The dimmed trailing line of one menu row.
 *
 * A body hit appends its excerpt after the updated date: when the title did
 * not match, the excerpt is the only thing on the row that explains why it is
 * there.
 */
export function describeRow(row: SearchResult): string {
  const parts = [LABEL[row.provider], formatDate(row.updatedAt, fallback)]
  if (row.matchedVia === 'content' && row.snippet) parts.push(row.snippet)
  return parts.join(' · ')
}

/**
 * Suffix repeated names so each row in a batch is uniquely named.
 *
 * Providers leave many conversations titled "New chat", and the menu keys its
 * rows by `source:name` — identical names collide there.
 * @param rows - candidates in display order.
 * @returns the same rows, with the 2nd and later duplicate of a name numbered.
 */
export function disambiguate(rows: readonly InputTriggerCandidate[]): InputTriggerCandidate[] {
  const taken = new Set<string>()
  return rows.map((row) => {
    if (!taken.has(row.name)) { taken.add(row.name); return row }
    // Counting up rather than counting occurrences: a conversation genuinely
    // titled "New chat (2)" must not collide with a generated suffix.
    let ordinal = 2
    while (taken.has(`${row.name} (${ordinal})`)) ordinal++
    const name = `${row.name} (${ordinal})`
    taken.add(name)
    return { ...row, name }
  })
}

/** Route `type:name` autocomplete syntax to one @ source and strip its prefix. */
export function scopedQuery(value: string, scope: SourceScope): string | undefined {
  const trimmed = value.trim()
  // Accept the group name itself as a shortcut for an empty scoped query.
  // Without this, typing `@commands` searches command names for the literal
  // word "commands", so the documented group appears empty unless a colon is
  // added. Keep the `type:name` form for filtering within a group.
  const bareScope = PREFIX_SCOPE[trimmed.toLocaleLowerCase()]
  if (bareScope !== undefined) return bareScope === scope ? '' : undefined
  const match = trimmed.match(/^([a-z-]+):(.*)$/iu)
  if (!match) return trimmed
  const requested = PREFIX_SCOPE[match[1]!.toLocaleLowerCase()]
  if (requested === undefined) return trimmed
  return requested === scope ? (match[2] ?? '').trim() : undefined
}

function formatDate(value: string, t: T): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? t('conversation.unknownDate') : date.toLocaleString(undefined, {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

const fallback: T = (key, params) => {
  const dictionary: Record<string, string> = {
    'source.conversations': 'External conversations', 'source.files': 'Files and folders', 'source.sessions': 'DSH sessions', 'source.commands': 'Commands', 'source.skills': 'Skills',
    'conversation.description': '{provider} · {date}', 'conversation.unknownDate': 'unknown date', 'skill.userOnly': 'user-only · ',
  }
  return (dictionary[key] ?? key).replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params![name]) : match)
}
