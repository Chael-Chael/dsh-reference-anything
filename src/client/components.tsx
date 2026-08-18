import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatProvider, SettingsRecord } from '../wire.ts'
import { formatRelative } from './format.ts'
import type { BrowsePage, Health, ProviderSyncState, SyncStatus } from './remote.ts'

interface Mention { label: string; uri: string; start: number; end: number }
const MENTION = /@\[([^\]]+)]\((dsh-ref:[A-Za-z0-9_-]+)\)/g
export function conversationMentions(value: string): Mention[] {
  return [...value.matchAll(MENTION)].map(match => ({ label: match[1]!, uri: match[2]!, start: match.index, end: match.index + match[0].length }))
}

export interface DockInjected { open(uri: string): void }
type DockProps = PropsRuntime<'conversation.input.dock'> & InjectFace<DockInjected>
export function ConversationsDock({ input, inputActions, open }: DockProps) {
  const rows = conversationMentions(input.draft)
  if (!rows.length) return null
  return <div className="dsh_ref_rail" data-reference-anything-dock>
    {rows.map(row => <span className="dsh_ref_chip" key={`${row.start}:${row.uri}`}>
      <button type="button" className="dsh_ref_open" onClick={() => { open(row.uri) }}>💬 {row.label}</button>
      <button type="button" className="dsh_ref_remove" aria-label={`Remove ${row.label}`} onClick={() => {
        inputActions.setDraft(input.draft.slice(0, row.start) + input.draft.slice(row.end))
      }}>×</button>
    </span>)}
  </div>
}

/** Current query/filter/page of the "Manage synced conversations" list, plus its last fetched page. */
export interface BrowseState { query: string; provider?: ChatProvider; offset: number; page?: BrowsePage }

export interface SettingsSnapshot {
  settings: SettingsRecord; health?: Health; sync?: SyncStatus; error?: string
  syncStates?: readonly ProviderSyncState[]; browse?: BrowseState
}
export interface SettingsInjected {
  hooks: { scope: ObservableSnapshot<SettingsSnapshot> }
  save(value: SettingsRecord): Promise<void>
  sync(providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
  refreshSyncStates(): Promise<void>
  browse(query: string, provider: ChatProvider | undefined, offset: number): Promise<void>
  deleteConversation(uriId: string): Promise<void>
}
type SettingsProps = PropsRuntime<'settings.section'> & InjectFace<SettingsInjected>
const PROVIDERS: ChatProvider[] = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok']
const SEARCH_DEBOUNCE_MS = 300
/**
 * How often the panel re-reads per-provider sync status. Background syncs
 * report through the durable `sync_states` rows, not through the job poll —
 * which only follows a job this tab started — so without this the captions
 * sat stale until someone pressed Recheck.
 */
const SYNC_STATE_POLL_MS = 30_000
/** Rows fetched per page in the "Manage synced conversations" list — shared with the `browse()` client action. */
export const PAGE_SIZE = 20

export function ConversationSettings({ useScope, save, sync, cancel, refresh, refreshSyncStates, browse, deleteConversation }: SettingsProps) {
  const state = useScope(value => value)
  const settings = state.settings
  const syncing = state.sync?.status === 'running'
  // Only while the panel is open, and only the cheap call — a sync running in
  // the background belongs to no job this tab is polling.
  useEffect(() => {
    const timer = setInterval(() => { void refreshSyncStates() }, SYNC_STATE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [refreshSyncStates])
  return <section className="dsh_ref_settings">
    <h2>Conversation references</h2>
    <div className="dsh_ref_card">
      <strong>OpenCLI</strong>
      <span>{state.health ? `${state.health.version} · ${state.health.pluginInstalled ? 'adapter installed' : 'adapter missing'}` : 'Checking…'}</span>
      <span>{state.health?.daemon || state.error || ''}</span>
      {!state.health?.pluginInstalled && <code>opencli plugin install file://&lt;plugin&gt;/opencli-plugin</code>}
      <button type="button" onClick={() => { void refresh() }}>Recheck</button>
    </div>
    <label>OpenCLI executable<input value={settings.opencliPath} onChange={event => { void save({ ...settings, opencliPath: event.target.value }) }} /></label>
    <label>Chrome profile<input placeholder="Required when multiple profiles exist" value={settings.profile} onChange={event => { void save({ ...settings, profile: event.target.value }) }} /></label>
    <label>Detail concurrency<input type="number" min={1} max={8} value={settings.detailConcurrency} onChange={event => { void save({ ...settings, detailConcurrency: Number(event.target.value) }) }} /></label>

    <div className="dsh_ref_card dsh_ref_autosync">
      <label className="dsh_ref_toggle">
        <input type="checkbox" checked={settings.autoSync} onChange={event => { void save({ ...settings, autoSync: event.target.checked }) }} />
        Continuous sync
      </label>
      <label>Interval (minutes)
        <input type="number" min={15} max={1440} disabled={!settings.autoSync} value={settings.autoSyncMinutes}
          onChange={event => { void save({ ...settings, autoSyncMinutes: Number(event.target.value) }) }} />
      </label>
      <span className="dsh_ref_hint">{settings.autoSync
        ? `Every ${settings.autoSyncMinutes} minutes, for providers that have synced before. One that keeps failing is retried less often.`
        : 'Off — sync only runs when you click a button below.'}</span>
    </div>

    <div className="dsh_ref_actions">
      <button type="button" disabled={syncing} onClick={() => { void sync(PROVIDERS, 'incremental') }}>Sync all</button>
      <button type="button" disabled={syncing} onClick={() => { void sync(PROVIDERS, 'full') }}>Full rescan</button>
      {syncing && <button type="button" onClick={() => { void cancel() }}>Cancel</button>}
    </div>
    {state.sync && <SyncProgress sync={state.sync} />}
    <div className="dsh_ref_provider_grid">
      {PROVIDERS.map(provider => <div className="dsh_ref_provider_cell" key={provider}>
        <button type="button" disabled={syncing} onClick={() => { void sync([provider], 'incremental') }}>{provider}</button>
        <span className="dsh_ref_provider_caption">{providerCaption(provider, state.syncStates)}</span>
      </div>)}
    </div>

    <ManageConversations state={state} syncing={syncing} browse={browse} deleteConversation={deleteConversation} />
  </section>
}

function SyncProgress({ sync }: { sync: SyncStatus }) {
  const pct = sync.total > 0 ? Math.min(100, Math.round((sync.completed / sync.total) * 100)) : sync.status === 'running' ? 0 : 100
  return <div className="dsh_ref_progress_wrap">
    <div className="dsh_ref_progress_track" role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(sync.total, 1)} aria-valuenow={sync.completed}>
      <div className="dsh_ref_progress_fill" style={{ width: `${pct}%` }} />
    </div>
    <p className="dsh_ref_progress_label">{sync.status}{sync.provider ? ` · ${sync.provider}` : ''} · {sync.completed}/{sync.total}{sync.error ? ` · ${sync.error}` : ''}</p>
  </div>
}

function providerCaption(provider: ChatProvider, states: readonly ProviderSyncState[] | undefined): string {
  const state = states?.find(row => row.provider === provider)
  if (!state || !state.lastSyncAt) return 'never synced'
  if (state.status === 'running') return 'syncing…'
  if (state.status === 'failed') return `failed · ${formatRelative(state.lastSyncAt)}`
  // An idle row can still carry the tally of conversations this pass could not read.
  if (state.error) return `synced ${formatRelative(state.lastSyncAt)} · ${state.error}`
  return `synced ${formatRelative(state.lastSyncAt)}`
}

interface ManageProps {
  state: SettingsSnapshot
  syncing: boolean
  browse(query: string, provider: ChatProvider | undefined, offset: number): Promise<void>
  deleteConversation(uriId: string): Promise<void>
}
function ManageConversations({ state, syncing, browse, deleteConversation }: ManageProps) {
  const browseState = state.browse
  const [text, setText] = useState(browseState?.query ?? '')
  const debounce = useRef<ReturnType<typeof setTimeout>>()

  // Fetch the first page once, when the panel first mounts.
  useEffect(() => {
    if (browseState === undefined) void browse('', undefined, 0)
  }, [])

  // Debounce typed search text before re-querying; provider/pagination changes fetch immediately elsewhere.
  useEffect(() => {
    if (text === (browseState?.query ?? '')) return
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => { void browse(text, browseState?.provider, 0) }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(debounce.current)
  }, [text])

  const page = browseState?.page
  const items = page?.items ?? []
  const total = page?.total ?? 0
  const offset = browseState?.offset ?? 0
  const hasPrev = offset > 0
  const hasNext = offset + items.length < total

  return <div className="dsh_ref_manage">
    <h3>Manage synced conversations</h3>
    <div className="dsh_ref_manage_filters">
      <input placeholder="Search title…" value={text} onChange={event => { setText(event.target.value) }} />
      <select value={browseState?.provider ?? ''} onChange={event => {
        const provider = (event.target.value || undefined) as ChatProvider | undefined
        void browse(text, provider, 0)
      }}>
        <option value="">All providers</option>
        {PROVIDERS.map(provider => <option key={provider} value={provider}>{provider}</option>)}
      </select>
    </div>
    {items.length === 0
      ? <p className="dsh_ref_manage_empty">{page === undefined ? 'Loading…' : 'No synced conversations found.'}</p>
      : <ul className="dsh_ref_manage_list">
        {items.map(item => <li className="dsh_ref_manage_row" key={item.uriId}>
          <div className="dsh_ref_manage_title_row">
            <span className="dsh_ref_manage_title">{item.title}</span>
            <span className="dsh_ref_badge">{item.provider}</span>
            {item.partial && <span className="dsh_ref_badge dsh_ref_badge_warn">partial</span>}
            {item.remoteMissing && <span className="dsh_ref_badge dsh_ref_badge_warn">remote missing</span>}
          </div>
          <span className="dsh_ref_manage_meta">{item.turnCount} turns · updated {formatRelative(item.updatedAt)}</span>
          <button type="button" className="dsh_ref_danger" disabled={syncing} title={syncing ? 'Cannot delete while a sync is running' : undefined}
            onClick={() => {
              if (window.confirm(`Delete "${item.title}" from the local mirror? It may reappear on a future sync.`)) void deleteConversation(item.uriId)
            }}>Delete</button>
        </li>)}
      </ul>}
    <div className="dsh_ref_pagination">
      <button type="button" disabled={!hasPrev} onClick={() => { void browse(text, browseState?.provider, Math.max(0, offset - PAGE_SIZE)) }}>Prev</button>
      <span>{total === 0 ? '0 of 0' : `${offset + 1}–${offset + items.length} of ${total}`}</span>
      <button type="button" disabled={!hasNext} onClick={() => { void browse(text, browseState?.provider, offset + PAGE_SIZE) }}>Next</button>
    </div>
  </div>
}
