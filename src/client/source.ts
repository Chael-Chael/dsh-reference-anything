import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import type {
  CandidateRequest, ClientSessionContext, InputTriggerCandidate, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { ChatProvider, PickerDisplayMode } from '../wire.ts'
import { parseProviderQuery } from '../search.ts'
import { encodeReferenceUri } from '../uri-codec.ts'
import type { AgentCandidate, DriveCandidate, SearchResult, SyncStatus } from './remote.ts'
import {
  AGENT_ICON_MARKER, COMMAND_ICON_MARKER, DRIVE_ICON_MARKER, PICKER_ICON_MARKER, PROVIDER_ICON_MARKER, SESSION_ICON_MARKER, SKILL_ICON_MARKER,
  type PickerIconKind,
} from './provider-icons.tsx'
import type { REFERENCE_ANYTHING_NS } from './locale.ts'
import type { MenuViewportAnchor, PickerMenuActionGuard, PickerMenuUpdater } from './menu-update.ts'

const LABEL: Record<ChatProvider, string> = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok', kimi: 'Kimi',
}
type T = TranslateNS<typeof REFERENCE_ANYTHING_NS>

// DSH persists this name on every selected occurrence and resolves its codec
// by the same value later. These are stable identifiers, not translated UI.
export const CONVERSATION_SOURCE = 'External conversations'
export const FILE_SOURCE = 'Files and folders'
export const SESSION_SOURCE = 'DSH sessions'
export const AGENT_SOURCE = 'Local agent conversations'
export const DRIVE_SOURCE = 'Cloud drive files'
export const COMMAND_SOURCE = 'Commands'
export const SKILL_SOURCE = 'Skills'

type WorkspaceIconKind = Extract<PickerIconKind,
  'folder' | 'file' | 'image' | 'text' | 'code' | 'data' | 'archive' |
  'spreadsheet' | 'audio' | 'video' | 'presentation' | 'font'>

const WORKSPACE_EXTENSION_KIND: Readonly<Partial<Record<string, WorkspaceIconKind>>> = Object.freeze({
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image',
  bmp: 'image', ico: 'image', tif: 'image', tiff: 'image', heic: 'image', heif: 'image',
  txt: 'text', md: 'text', mdx: 'text', rtf: 'text', log: 'text', tex: 'text', pdf: 'text',
  doc: 'text', docx: 'text', odt: 'text', epub: 'text',
  js: 'code', jsx: 'code', ts: 'code', tsx: 'code', mjs: 'code', cjs: 'code', html: 'code', htm: 'code',
  css: 'code', scss: 'code', sass: 'code', less: 'code', vue: 'code', svelte: 'code', astro: 'code',
  py: 'code', rb: 'code', php: 'code', java: 'code', kt: 'code', kts: 'code', c: 'code', h: 'code',
  cpp: 'code', hpp: 'code', cc: 'code', cs: 'code', go: 'code', rs: 'code', swift: 'code',
  sh: 'code', bash: 'code', zsh: 'code', fish: 'code', ps1: 'code', bat: 'code', cmd: 'code',
  sql: 'code', proto: 'code', graphql: 'code', gql: 'code', lua: 'code', r: 'code', scala: 'code',
  dart: 'code', ex: 'code', exs: 'code', erl: 'code', hrl: 'code', fs: 'code', fsx: 'code', vb: 'code', ipynb: 'code',
  json: 'data', jsonc: 'data', yaml: 'data', yml: 'data', toml: 'data', xml: 'data', ini: 'data',
  cfg: 'data', conf: 'data', properties: 'data', env: 'data', lock: 'data',
  zip: 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive', '7z': 'archive',
  rar: 'archive', tgz: 'archive', deb: 'archive', rpm: 'archive', apk: 'archive',
  csv: 'spreadsheet', tsv: 'spreadsheet', xls: 'spreadsheet', xlsx: 'spreadsheet', xlsm: 'spreadsheet',
  ods: 'spreadsheet', numbers: 'spreadsheet',
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', opus: 'audio',
  wma: 'audio', aiff: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video', wmv: 'video', m4v: 'video',
  mpeg: 'video', mpg: 'video',
  ppt: 'presentation', pptx: 'presentation', odp: 'presentation', key: 'presentation',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
})

const EXTENSIONLESS_WORKSPACE_KIND: Readonly<Record<string, WorkspaceIconKind>> = Object.freeze({
  readme: 'text', license: 'text', notice: 'text', changelog: 'text',
  dockerfile: 'code', makefile: 'code', justfile: 'code', 'cmakelists.txt': 'code',
  '.gitignore': 'data', '.gitattributes': 'data', '.editorconfig': 'data', '.npmrc': 'data', '.env': 'data',
})

/** Classify from the already-listed path only; this never stats or reads the file. */
export function workspaceIconKind(row: FileReferenceCandidate): WorkspaceIconKind {
  return workspacePathIconKind(row.path, row.kind)
}

/** Share the picker's file-type classification with already-inserted chips. */
export function workspacePathIconKind(path: string, kind: FileReferenceCandidate['kind']): WorkspaceIconKind {
  if (kind === 'directory') return 'folder'
  const basename = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  const named = EXTENSIONLESS_WORKSPACE_KIND[basename]
  if (named !== undefined) return named
  const dot = basename.lastIndexOf('.')
  const extension = dot >= 0 ? basename.slice(dot + 1) : ''
  return WORKSPACE_EXTENSION_KIND[extension] ?? 'file'
}

type SourceScope = 'commands' | 'skills' | 'files' | 'sessions' | 'agents' | 'conversations' | 'drives'
export interface PickerSourceOptions {
  order: number
  /** Rows shown before the source-owned expand action. */
  limit: number
  /** Hard cap applied before presentation controls are appended. */
  maxCandidates: number
  displayMode: PickerDisplayMode
  /** Replaces one cached source group without re-tracking the Composer input. */
  updateMenu?: PickerMenuUpdater
  /** Prevents native handled picks for this source from unmounting the menu. */
  guardMenuActions?: PickerMenuActionGuard
}

export interface RefreshablePickerSource extends InputTriggerSource {
  /** Re-publish cached menus, optionally refreshing their backing candidates first. */
  refreshCachedMenu(options?: { refetch?: boolean }): Promise<void>
}

export interface ConversationSourceActions {
  sync(): Promise<void> | void
  status(): SyncStatus | undefined
  lastSyncedAt(): string | undefined
  lastSourceResult(): { success: number; total: number } | undefined
}

const DEFAULT_SOURCE_OPTIONS: PickerSourceOptions = {
  order: 0, limit: 6, maxCandidates: 50, displayMode: 'collapse',
}

/** Wait briefly for a pause in typing before issuing a live search. */
const SEARCH_DEBOUNCE_MS = 100
const DISPLAY_EXPANSION_STEP = 5
const PREFIX_SCOPE: Readonly<Record<string, SourceScope>> = {
  command: 'commands', commands: 'commands', cmd: 'commands',
  skill: 'skills', skills: 'skills',
  file: 'files', files: 'files', folder: 'files', folders: 'files', path: 'files',
  session: 'sessions', sessions: 'sessions', dsh: 'sessions',
  // Bare `claude`, `gemini`, `grok`, and `kimi` stay with External
  // conversations below, because those are the browser platforms a person
  // means by the bare word; only the qualified CLI names route to the on-disk
  // transcripts of the same brand.
  agent: 'agents', agents: 'agents', transcript: 'agents', transcripts: 'agents',
  cc: 'agents', 'claude-code': 'agents', codex: 'agents', cursor: 'agents', 'gemini-cli': 'agents',
  qoder: 'agents', reasonix: 'agents', openclaw: 'agents', hermes: 'agents', pi: 'agents',
  grokbuild: 'agents', 'grok-build': 'agents', 'kimi-cli': 'agents', 'kimi-code': 'agents',
  opencode: 'agents', mimocode: 'agents', mimo: 'agents', zcode: 'agents',
  '本地对话': 'agents', '本地记录': 'agents',
  chat: 'conversations', conversation: 'conversations', conversations: 'conversations',
  '外部对话': 'conversations', '外部对话记录': 'conversations',
  chatgpt: 'conversations', claude: 'conversations', gemini: 'conversations', deepseek: 'conversations', grok: 'conversations', kimi: 'conversations',
  // `file`/`files` above already belong to the workspace, so a drive needs
  // its own words. The bare CJK ones only reach the map through the
  // no-colon branch of `scopedQuery` — its prefix pattern is ASCII.
  drive: 'drives', drives: 'drives', cloud: 'drives', netdisk: 'drives', openlist: 'drives',
  '网盘': 'drives',
}

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

interface ConversationReference { uriId: string; label: string }
interface AgentReference { id: string; label: string }
interface DriveReference { id: string; label: string }

type CandidateValue =
  | { kind: 'conversation'; reference: ConversationReference }
  | { kind: 'file'; fileKind: FileReferenceCandidate['kind']; label: string; mention: string }
  | { kind: 'session'; label: string; mention: string }
  | { kind: 'agent'; reference: AgentReference }
  | { kind: 'drive'; reference: DriveReference }
  | { kind: 'drive-search' }
  | { kind: 'drive-folder'; path: string }
  | { kind: 'command'; name: string }
  | { kind: 'skill'; name: string }
  | { kind: 'action'; action: 'sync' | 'expand' | 'collapse'; query?: string }

function encodeCandidate(value: CandidateValue): string { return JSON.stringify(value) }
function decodeCandidate(value: string | undefined): CandidateValue | undefined {
  if (value === undefined) return undefined
  try { return JSON.parse(value) as CandidateValue } catch { return undefined }
}

function encodeConversationReference(reference: ConversationReference): string { return JSON.stringify(reference) }
function decodeConversationReference(value: string): ConversationReference {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== 'object') throw new Error('invalid conversation reference')
  const { uriId, label } = parsed as { uriId?: unknown; label?: unknown }
  if (typeof uriId !== 'string' || typeof label !== 'string') throw new Error('invalid conversation reference')
  return { uriId, label }
}
function formatConversationMention(reference: ConversationReference): string {
  return `@[${escapeLabel(reference.label)}](${conversationReferenceUri(reference.uriId)})`
}

export function createConversationSource(
  search: (query: string, provider: ChatProvider | undefined, signal: AbortSignal, limit: number) => Promise<readonly SearchResult[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 30 },
  actions?: ConversationSourceActions,
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: CONVERSATION_SOURCE, order: options.order,
    async candidates(_session, { query, quoted, signal }) {
      if (quoted === true) return []
      const scoped = scopedQuery(query, 'conversations')
      if (scoped === undefined) return []
      const parsed = parseQuery(query)
      if (parsed.provider === undefined && scoped !== query.trim()) parsed.query = scoped
      const rows = await search(parsed.query, parsed.provider, signal, options.maxCandidates)
      const candidates = disambiguate(rows.map((row): InputTriggerCandidate => {
        const title = row.title.trim() || 'Untitled'
        const label = `${LABEL[row.provider]}·${title}`.replace(/[\[\]]/gu, '')
        return {
          name: title,
          description: row.matchedVia === 'content' && row.snippet
            ? row.snippet
            : t('conversation.description', { provider: LABEL[row.provider], date: formatDate(row.updatedAt, t) }),
          icon: PROVIDER_ICON_MARKER[row.provider],
          value: encodeCandidate({ kind: 'conversation', reference: { uriId: row.uriId, label } }),
        }
      }))
      if (query.trim() || actions === undefined) return candidates
      return [syncMenuCandidate(actions, t), ...candidates]
    },
    onPick({ candidate }) {
      const value = decodeCandidate(candidate.value)
      if (value?.kind === 'action' && value.action === 'sync') {
        if (actions?.status()?.status !== 'running') void actions?.sync()
        return 'handled'
      }
      if (value?.kind !== 'conversation') return undefined
      const reference = value.reference
      return {
        insert: {
          source: CONVERSATION_SOURCE,
          ref: encodeConversationReference(reference),
          label: reference.label,
          appearance: 'session',
          clipboardText: formatConversationMention(reference),
        },
      }
    },
    codec: {
      clipboardText: ref => formatConversationMention(decodeConversationReference(ref)),
      serialize: ref => Promise.resolve(formatConversationMention(decodeConversationReference(ref))),
    },
  }
  return withDisplayPolicy(source, options, t, candidate => isSyncAction(candidate) && actions !== undefined
    ? syncMenuCandidate(actions, t)
    : candidate)
}

function syncMenuCandidate(actions: ConversationSourceActions, t: T): InputTriggerCandidate {
  const presentation = syncMenuPresentation(actions.status(), actions.lastSyncedAt(), actions.lastSourceResult(), t)
  return {
    name: presentation.name,
    description: presentation.description,
    icon: PICKER_ICON_MARKER.refresh,
    value: encodeCandidate({ kind: 'action', action: 'sync' }),
  }
}

function syncMenuPresentation(sync: SyncStatus | undefined, lastSyncedAt: string | undefined, savedResult: { success: number; total: number } | undefined, t: T): { name: string; description: string } {
  if (sync?.status === 'running') {
    const listing = sync.providerProgress.filter(row => row.phase === 'listing').length
    const listed = sync.providerProgress.length - listing
    return listing > 0
      ? { name: t('menu.syncListingProgress', { completed: listed, total: sync.providerProgress.length }), description: t('menu.syncRunningDetail') }
      : { name: t('menu.syncProgress', { completed: sync.completed, total: sync.total }), description: t('menu.syncRunningDetail') }
  }
  if (sync !== undefined || lastSyncedAt !== undefined) {
    const time = formatDate(lastSyncedAt ?? new Date().toISOString(), t)
    const result = sync === undefined ? (savedResult ?? { success: 0, total: 0 }) : syncSourceResult(sync)
    return { name: t('menu.syncAgain'), description: t('menu.syncLastResult', { time, success: result.success, total: result.total }) }
  }
  return { name: t('menu.syncAll'), description: t('menu.syncAllDetail') }
}

function syncSourceResult(sync: SyncStatus | undefined): { success: number; total: number } {
  if (sync === undefined) return { success: 0, total: 0 }
  return {
    success: sync.providerProgress.filter(row => row.phase === 'complete').length,
    total: sync.providers.length,
  }
}

export function createFileSource(
  load: (sessionId: SessionId, query: string, signal: AbortSignal) => Promise<readonly FileReferenceCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 10 },
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: FILE_SOURCE, order: options.order,
    async candidates(session, { query, quoted, signal }) {
      const scoped = scopedQuery(query, 'files')
      if (scoped === undefined) return []
      const rows = await load(session.sessionId, scoped, signal)
      return rows.flatMap((row): InputTriggerCandidate[] => {
        const mention = formatFileMention(row, quoted === true)
        if (mention === undefined) return []
        const basename = row.path.replaceAll('\\', '/').split('/').at(-1) ?? row.path
        const name = row.kind === 'directory' ? `${basename}/` : basename
        return [{
          name,
          description: row.path,
          icon: PICKER_ICON_MARKER[workspaceIconKind(row)],
          value: encodeCandidate({ kind: 'file', fileKind: row.kind, label: basename, mention }),
        }]
      })
    },
    onPick({ candidate }) {
      const value = decodeCandidate(candidate.value)
      if (value?.kind !== 'file') return undefined
      if (value.fileKind === 'directory') return { text: value.mention, continue: true }
      return {
        insert: {
          source: FILE_SOURCE,
          ref: value.mention,
          label: value.label,
          appearance: 'file',
          clipboardText: value.mention,
        },
      }
    },
    codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
  }
  return withDisplayPolicy(source, options, t)
}

export function createSessionSource(
  search: (sessionId: SessionId, query: string, signal: AbortSignal) => Promise<readonly SessionReferenceMentionCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 20 },
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: SESSION_SOURCE, order: options.order,
    async candidates(session, { query, quoted, signal }) {
      if (quoted === true) return []
      const scoped = scopedQuery(query, 'sessions')
      if (scoped === undefined) return []
      return (await search(session.sessionId, scoped, signal)).map(row => ({
        name: row.label,
        description: [row.cwd, new Date(row.createdAt).toLocaleString()].filter(Boolean).join(' · '),
        icon: SESSION_ICON_MARKER,
        value: encodeCandidate({ kind: 'session', label: row.label, mention: row.mention }),
      }))
    },
    onPick({ candidate }) {
      const value = decodeCandidate(candidate.value)
      if (value?.kind !== 'session') return undefined
      return {
        insert: {
          source: SESSION_SOURCE,
          ref: value.mention,
          label: value.label,
          appearance: 'session',
          clipboardText: value.mention,
        },
      }
    },
    codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
  }
  return withDisplayPolicy(source, options, t)
}

/**
 * The `@` group for transcripts other coding agents left on this machine.
 *
 * Rows carry the transcript's id, never a body excerpt: the Host ranks on title
 * and opening prompt alone, so nothing the user has not named can reach the
 * model through a menu row. Picking one inserts a pointer; the turns are read
 * later, and only for the task that asked.
 * @param search - Host-side discovery, scoped to the session's own workspace.
 * @param t - translator for the row's dimmed second line.
 * @param options - order, visible limit, and the shared display policy.
 * @returns the source to register on `ctx.inputTriggers`.
 */
export function createLocalAgentSource(
  search: (sessionId: SessionId, query: string, signal: AbortSignal, limit: number) => Promise<readonly AgentCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 25 },
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: AGENT_SOURCE, order: options.order,
    async candidates(session, { query, quoted, signal }) {
      // A quoted query is a path completion in progress; a transcript pointer
      // is not a path, so this group stays out of the way.
      if (quoted === true) return []
      const scoped = scopedQuery(query, 'agents')
      if (scoped === undefined) return []
      const rows = await search(session.sessionId, scoped, signal, options.maxCandidates)
      // Agent sessions go untitled far more often than browser chats do, and
      // several in a row can share an opening prompt, so numbering matters.
      return disambiguate(rows.map((row): InputTriggerCandidate => {
        const title = row.label.trim() || 'Untitled'
        // Same separator rule as web chats: a spaced `@Codex · Title` is
        // otherwise re-projected by the user-bubble renderer as a native pill.
        // Kimi also names a Web provider. Give its local CLI transcript a
        // distinct chip label so DOM projection remains source-safe even on a
        // Host build that does not expose the insertion source as a data attr.
        const chipProvider = row.provider === 'Kimi' ? 'Kimi CLI' : row.provider
        const label = (chipProvider ? `${chipProvider}·${title}` : title).replace(/[\[\]]/gu, '')
        return {
          name: title,
          description: describeAgentRow(row, t),
          icon: AGENT_ICON_MARKER,
          value: encodeCandidate({ kind: 'agent', reference: { id: row.id, label } }),
        }
      }))
    },
    onPick({ candidate }) {
      const value = decodeCandidate(candidate.value)
      if (value?.kind !== 'agent') return undefined
      const reference = value.reference
      return {
        insert: {
          source: AGENT_SOURCE,
          ref: encodeAgentReference(reference),
          label: reference.label,
          appearance: 'session',
          clipboardText: formatAgentMention(reference),
        },
      }
    },
    codec: {
      clipboardText: ref => formatAgentMention(decodeAgentReference(ref)),
      serialize: ref => Promise.resolve(formatAgentMention(decodeAgentReference(ref))),
    },
  }
  return withDisplayPolicy(source, options, t)
}

/** The dimmed second line: which agent wrote it, and when it last moved. */
function describeAgentRow(row: AgentCandidate, t: T): string {
  const provider = row.provider || t('source.agents')
  if (row.updatedAt === undefined) return provider
  return t('conversation.description', { provider, date: formatDate(new Date(row.updatedAt).toISOString(), t) })
}

function encodeAgentReference(reference: AgentReference): string { return JSON.stringify(reference) }
function decodeAgentReference(value: string): AgentReference {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== 'object') throw new Error('invalid agent reference')
  const { id, label } = parsed as { id?: unknown; label?: unknown }
  if (typeof id !== 'string' || typeof label !== 'string') throw new Error('invalid agent reference')
  return { id, label }
}
function formatAgentMention(reference: AgentReference): string {
  return `@[${escapeLabel(reference.label)}](${agentReferenceUri(reference.id)})`
}

/**
 * Files in the user's own cloud drives.
 *
 * Unlike every other group here this one has no session parameter: a drive is
 * the same drive from any workspace, so there is nothing for the host to scope
 * a search to.
 */
export function createCloudDriveSource(
  search: (query: string, signal: AbortSignal, limit: number) => Promise<readonly DriveCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 35 },
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: DRIVE_SOURCE, order: options.order,
    async candidates(_session, { query, quoted, signal }) {
      // A quoted query is a workspace path completion; a remote file is not on
      // this filesystem, so this group stays out of the way.
      if (quoted === true) return []
      const scoped = scopedQuery(query, 'drives')
      if (scoped === undefined) return []
      const rows = await search(scoped, signal, options.maxCandidates)
      if (rows.length === 0 && scoped === '') return [{
        name: t('drive.searchAction'),
        description: t('drive.searchActionDetail'),
        icon: DRIVE_ICON_MARKER,
        value: encodeCandidate({ kind: 'drive-search' }),
      }]
      // Two drives can hold files of the same name, and one drive can hold the
      // same name in two folders, so the ordinal suffix earns its place here.
      const candidates = disambiguate(rows.map((row): InputTriggerCandidate => {
        const name = row.label.trim() || 'Untitled'
        if (row.isDirectory === true) return {
          name: `📁 ${name}`,
          description: row.origin ?? t('source.drives'),
          icon: DRIVE_ICON_MARKER,
          value: encodeCandidate({ kind: 'drive-folder', path: row.origin ?? '/' }),
        }
        return {
          name,
          description: describeDriveRow(row, t),
          icon: DRIVE_ICON_MARKER,
          value: encodeCandidate({
            kind: 'drive',
            // Same separator rule as the other pointer groups: a spaced
            // `@Drive · Name` is re-projected as a native pill by the
            // user-bubble renderer.
            reference: { id: row.id, label: (row.provider ? `${row.provider}·${name}` : name).replace(/[\[\]]/gu, '') },
          }),
        }
      }))
      if (scoped.startsWith('/') && scoped.replace(/\/+$/u, '') !== '') {
        const current = scoped.replace(/\/+$/u, '')
        const parent = current.slice(0, current.lastIndexOf('/')) || '/'
        candidates.unshift({ name: `↩ ${t('drive.parentFolder')}`, description: parent, icon: DRIVE_ICON_MARKER, value: encodeCandidate({ kind: 'drive-folder', path: parent }) })
      }
      return candidates
    },
    onPick({ candidate }) {
      const value = decodeCandidate(candidate.value)
      if (value?.kind === 'drive-search') return { text: '@drive:' }
      if (value?.kind === 'drive-folder') return { text: `@drive:${value.path.replace(/\/+$/u, '') || ''}/` }
      if (value?.kind !== 'drive') return undefined
      const reference = value.reference
      return {
        insert: {
          source: DRIVE_SOURCE,
          ref: encodeDriveReference(reference),
          label: reference.label,
          // A document, so it wears the file chip rather than the conversation
          // one — the ref stays ours either way; appearance is only style.
          appearance: 'file',
          clipboardText: formatDriveMention(reference),
        },
      }
    },
    codec: {
      clipboardText: ref => formatDriveMention(decodeDriveReference(ref)),
      serialize: ref => Promise.resolve(formatDriveMention(decodeDriveReference(ref))),
    },
  }
  return withDisplayPolicy(source, options, t)
}

/** The dimmed second line: which drive holds it, and where in that drive. */
function describeDriveRow(row: DriveCandidate, t: T): string {
  const provider = row.provider || t('source.drives')
  const location = !row.origin ? provider : t('drive.description', { provider, path: row.origin })
  return row.searchIncomplete === true ? `${location} · ${t('drive.searchIncomplete')}` : location
}

function encodeDriveReference(reference: DriveReference): string { return JSON.stringify(reference) }
function decodeDriveReference(value: string): DriveReference {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== 'object') throw new Error('invalid drive reference')
  const { id, label } = parsed as { id?: unknown; label?: unknown }
  if (typeof id !== 'string' || typeof label !== 'string') throw new Error('invalid drive reference')
  return { id, label }
}
function formatDriveMention(reference: DriveReference): string {
  return `@[${escapeLabel(reference.label)}](${driveReferenceUri(reference.id)})`
}

interface CommandCandidate { name: string; description?: string; input?: { hint?: string } }
interface SkillCandidate { name: string; description: string; modelInvocable?: boolean }

export function createCommandSource(
  load: (sessionId: SessionId, signal: AbortSignal) => Promise<readonly CommandCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 0 },
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: COMMAND_SOURCE, order: options.order,
    async candidates(session, { query, signal }) {
      const scoped = scopedQuery(query, 'commands')
      if (scoped === undefined) return []
      const needle = scoped.toLocaleLowerCase()
      return (await load(session.sessionId, signal))
        .filter(row => row.name.toLocaleLowerCase().includes(needle))
        .map(row => ({
          name: row.name, description: row.description, hint: row.input?.hint,
          icon: COMMAND_ICON_MARKER, value: encodeCandidate({ kind: 'command', name: row.name }),
        }))
    },
    onPick({ candidate }) {
      const value = decodeCandidate(candidate.value)
      return value?.kind === 'command' ? { text: `/${value.name}` } : undefined
    },
  }
  return withDisplayPolicy(source, options, t)
}

export function createSkillSource(
  load: (sessionId: SessionId, signal: AbortSignal) => Promise<readonly SkillCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 5 },
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: SKILL_SOURCE, order: options.order,
    async candidates(session, { query, signal }) {
      const scoped = scopedQuery(query, 'skills')
      if (scoped === undefined) return []
      const rows = await load(session.sessionId, signal)
      const needle = scoped.toLocaleLowerCase()
      return rows.filter(row => row.name.toLocaleLowerCase().includes(needle)).map(row => ({
        name: row.name,
        description: `${row.modelInvocable === false ? t('skill.userOnly') : ''}${row.description}`,
        icon: SKILL_ICON_MARKER,
        value: encodeCandidate({ kind: 'skill', name: row.name }),
      }))
    },
    onPick({ candidate }) {
      const value = decodeCandidate(candidate.value)
      return value?.kind === 'skill' ? { text: `/${value.name} ` } : undefined
    },
  }
  return withDisplayPolicy(source, options, t)
}

interface CachedSourceCandidates {
  session: ClientSessionContext
  request: Pick<CandidateRequest, 'query' | 'quoted' | 'position'>
  pinned: InputTriggerCandidate[]
  normal: InputTriggerCandidate[]
  revision: number
}

function withDisplayPolicy(
  source: InputTriggerSource,
  options: PickerSourceOptions,
  t: T,
  refreshPinned: (candidate: InputTriggerCandidate) => InputTriggerCandidate = candidate => candidate,
): RefreshablePickerSource {
  const expandedStates = new Map<SessionId, { query: string; visibleCount: number }>()
  const caches = new Map<SessionId, CachedSourceCandidates>()
  const present = (cache: CachedSourceCandidates): InputTriggerCandidate[] => {
    const { normal, pinned } = cache
    if (options.displayMode === 'native-scroll' || normal.length <= options.limit) return [...pinned, ...normal]
    const expandedState = expandedStates.get(cache.session.sessionId)
    const visibleCount = expandedState?.query === cache.request.query
      ? Math.min(normal.length, Math.max(options.limit, expandedState.visibleCount))
      : options.limit
    const remaining = normal.length - visibleCount
    const actions: InputTriggerCandidate[] = []
    if (remaining > 0) {
      actions.push({
        name: t('menu.showMore', { count: Math.min(DISPLAY_EXPANSION_STEP, remaining) }), description: t('menu.showMoreDetail'),
        value: encodeCandidate({ kind: 'action', action: 'expand', query: cache.request.query }),
      })
    }
    if (visibleCount > options.limit) {
      actions.push({
        name: t('menu.collapse'), description: t('menu.collapseDetail'),
        value: encodeCandidate({ kind: 'action', action: 'collapse', query: cache.request.query }),
      })
    }
    return [...pinned, ...normal.slice(0, visibleCount), ...actions]
  }
  const publish = (
    cache: CachedSourceCandidates,
    reopen: boolean,
    anchor?: MenuViewportAnchor,
  ): boolean => options.updateMenu?.({
    sessionId: cache.session.sessionId,
    source: source.name,
    query: cache.request.query,
    candidates: present(cache),
    reopen,
    ...(anchor === undefined ? {} : { anchor }),
  }) ?? false
  const cacheCandidates = (
    session: ClientSessionContext,
    request: Pick<CandidateRequest, 'query' | 'quoted' | 'position'>,
    all: readonly InputTriggerCandidate[],
    revision: number,
  ): CachedSourceCandidates => ({
    session,
    request,
    pinned: all.filter(isSyncAction),
    normal: all.filter(candidate => !isSyncAction(candidate)).slice(0, options.maxCandidates),
    revision,
  })

  return {
    ...source,
    async candidates(session, request) {
      const all = await source.candidates(session, request)
      const previous = caches.get(session.sessionId)
      const cache = cacheCandidates(session, {
        query: request.query, quoted: request.quoted, position: request.position,
      }, all, (previous?.revision ?? 0) + 1)
      if (!request.signal.aborted) caches.set(session.sessionId, cache)
      options.guardMenuActions?.(session.sessionId, source.name)
      return present(cache)
    },
    onPick(pick) {
      const value = decodeCandidate(pick.candidate.value)
      if (value?.kind === 'action' && (value.action === 'expand' || value.action === 'collapse')) {
        const query = value.query ?? ''
        const expandedState = expandedStates.get(pick.session.sessionId)
        if (value.action === 'expand') {
          const current = expandedState?.query === query ? expandedState.visibleCount : options.limit
          expandedStates.set(pick.session.sessionId, { query, visibleCount: current + DISPLAY_EXPANSION_STEP })
        } else {
          expandedStates.delete(pick.session.sessionId)
        }
        const cache = caches.get(pick.session.sessionId)
        if (cache?.request.query === query) publish(cache, true, value.action === 'expand' ? 'viewport' : 'last')
        return 'handled'
      }
      const outcome = source.onPick(pick)
      if (value?.kind === 'action' && value.action === 'sync') {
        const cache = caches.get(pick.session.sessionId)
        if (cache !== undefined) publish(cache, true, 'first')
      }
      return outcome
    },
    async refreshCachedMenu(refreshOptions = {}) {
      const work: Promise<void>[] = []
      for (const [sessionId, current] of caches) {
        if (refreshOptions.refetch !== true) {
          current.pinned = current.pinned.map(refreshPinned)
          publish(current, false)
          continue
        }
        const revision = current.revision + 1
        current.revision = revision
        const controller = new AbortController()
        work.push(source.candidates(current.session, { ...current.request, signal: controller.signal }).then((all) => {
          if (caches.get(sessionId) !== current || current.revision !== revision) return
          const refreshed = cacheCandidates(current.session, current.request, all, revision)
          caches.set(sessionId, refreshed)
          publish(refreshed, false)
        }).catch(() => { /* Keep the last visible candidates on refresh failure. */ }))
      }
      await Promise.all(work)
    },
  }
}

function isSyncAction(candidate: InputTriggerCandidate): boolean {
  const value = decodeCandidate(candidate.value)
  return value?.kind === 'action' && value.action === 'sync'
}

function escapeLabel(value: string): string { return value.replace(/[\\\]]/gu, match => `\\${match}`) }

export function conversationReferenceUri(uriId: string): string {
  return encodeReferenceUri({ source: 'web-chat', id: uriId })
}

/**
 * Wrap a transcript id as the `dsh-ref:` URI the Host will dispatch on.
 *
 * The `'local-agent'` source string is hardcoded here rather than sent over the
 * wire, the way `conversationReferenceUri` hardcodes `'web-chat'`: one place
 * owns the mapping from a menu group to the Host source that reads it.
 */
export function agentReferenceUri(id: string): string {
  return encodeReferenceUri({ source: 'local-agent', id })
}

/** The client owns this source string too, for the same reason as the two above. */
export function driveReferenceUri(id: string): string {
  return encodeReferenceUri({ source: 'cloud-drive', id })
}

export function parseQuery(value: string): { query: string; provider?: ChatProvider } {
  return parseProviderQuery(value)
}

export function describeRow(row: SearchResult): string {
  const parts = [LABEL[row.provider], formatDate(row.updatedAt, fallback)]
  if (row.matchedVia === 'content' && row.snippet) parts.push(row.snippet)
  return parts.join(' · ')
}

export function disambiguate(rows: readonly InputTriggerCandidate[]): InputTriggerCandidate[] {
  const taken = new Set<string>()
  return rows.map((row) => {
    if (!taken.has(row.name)) { taken.add(row.name); return row }
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
    'source.conversations': 'External conversations', 'source.files': 'Files and folders', 'source.sessions': 'DSH sessions', 'source.agents': 'Local agent conversations', 'source.drives': 'Cloud drive files', 'source.commands': 'Commands', 'source.skills': 'Skills',
    'conversation.description': '{provider} · {date}', 'drive.description': '{provider} · {path}', 'drive.searchIncomplete': 'Results may be incomplete', 'drive.searchAction': 'Search cloud drive files…', 'drive.searchActionDetail': 'Select, then type a filename, for example @drive:notes', 'drive.parentFolder': 'Parent folder', 'conversation.unknownDate': 'unknown date', 'skill.userOnly': 'user-only · ',
    'menu.syncAll': 'Sync all now', 'menu.syncAllDetail': 'Refresh the local external-conversation index',
    'menu.syncRunning': 'Syncing…', 'menu.syncRunningDetail': 'An external-conversation sync is already running',
    'menu.syncAgain': 'Sync again', 'menu.syncLastResult': 'Last synced {time} · Successful sources {success}/{total}',
    'menu.syncListingProgress': 'Checking sources {completed}/{total}', 'menu.syncProgress': 'Sync {completed}/{total}',
    'menu.showMore': 'Show {count} more', 'menu.showMoreDetail': 'Expand this group',
    'menu.collapse': 'Collapse', 'menu.collapseDetail': 'Show the compact group',
  }
  return (dictionary[key] ?? key).replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params![name]) : match)
}
