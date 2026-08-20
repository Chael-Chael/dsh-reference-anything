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
import type { SearchResult, SyncStatus } from './remote.ts'
import {
  COMMAND_ICON_MARKER, PICKER_ICON_MARKER, PROVIDER_ICON_MARKER, SESSION_ICON_MARKER, SKILL_ICON_MARKER,
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

type SourceScope = 'commands' | 'skills' | 'files' | 'sessions' | 'conversations'
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
  chat: 'conversations', conversation: 'conversations', conversations: 'conversations',
  '外部对话': 'conversations', '外部对话记录': 'conversations',
  chatgpt: 'conversations', claude: 'conversations', gemini: 'conversations', deepseek: 'conversations', grok: 'conversations', kimi: 'conversations',
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

type CandidateValue =
  | { kind: 'conversation'; reference: ConversationReference }
  | { kind: 'file'; fileKind: FileReferenceCandidate['kind']; label: string; mention: string }
  | { kind: 'session'; label: string; mention: string }
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
    'source.conversations': 'External conversations', 'source.files': 'Files and folders', 'source.sessions': 'DSH sessions', 'source.commands': 'Commands', 'source.skills': 'Skills',
    'conversation.description': '{provider} · {date}', 'conversation.unknownDate': 'unknown date', 'skill.userOnly': 'user-only · ',
    'menu.syncAll': 'Sync all now', 'menu.syncAllDetail': 'Refresh the local external-conversation index',
    'menu.syncRunning': 'Syncing…', 'menu.syncRunningDetail': 'An external-conversation sync is already running',
    'menu.syncAgain': 'Sync again', 'menu.syncLastResult': 'Last synced {time} · Successful sources {success}/{total}',
    'menu.syncListingProgress': 'Checking sources {completed}/{total}', 'menu.syncProgress': 'Sync {completed}/{total}',
    'menu.showMore': 'Show {count} more', 'menu.showMoreDetail': 'Expand this group',
    'menu.collapse': 'Collapse', 'menu.collapseDetail': 'Show the compact group',
  }
  return (dictionary[key] ?? key).replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params![name]) : match)
}
