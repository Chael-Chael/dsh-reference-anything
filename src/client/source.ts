import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import { isAbsoluteWorkspacePath, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { ChatImportCompatibility } from '../chat-import-compatibility.ts'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  CandidateRequest, ClientSessionContext, InputTriggerCandidate, InputTriggerSource, TokenSpan,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { defaultPickerSettings, type AgentActionsSettings, type LocalAgent, type ChatProvider, type PickerDisplayMode } from '../wire.ts'
import { healthAttention, setupReady } from './health.ts'
import { parseProviderQuery } from '../search.ts'
import { encodeReferenceUri } from '../uri-codec.ts'
import type { AgentCandidate, DriveCandidate, LocalPluginCandidate, SearchResult, SyncStatus, Health } from './remote.ts'
import {
  AGENT_ICON_MARKER, COMMAND_ICON_MARKER, DRIVE_ICON_MARKER, LOCAL_AGENT_ICON_MARKER, PICKER_ICON_MARKER, PROVIDER_ICON_MARKER, SKILL_ICON_MARKER,
  candidateIcon, type PickerIconKind,
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
export const PLUGIN_SOURCE = 'All local plugins'

const driveMenuKinds = new Map<string, WorkspaceIconKind>()
export const driveMenuIconKind = (description: string): WorkspaceIconKind | undefined => driveMenuKinds.get(description)

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

type SourceScope = 'commands' | 'skills' | 'files' | 'sessions' | 'agents' | 'conversations' | 'drives' | 'plugins'
export interface PickerSourceOptions {
  order: number
  sort?: 'name' | 'updated'
  /** Rows shown before the source-owned expand action. */
  limit: number
  /** Hard cap applied before presentation controls are appended. */
  maxCandidates: number
  /** Optional user-defined token accepted before `:` for this source. */
  shortcut?: string
  /** All configured shortcuts, so one source cannot treat another's token as a free query. */
  shortcuts?: Readonly<Record<string, SourceScope | readonly SourceScope[]>>
  /** Source-specific aliases mapped back to the concrete provider/kind. */
  sourceAliasTargets?: Readonly<Record<string, string>>
  displayMode: PickerDisplayMode
  /** Replaces one cached source group without re-tracking the Composer input. */
  updateMenu?: PickerMenuUpdater
  /** Prevents native handled picks for this source from unmounting the menu. */
  guardMenuActions?: PickerMenuActionGuard
  /** The official file source publishes breadcrumbs before requesting other groups. */
  fileBrowsing?: (sessionId: SessionId) => boolean
}

export interface RefreshablePickerSource extends InputTriggerSource {
  /** Re-publish cached menus, optionally refreshing their backing candidates first. */
  refreshCachedMenu(options?: { refetch?: boolean }): Promise<void>
}

export interface ConversationSourceActions {
  health?(): Health | undefined
  healthCheck?(): { pending: boolean; error?: string }
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
const PREFIX_SCOPE: Readonly<Record<string, SourceScope>> = Object.fromEntries(
  Object.entries(defaultPickerSettings()).flatMap(([scope, value]) => typeof value === 'object' ? (value.aliases ?? []).map(alias => [alias, scope as SourceScope]) : []),
)
const COLON_PREFIX_SCOPE: Readonly<Record<string, SourceScope>> = {
  folders: 'files', path: 'files',
}

function scopedPrefixes(scope: SourceScope, shortcut?: string, shortcuts?: Readonly<Record<string, SourceScope | readonly SourceScope[]>>): Readonly<Record<string, SourceScope | readonly SourceScope[]>> {
  if (shortcut === undefined) return shortcuts ?? PREFIX_SCOPE
  const key = shortcut.toLocaleLowerCase()
  const current = shortcuts?.[key] ?? PREFIX_SCOPE[key]
  const scopes = Array.isArray(current) ? [...current] : current === undefined ? [] : [current]
  if (!scopes.includes(scope)) scopes.push(scope)
  return { ...(shortcuts ?? PREFIX_SCOPE), [key]: scopes }
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
interface AgentReference { id: string; label: string; importOnly?: boolean }
interface DriveReference { id: string; label: string }

type CandidateValue =
  | { kind: 'conversation'; reference: ConversationReference }
  | { kind: 'file'; fileKind: FileReferenceCandidate['kind']; label: string; mention: string }
  | { kind: 'file-navigation'; mention: string }
  | { kind: 'session'; label: string; mention: string }
  | { kind: 'agent'; reference: AgentReference }
  | { kind: 'agent-import'; reference: AgentReference; confirmed?: boolean }
  | { kind: 'agent-resume'; reference: AgentReference }
  | { kind: 'agent-back' }
  | { kind: 'agent-warning' }
  | { kind: 'agent-upgrade' }
  | { kind: 'drive'; reference: DriveReference }
  | { kind: 'drive-search' }
  | { kind: 'drive-folder'; path: string }
  | { kind: 'command'; name: string }
  | { kind: 'skill'; name: string }
  | { kind: 'plugin'; name: string; directory?: string }
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
      const scoped = scopedQuery(query, 'conversations', options.shortcut, options.shortcuts)
      if (scoped === undefined) return []
      const parsed = parseQuery(query)
      // A shared shortcut may also be a provider alias (for example
      // `@chatgpt:`). Keep the provider parsed from the original token, but
      // always search with the prefix removed.
      parsed.query = scoped === query.trim() ? parsed.query : scoped
      const match = query.trim().match(/^([^@:\s/]+):(.*)$/u)
      const target = match ? options.sourceAliasTargets?.[match[1]!.toLocaleLowerCase()] as ChatProvider | undefined : undefined
      const rows = await search(parsed.query, parsed.provider ?? target, signal, options.maxCandidates)
      const candidates = disambiguate(rows.map((row): InputTriggerCandidate => {
        const title = row.title.trim() || 'Untitled'
        const label = `${LABEL[row.provider]}·${title}`.replace(/[\[\]]/gu, '')
        return {
          name: title,
          description: row.matchedVia === 'content' && row.snippet
            ? row.snippet
            : t('conversation.description', { provider: LABEL[row.provider], date: formatDate(row.updatedAt, t) }),
          icon: candidateIcon(PROVIDER_ICON_MARKER[row.provider]),
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
  const health = actions.health?.()
  const check = actions.healthCheck?.()
  const status = check?.pending ? t('menu.serviceChecking') : check?.error ? t('menu.serviceFailed') : serviceStatus(health, t)
  const attention = healthAttention(health, t)
  const needsCheck = actions.health && !check?.pending && (check?.error || attention.length > 0 || !setupReady(health))
  return {
    name: actions.health ? `${presentation.name} · ${status}${health?.updateAvailable || health?.extensionUpdateAvailable ? ` · ${t('menu.dependencyUpdate')}` : ''}` : presentation.name,
    description: needsCheck ? `${t('menu.checkSettings')} · ${[check?.error, ...attention].filter(Boolean).join(' · ') || presentation.description}` : presentation.description,
    icon: candidateIcon(PICKER_ICON_MARKER.refresh),
    value: encodeCandidate({ kind: 'action', action: 'sync' }),
  }
}

function serviceStatus(health: Health | undefined, t: T): string {
  if (!health) return t('menu.serviceUnknown')
  if (setupReady(health)) return t('menu.serviceReady')
  if (health.version && health.opencliCompatible && health.daemonRunning && !health.daemonStale
    && health.extensionConnected && health.pluginInstalled && health.adapterCompatible && !health.connectivityChecked) {
    return t('menu.serviceUnverified')
  }
  return t('menu.serviceUnavailable')
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

// Shared by source groups so a file drill never launches unrelated searches.
const fileBrowseDirectories = new Map<SessionId, string>()

export function createFileSource(
  load: (sessionId: SessionId, query: string, signal: AbortSignal) => Promise<readonly FileReferenceCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 10 },
  preview?: { sessions: Pick<ISessions, 'list'>; openResource(address: string): void },
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: FILE_SOURCE, order: options.order,
    header(_session, { query, quoted, drilled }) {
      if (!drilled) return undefined
      const scoped = scopedQuery(query, 'files', options.shortcut, options.shortcuts)
      if (scoped === undefined) return undefined
      const path = scoped.replaceAll('\\', '/')
      const directory = path.slice(0, path.lastIndexOf('/') + 1)
      if (!directory) return undefined
      const parts = directory.split('/').filter(Boolean)
      return [
        { label: t('menu.workspace'), value: encodeCandidate({ kind: 'file-navigation', mention: '@' }) },
        ...parts.map((label, index) => ({
          label,
          current: index === parts.length - 1,
          value: encodeCandidate({ kind: 'file-navigation', mention: formatFileMention({ path: parts.slice(0, index + 1).join('/'), kind: 'directory' }, quoted === true)! }),
        })),
      ]
    },
    async candidates(session, { query, quoted, signal }) {
      const scoped = scopedQuery(query, 'files', options.shortcut, options.shortcuts)
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
          icon: candidateIcon(PICKER_ICON_MARKER[workspaceIconKind(row)]),
          ...(row.kind === 'directory' ? { drill: true } : {}),
          value: encodeCandidate({ kind: 'file', fileKind: row.kind, label: basename, mention }),
        }]
      })
    },
    onPick({ candidate, action, session }) {
      const value = decodeCandidate(candidate.value)
      if (value?.kind === 'file-navigation') {
        const path = value.mention.replace(/^@"?/u, '')
        if (path) fileBrowseDirectories.set(session.sessionId, path)
        else fileBrowseDirectories.delete(session.sessionId)
        return { text: value.mention, continue: true }
      }
      if (value?.kind !== 'file') return undefined
      if (value.fileKind === 'directory' && action === 'drill') {
        fileBrowseDirectories.set(session.sessionId, value.mention.replace(/^@"?/u, ''))
        return { text: value.mention, continue: true }
      }
      return {
        insert: {
          source: FILE_SOURCE,
          ref: value.mention,
          label: value.fileKind === 'directory' ? `${value.label}/` : value.label,
          appearance: value.fileKind === 'directory' ? 'folder' : 'file',
          clipboardText: value.mention,
        },
      }
    },
    openReference(session, { ref, appearance }) {
      if (appearance !== 'file' || !preview) return false
      let path = (ref.startsWith('@"') ? ref.slice(2, -1) : ref.slice(1)).replaceAll('\\', '/')
      const root = preview.sessions.list.getSnapshot().byId[session.sessionId]?.cwd?.replaceAll('\\', '/').replace(/\/+$/u, '')
      if (isAbsoluteWorkspacePath(path) && root) {
        if (path === root) path = ''
        else if (path.startsWith(`${root}/`)) path = path.slice(root.length + 1)
      }
      preview.openResource(sessionFileAddress(session.sessionId, path))
      return true
    },
    codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
  }
  return withDisplayPolicy(source, options, t)
}

export function createSessionSource(
  search: (sessionId: SessionId, query: string, signal: AbortSignal) => Promise<readonly SessionReferenceMentionCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 20 },
  sessions?: Pick<ISessions, 'list'> & Partial<Pick<ISessions, 'refreshProjections'>>,
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: SESSION_SOURCE, order: options.order, showGroupTitle: false,
    async candidates(session, { query, quoted, signal }) {
      if (quoted === true) return []
      const scoped = scopedQuery(query, 'sessions', options.shortcut, options.shortcuts)
      if (scoped === undefined) return []
      const rows = await search(session.sessionId, scoped, signal)
      // The host lists cold sessions before it knows their blank/title projections.
      // Reuse its connection-scoped read cache; never activate an Agent to inspect it.
      if (sessions?.refreshProjections) {
        const cold = rows.filter(row => {
          const snapshot = sessions.list.getSnapshot()
          return snapshot.byId[row.sessionId]?.projectionValues?.sessionListMetadata === undefined
            && snapshot.projectionsBySession?.[row.sessionId]?.state !== 'ready'
        })
        for (let offset = 0; offset < cold.length; offset += 4) {
          signal.throwIfAborted()
          await Promise.all(cold.slice(offset, offset + 4).map(row => sessions.refreshProjections!(row.sessionId)))
        }
      }
      signal.throwIfAborted()
      const snapshot = sessions?.list.getSnapshot()
      return rows.flatMap(row => {
        const summary = snapshot?.byId[row.sessionId]
        const projections = snapshot?.projectionsBySession?.[row.sessionId]?.values ?? summary?.projectionValues
        const metadata = projections?.sessionListMetadata
        if ((metadata?.blank ?? summary?.blank) === true) return []
        const child = summary?.origin === 'subagent' && summary.parentId === session.sessionId
        const officialLabel = row.displayTitle ?? row.label
        const label = officialLabel === row.sessionId
          ? projections?.subagent?.label ?? summary?.title ?? officialLabel
          : officialLabel
        return {
          child,
          candidate: {
            name: label,
            section: t(child ? 'source.subagents' : 'source.sessions'),
            description: [row.cwd, new Date(Math.max(metadata?.lastPromptAt ?? 0, summary?.updatedAt ?? row.createdAt)).toLocaleString()].filter(Boolean).join(' · '),
            icon: candidateIcon('session'),
            value: encodeCandidate({ kind: 'session', label, mention: row.mention }),
          },
        }
      }).sort((a, b) => Number(b.child) - Number(a.child)).map(item => item.candidate)
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
  search: (sessionId: SessionId, query: string, signal: AbortSignal, limit: number, kind?: LocalAgent) => Promise<readonly AgentCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 25 },
  importAndOpen?: (sessionId: SessionId, id: string) => Promise<void>,
  resume?: (sessionId: SessionId, id: string, span: TokenSpan) => Promise<void>,
  actions: AgentActionsSettings = defaultPickerSettings().agents,
  chatImport?: { status(): Promise<ChatImportCompatibility | undefined>; upgrade(): Promise<void> },
): RefreshablePickerSource {
  let upgrading = false
  let upgradeError: string | undefined
  let upgradeAvailable = false
  const availableActions = (id: string): Array<'agent-import' | 'agent-resume'> => [
    ...(actions.showImport && importAndOpen ? ['agent-import' as const] : []),
    ...(actions.showSummary && resume && /^(claude-code|codex):/u.test(id) ? ['agent-resume' as const] : []),
  ]
  const selections = new Map<SessionId, { reference: AgentReference; query: string; previousQuery: string; confirmImport?: boolean; busy?: 'agent-import' | 'agent-resume'; error?: string }>()
  const queries = new Map<SessionId, string>()
  const pending = new Set<string>()
  const actionRows = (selected: NonNullable<ReturnType<typeof selections.get>>): InputTriggerCandidate[] => {
    const available = availableActions(selected.reference.id).filter(kind => !selected.confirmImport || kind === 'agent-import')
    const confirm = available.length === 1 && !actions.skipConfirmation
    return [
      ...available.map(kind => ({
        icon: candidateIcon(PICKER_ICON_MARKER[kind === 'agent-import' ? 'import' : 'summary']),
        name: t(kind === 'agent-import'
          ? selected.busy === kind ? 'agent.importing' : confirm ? 'agent.confirmImport' : 'agent.import'
          : selected.busy === kind ? 'agent.resuming' : confirm ? 'agent.confirmSummary' : 'agent.resume'),
        description: selected.error ?? `${selected.reference.label} · ${t(kind === 'agent-import' ? 'agent.importDetail' : 'agent.resumeDetail')}`,
        value: encodeCandidate({ kind, reference: selected.reference, ...(kind === 'agent-import' && confirm ? { confirmed: true } : {}) }),
      })),
      { icon: candidateIcon(PICKER_ICON_MARKER['undo-2']), name: t('agent.back'), value: encodeCandidate({ kind: 'agent-back' }) },
    ]
  }
  const publish = (sessionId: SessionId, reopen: boolean): void => {
    const selected = selections.get(sessionId)
    if (selected) options.updateMenu?.({ sessionId, source: AGENT_SOURCE, query: selected.query, candidates: actionRows(selected), reopen })
  }
  const execute = (kind: 'agent-import' | 'agent-resume', reference: AgentReference, sessionId: SessionId, span: TokenSpan): void => {
    const selected = selections.get(sessionId)
    if (!selected || selected.reference.id !== reference.id || !availableActions(reference.id).includes(kind) || pending.has(reference.id)) return
    selected.busy = kind
    selected.error = undefined
    pending.add(reference.id)
    publish(sessionId, true)
    void Promise.resolve().then(() => kind === 'agent-import' ? importAndOpen!(sessionId, reference.id) : resume!(sessionId, reference.id, span)).catch(error => {
      selected.error = error instanceof Error ? error.message : String(error)
    }).finally(() => {
      pending.delete(reference.id)
      selected.busy = undefined
      if (selections.get(sessionId) === selected) publish(sessionId, false)
    })
  }
  const source: InputTriggerSource = {
    trigger: '@', name: AGENT_SOURCE, order: options.order,
    async candidates(session, { query, quoted, signal, drilled }) {
      queries.set(session.sessionId, query)
      const selected = selections.get(session.sessionId)
      if (drilled && selected?.query === query) return actionRows(selected)
      selections.delete(session.sessionId)
      // A quoted query is a path completion in progress; a transcript pointer
      // is not a path, so this group stays out of the way.
      if (quoted === true) return []
      const scoped = scopedQuery(query, 'agents', options.shortcut, options.shortcuts)
      if (scoped === undefined) return []
      const match = query.trim().match(/^([^@:\s/]+):(.*)$/u)
      const target = match ? options.sourceAliasTargets?.[match[1]!.toLocaleLowerCase()] : undefined
      const results = await search(session.sessionId, scoped, signal, options.maxCandidates, target as LocalAgent | undefined)
      let statusError: string | undefined
      const compatibility = await chatImport?.status().catch(error => {
        statusError = error instanceof Error ? error.message : String(error)
        return undefined
      })
      upgradeAvailable = (compatibility?.state === 'incompatible' || compatibility?.state === 'unavailable') && compatibility.canUpgrade
      const upgradeRows: InputTriggerCandidate[] = upgrading || upgradeAvailable ? [{
        icon: () => '↑',
        name: t(upgrading ? 'chatImport.upgrading' : compatibility?.version ? 'chatImport.upgrade' : 'chatImport.install'),
        description: upgradeError ?? t(compatibility?.version ? 'chatImport.menuUpgradeDetail' : 'chatImport.menuInstallDetail', { version: compatibility?.version || '—' }),
        value: encodeCandidate({ kind: 'agent-upgrade' }),
      }] : chatImport && compatibility?.state !== 'ready' ? [{
        icon: () => '!',
        name: t('chatImport.apiAttention'),
        description: [t(`chatImport.${compatibility?.state ?? 'unavailable'}`, { version: compatibility?.version || '—' }),
          statusError || compatibility?.error].filter(Boolean).join(' · '),
        value: encodeCandidate({ kind: 'agent-warning' }),
      }] : []
      const warnings: InputTriggerCandidate[] = results.filter(row => row.warning !== undefined).map(row => ({
        name: t('agent.scanWarning'), description: `${row.label}: ${row.warning}`, value: encodeCandidate({ kind: 'agent-warning' }),
      }))
      const rows = results.filter(row => row.warning === undefined && (target === undefined || row.kind === target))
      // Agent sessions go untitled far more often than browser chats do, and
      // several in a row can share an opening prompt, so numbering matters.
      return [...upgradeRows, ...warnings, ...disambiguate(rows.map((row): InputTriggerCandidate => {
        const title = row.label.trim() || 'Untitled'
        // Same separator rule as web chats: a spaced `@Codex · Title` is
        // otherwise re-projected by the user-bubble renderer as a native pill.
        // Kimi also names a Web provider. Give its local CLI transcript a
        // distinct chip label so DOM projection remains source-safe even on a
        // Host build that does not expose the insertion source as a data attr.
        const chipProvider = row.provider === 'Kimi' ? 'Kimi CLI' : row.provider
        const label = (chipProvider ? `${chipProvider}·${title}` : title).replace(/[\[\]]/gu, '')
        const available = availableActions(row.id)
        return {
          name: title,
          description: [row.provider || t('source.agents'), row.cwd ? row.cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() || row.cwd : t('agent.noWorkspace'), row.updatedAt === undefined ? '' : formatDate(new Date(row.updatedAt).toISOString(), t), row.importStatus ? t(`agent.status.${row.importStatus}`) : '', row.importOnly ? t('agent.importOnly') : ''].filter(Boolean).join(' · '),
          icon: candidateIcon(LOCAL_AGENT_ICON_MARKER[row.kind as keyof typeof LOCAL_AGENT_ICON_MARKER] ?? AGENT_ICON_MARKER, row.cwd),
          ...(available.length === 0 ? {} : { drill: true, hint: t(available.length > 1 ? 'agent.actions' : available[0] === 'agent-import' ? 'agent.importHint' : 'settings.agentSummary') }),
          value: encodeCandidate({ kind: 'agent', reference: { id: row.referenceId ?? row.id, label, ...(row.importOnly ? { importOnly: true } : {}) } }),
        }
      }))]
    },
    onPick({ candidate, session, action, span }) {
      const value = decodeCandidate(candidate.value)
      if (value?.kind === 'agent-upgrade') {
        if (!chatImport || upgrading || !upgradeAvailable) return 'handled'
        upgrading = true
        upgradeError = undefined
        void refreshable.refreshCachedMenu({ refetch: true })
        void Promise.resolve().then(() => chatImport.upgrade()).catch(error => {
          upgradeError = error instanceof Error ? error.message : String(error)
        }).finally(() => {
          upgrading = false
          void refreshable.refreshCachedMenu({ refetch: true })
        })
        return 'handled'
      }
      if (value?.kind === 'agent-warning') return 'handled'
      if (value?.kind === 'agent-back') {
        const selected = selections.get(session.sessionId)
        selections.delete(session.sessionId)
        return { text: `@${selected?.previousQuery ?? 'agents:'}`, continue: true }
      }
      if (value?.kind === 'agent-import' || value?.kind === 'agent-resume') {
        if (value.kind === 'agent-import' && !actions.skipConfirmation && !value.confirmed) {
          const selected = selections.get(session.sessionId)
          if (selected?.reference.id === value.reference.id && !selected.busy) {
            selected.confirmImport = true
            publish(session.sessionId, true)
          }
          return 'handled'
        }
        execute(value.kind, value.reference, session.sessionId, span)
        return 'handled'
      }
      if (value?.kind !== 'agent') return undefined
      const reference = value.reference
      if (action === 'drill' || reference.importOnly) {
        const available = availableActions(reference.id)
        if (available.length === 0) return undefined
        const previousQuery = queries.get(session.sessionId) ?? ''
        if (available.length === 1 && actions.skipConfirmation) {
          selections.set(session.sessionId, { reference, query: previousQuery, previousQuery })
          execute(available[0]!, reference, session.sessionId, span)
          return 'handled'
        }
        const query = `${options.shortcut ?? 'agents'}:`
        selections.set(session.sessionId, { reference, query, previousQuery })
        return { text: `@${query}`, continue: true }
      }
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
  const refreshable = withDisplayPolicy(source, options, t, candidate => candidate, true)
  return refreshable
}

/** The dimmed second line: which agent wrote it, and when it last moved. */


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
      driveMenuKinds.clear()
      const scoped = scopedQuery(query, 'drives', options.shortcut, options.shortcuts)
      if (scoped === undefined) return []
      // A bare quoted token belongs to workspace files. A drive-qualified one
      // is our folder navigation syntax, needed when its path contains spaces.
      if (quoted === true && scoped === query.trim()) return []
      const rows = await search(scoped, signal, options.maxCandidates)
      if (rows.length === 0 && scoped === '') return [{
        name: t('drive.searchAction'),
        description: t('drive.searchActionDetail'),
        icon: candidateIcon(DRIVE_ICON_MARKER),
        value: encodeCandidate({ kind: 'drive-search' }),
      }]
      // Two drives can hold files of the same name, and one drive can hold the
      // same name in two folders, so the ordinal suffix earns its place here.
      const candidates = disambiguate(rows.map((row): InputTriggerCandidate => {
        const name = row.label.trim() || 'Untitled'
        const description = row.isDirectory === true ? row.origin ?? t('source.drives') : describeDriveRow(row, t)
        driveMenuKinds.set(description, workspacePathIconKind(name, row.isDirectory === true ? 'directory' : 'file'))
        if (row.isDirectory === true) return {
          name,
          description,
          icon: driveIcon(row),
          value: encodeCandidate({ kind: 'drive-folder', path: row.origin ?? '/' }),
        }
        return {
          name,
          description,
          icon: driveIcon(row),
          value: encodeCandidate({
            kind: 'drive',
            // Same separator rule as the other pointer groups: a spaced
            // `@Drive · Name` is re-projected as a native pill by the
            // user-bubble renderer.
            reference: { id: row.id, label: (displayDriveProvider(row) ? `${displayDriveProvider(row)}·${name}` : name).replace(/[\[\]]/gu, '') },
          }),
        }
      }))
      if (scoped.startsWith('/') && scoped.replace(/\/+$/u, '') !== '') {
        const current = scoped.replace(/\/+$/u, '')
        const parent = current.slice(0, current.lastIndexOf('/')) || '/'
        candidates.unshift({ name: `↩ ${t('drive.parentFolder')}`, description: parent, icon: candidateIcon(DRIVE_ICON_MARKER), value: encodeCandidate({ kind: 'drive-folder', path: parent }) })
      }
      return candidates
    },
    onPick({ candidate }) {
      const value = decodeCandidate(candidate.value)
      if (value?.kind === 'drive-search') return { text: '@drive:' }
      if (value?.kind === 'drive-folder') return { text: `@"drive:${value.path.replace(/\/+$/u, '') || ''}/`, continue: true }
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
    matchSpace(_session, token) {
      if (!token.startsWith('@drive:/') || !token.endsWith('/')) return undefined
      return { text: `@"${token.slice(1)}" ` }
    },
    codec: {
      clipboardText: ref => formatDriveMention(decodeDriveReference(ref)),
      serialize: ref => Promise.resolve(formatDriveMention(decodeDriveReference(ref))),
    },
  }
  return withDisplayPolicy(source, options, t, candidate => candidate, true)
}

function driveIcon(row: DriveCandidate): InputTriggerCandidate['icon'] {
  const file = PICKER_ICON_MARKER[workspacePathIconKind(row.label, row.isDirectory === true ? 'directory' : 'file')]
  return candidateIcon(`${DRIVE_ICON_MARKER}${file}`)
}

function displayDriveProvider(row: DriveCandidate): string {
  return isBaiduDrive(row) ? 'BaiduNetdisk' : row.provider
}

function isBaiduDrive(row: DriveCandidate): boolean {
  return /(?:^|\/)baidu(?:netdisk|cloud)?(?:\/|$)/iu.test(row.origin ?? '')
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

interface CommandCandidate { name: string; description?: string; icon?: NonNullable<InputTriggerCandidate['icon']>; input?: { hint?: string } }
const COMMAND_ICON_KIND: Readonly<Record<string, PickerIconKind>> = {
  file: 'paperclip', goal: 'goal', plan: 'plan', feedback: 'feedback', compact: 'compact', permission: 'permission', model: 'model', export: 'export',
}
const COMMAND_DESCRIPTION_EN: Readonly<Record<string, string>> = {
  goal: 'Set or view the goal for a long-running task', plan: 'Enter or leave plan mode', feedback: 'Record feedback about this session', compact: 'Compact older conversation history', permission: 'Switch the permission preset (sandbox mode + approval policy)', model: 'Select the model for this conversation', export: 'Download this Session log as a ZIP archive',
}
const COMMAND_DESCRIPTION_ZH: Readonly<Record<string, string>> = {
  goal: '设置或查看长期任务目标', plan: '进入或退出计划模式', feedback: '发送关于当前会话的反馈', compact: '压缩以上对话内容', permission: '切换权限预设（沙箱模式与审批策略）', model: '选择当前会话使用的模型', export: '将当前会话内容导出为 ZIP',
}
const COMMAND_LABEL_EN: Readonly<Record<string, string>> = {
  goal: 'Goal', plan: 'Plan', feedback: 'Feedback', compact: 'Compact', permission: 'Permission', export: 'Export', model: 'Model',
}
const COMMAND_LABEL_ZH: Readonly<Record<string, string>> = {
  goal: '目标', plan: '计划', feedback: '反馈', compact: '压缩', permission: '权限', export: '下载日志', model: '模型',
}
interface SkillCandidate { name: string; description: string; modelInvocable?: boolean }

export function createCommandSource(
  load: (sessionId: SessionId, signal: AbortSignal) => Promise<readonly CommandCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 0 },
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: COMMAND_SOURCE, order: options.order,
    async candidates(session, { query, signal }) {
      const scoped = scopedQuery(query, 'commands', options.shortcut, options.shortcuts)
      if (scoped === undefined) return []
      const needle = scoped.toLocaleLowerCase()
      const loaded = await load(session.sessionId, signal)
      const rows = loaded.some(row => row.name.toLocaleLowerCase() === 'model') ? loaded : [...loaded, { name: 'model', description: COMMAND_DESCRIPTION_EN.model }]
      return rows
        .filter(row => row.name.toLocaleLowerCase().includes(needle))
        .map(row => {
          const key = row.name.toLocaleLowerCase()
          const english = t('source.commands') === 'Commands'
          return {
          name: (english ? COMMAND_LABEL_EN[key] : COMMAND_LABEL_ZH[key]) ?? row.name, description: ((english ? COMMAND_DESCRIPTION_EN[key] : COMMAND_DESCRIPTION_ZH[key]) ?? row.description), hint: row.input?.hint,
          icon: candidateIcon(PICKER_ICON_MARKER[COMMAND_ICON_KIND[row.name.toLocaleLowerCase()] ?? 'command']), value: encodeCandidate({ kind: 'command', name: row.name }),
          }
        })
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
      const scoped = scopedQuery(query, 'skills', options.shortcut, options.shortcuts)
      if (scoped === undefined) return []
      const rows = await load(session.sessionId, signal)
      const needle = scoped.toLocaleLowerCase()
      return rows.filter(row => row.name.toLocaleLowerCase().includes(needle)).map(row => ({
        name: row.name,
        description: `${row.modelInvocable === false ? t('skill.userOnly') : ''}${row.description}`,
        icon: candidateIcon(SKILL_ICON_MARKER),
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

export function createPluginSource(
  load: (signal: AbortSignal) => Promise<readonly LocalPluginCandidate[]>,
  t: T = fallback,
  options: PickerSourceOptions = { ...DEFAULT_SOURCE_OPTIONS, order: 40 },
): RefreshablePickerSource {
  const source: InputTriggerSource = {
    trigger: '@', name: PLUGIN_SOURCE, order: options.order,
    async candidates(_session, { query, quoted, signal }) {
      if (quoted) return []
      const scoped = scopedQuery(query, 'plugins', options.shortcut, options.shortcuts)
      if (scoped === undefined) return []
      const rows = await load(signal)
      const needle = scoped.toLocaleLowerCase()
      return rows
        .filter(row => row.name.toLocaleLowerCase().includes(needle) || row.label.toLocaleLowerCase().includes(needle) || row.id.toLocaleLowerCase().includes(needle))
        .map(row => {
          const statusText = t(`plugin.status.${row.status}`)
          const descParts = [row.version ? row.version : undefined, statusText].filter(Boolean)
          return {
            name: row.label || row.name,
            description: descParts.join(' · '),
            icon: candidateIcon(PICKER_ICON_MARKER.plugin),
            value: encodeCandidate({ kind: 'plugin', name: row.name, directory: row.directory }),
          }
        })
    },
    onPick({ candidate }) {
      const value = decodeCandidate(candidate.value)
      if (value?.kind !== 'plugin') return undefined
      const mention = `@[${escapeLabel(value.name)}](${encodeReferenceUri({ source: 'local-plugin', id: value.name })})`
      return { insert: { source: PLUGIN_SOURCE, ref: mention, label: value.name, appearance: 'session', clipboardText: mention } }
    },
    codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
  }
  return withDisplayPolicy(source, options, t)
}

interface CachedSourceCandidates {
  session: ClientSessionContext
  request: Pick<CandidateRequest, 'query' | 'quoted' | 'position' | 'drilled'>
  pinned: InputTriggerCandidate[]
  normal: InputTriggerCandidate[]
  revision: number
}

function withDisplayPolicy(
  source: InputTriggerSource,
  options: PickerSourceOptions,
  t: T,
  refreshPinned: (candidate: InputTriggerCandidate) => InputTriggerCandidate = candidate => candidate,
  staleWhileRevalidate = false,
): RefreshablePickerSource {
  const expandedStates = new Map<SessionId, { query: string; visibleCount: number }>()
  const caches = new Map<SessionId, CachedSourceCandidates>()
  const refreshing = new Set<SessionId>()
  const present = (cache: CachedSourceCandidates): InputTriggerCandidate[] => {
    const { normal, pinned } = cache
    if ((source.name === AGENT_SOURCE && cache.request.drilled) || options.displayMode === 'native-scroll' || normal.length <= options.limit) return [...pinned, ...normal]
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
    request: Pick<CandidateRequest, 'query' | 'quoted' | 'position' | 'drilled'>,
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
      if (source.name !== FILE_SOURCE && request.drilled && request.query !== '' && options.fileBrowsing?.(session.sessionId)) {
        caches.delete(session.sessionId)
        return []
      }
      const directory = fileBrowseDirectories.get(session.sessionId)
      if (!request.drilled || !request.query.startsWith(directory ?? '\0')) fileBrowseDirectories.delete(session.sessionId)
      else if (source.name !== FILE_SOURCE) {
        caches.delete(session.sessionId)
        return []
      }
      const previous = caches.get(session.sessionId)
      if (staleWhileRevalidate && previous !== undefined
        && !request.drilled && previous.request.drilled === request.drilled
        && previous.request.query === request.query && previous.request.quoted === request.quoted) {
        if (!refreshing.has(session.sessionId)) {
          refreshing.add(session.sessionId)
          const revision = previous.revision + 1
          previous.request = { query: request.query, quoted: request.quoted, position: request.position, drilled: request.drilled }
          previous.revision = revision
          void source.candidates(session, request).then((all) => {
            if (request.signal.aborted || caches.get(session.sessionId) !== previous || previous.revision !== revision) return
            const refreshed = cacheCandidates(session, request, all, revision)
            caches.set(session.sessionId, refreshed)
            publish(refreshed, false)
          }).catch(() => { /* Keep the stale candidates on refresh failure. */ })
            .finally(() => refreshing.delete(session.sessionId))
        }
        return present(previous)
      }
      const all = await source.candidates(session, request)
      const cache = cacheCandidates(session, {
        query: request.query, quoted: request.quoted, position: request.position, drilled: request.drilled,
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
  return value?.kind === 'agent-upgrade' || value?.kind === 'agent-warning' || (value?.kind === 'action' && value.action === 'sync')
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
export function scopedQuery(value: string, scope: SourceScope, shortcut?: string, shortcuts?: Readonly<Record<string, SourceScope | readonly SourceScope[]>>): string | undefined {
  const prefixes = scopedPrefixes(scope, shortcut, shortcuts)
  const matchesScope = (requested: SourceScope | readonly SourceScope[] | undefined): boolean => requested === scope || (Array.isArray(requested) && requested.includes(scope))
  const trimmed = value.replaceAll('：', ':').trim()
  const match = trimmed.match(/^([^@:\s/]+):(.*)$/u)
  if (!match) return trimmed
  const prefix = match[1]!.toLocaleLowerCase()
  const requested = prefixes[prefix] ?? COLON_PREFIX_SCOPE[prefix]
  if (requested === undefined) return trimmed
  return matchesScope(requested) ? (match[2] ?? '').trim() : undefined
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
    'source.subagents': 'Subagents',
    'agent.noWorkspace': 'No workspace recorded',
    'plugin.status.live': 'Running', 'plugin.status.disabled': 'Disabled', 'plugin.status.inert': 'Not running',
    'source.conversations': 'External conversations', 'source.files': 'Files and folders', 'source.sessions': 'DSH sessions', 'source.agents': 'Local agent conversations', 'source.drives': 'Cloud drive files', 'source.commands': 'Commands', 'source.skills': 'Skills', 'source.plugins': 'All local plugins',
    'conversation.description': '{provider} · {date}', 'drive.description': '{provider} · {path}', 'drive.searchIncomplete': 'Results may be incomplete', 'drive.searchAction': 'Search cloud drive files…', 'drive.searchActionDetail': 'Select, then type a filename, for example @drive:notes', 'drive.parentFolder': 'Parent folder', 'conversation.unknownDate': 'unknown date', 'skill.userOnly': 'user-only · ',
    'menu.serviceChecking': '◐ Checking service', 'menu.serviceFailed': '○ Service check failed', 'menu.checkSettings': 'Check Settings', 'menu.serviceUnknown': '○ Service status unknown', 'menu.serviceReady': '● Service ready', 'menu.serviceUnverified': '◐ Connection unverified', 'menu.serviceUnavailable': '○ Service not ready',
    'menu.workspace': 'Workspace',
    'menu.syncAll': 'Sync all now', 'menu.syncAllDetail': 'Refresh the local external-conversation index',
    'menu.syncRunning': 'Syncing…', 'menu.syncRunningDetail': 'An external-conversation sync is already running',
    'menu.syncAgain': 'Sync again', 'menu.syncLastResult': 'Last synced {time} · Successful sources {success}/{total}',
    'menu.syncListingProgress': 'Checking sources {completed}/{total}', 'menu.syncProgress': 'Sync {completed}/{total}',
    'menu.showMore': 'Show {count} more', 'menu.showMoreDetail': 'Expand this group',
    'menu.collapse': 'Collapse', 'menu.collapseDetail': 'Show the compact group',
  }
  return (dictionary[key] ?? key).replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params![name]) : match)
}



