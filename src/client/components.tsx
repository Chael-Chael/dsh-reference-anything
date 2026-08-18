import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import * as ClaudeModule from '@lobehub/icons/es/Claude/components/Mono.js'
import * as DeepSeekModule from '@lobehub/icons/es/DeepSeek/components/Mono.js'
import * as GeminiModule from '@lobehub/icons/es/Gemini/components/Mono.js'
import * as OpenAIModule from '@lobehub/icons/es/OpenAI/components/Mono.js'
import * as XAIModule from '@lobehub/icons/es/XAI/components/Mono.js'
import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react'
import type { ChatProvider, SettingsRecord } from '../wire.ts'
import type { BrowsePage, BrowserProfile, Health, ProviderStats, SyncStatus } from './remote.ts'
import { formatRelative } from './format.ts'

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
      <button type="button" className="dsh_ref_open" onClick={() => { open(row.uri) }}><span className="dsh_ref_chip_mark" aria-hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a8 8 0 0 1-8.5 8A8.9 8.9 0 0 1 7.7 18.6L3.5 20l1.4-3.7A8 8 0 1 1 20 11.5Z"/></svg></span>{row.label}</button>
      <button type="button" className="dsh_ref_remove" aria-label={`Remove ${row.label}`} onClick={() => {
        inputActions.setDraft(input.draft.slice(0, row.start) + input.draft.slice(row.end))
      }}>×</button>
    </span>)}
  </div>
}

/** Current query/filter/page of the "Manage synced conversations" list, plus its last fetched page. */
export interface BrowseState { query: string; provider?: ChatProvider; offset: number; page?: BrowsePage }

export interface SettingsSnapshot { settings: SettingsRecord; health?: Health; profiles?: readonly BrowserProfile[]; stats?: readonly ProviderStats[]; sync?: SyncStatus; error?: string; notice?: string; loading?: boolean; browse?: BrowseState }
export interface SettingsInjected {
  hooks: { scope: ObservableSnapshot<SettingsSnapshot> }
  save(value: SettingsRecord): Promise<void>
  sync(providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
  install(): Promise<void>
  browse(query: string, provider: ChatProvider | undefined, offset: number): Promise<void>
  deleteConversation(uriId: string): Promise<void>
  refreshStats(): Promise<void>
}
type SettingsProps = PropsRuntime<'settings.section'> & InjectFace<SettingsInjected>
const PROVIDERS: ChatProvider[] = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok']
/** Keystrokes to ride out before a typed filter re-queries the Host. */
const SEARCH_DEBOUNCE_MS = 300
/** Rows fetched per page in the "Manage synced conversations" list. */
export const PAGE_SIZE = 20
/**
 * How often the panel re-reads provider statistics while it is open.
 *
 * A background auto-sync belongs to no job this tab is polling, so without
 * this the provider cards and the managed list sit stale until the user
 * presses Recheck.
 */
const STATS_POLL_MS = 30_000
const PROVIDER_LABEL: Record<ChatProvider, string> = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok',
}
const OpenAIIcon = OpenAIModule.default as unknown as ComponentType<{ size?: number }>
const ClaudeIcon = ClaudeModule.default as unknown as ComponentType<{ size?: number }>
const GeminiIcon = GeminiModule.default as unknown as ComponentType<{ size?: number }>
const DeepSeekIcon = DeepSeekModule.default as unknown as ComponentType<{ size?: number }>
const XAIIcon = XAIModule.default as unknown as ComponentType<{ size?: number }>
export function ConversationSettings({ useScope, save, sync, cancel, refresh, install, browse, deleteConversation, refreshStats }: SettingsProps) {
  const state = useScope(value => value)
  const settings = state.settings
  const [installing, setInstalling] = useState(false)
  const [opencliPath, setOpencliPath] = useState(settings.opencliPath)
  const [detailConcurrency, setDetailConcurrency] = useState(String(settings.detailConcurrency))
  useEffect(() => { setOpencliPath(settings.opencliPath); setDetailConcurrency(String(settings.detailConcurrency)) }, [settings.opencliPath, settings.detailConcurrency])
  // Only while the panel is open, and only the cheap call — `refresh()` also
  // shells out to OpenCLI three times for the health probes.
  // Held in a ref, and armed once: the slot rebuilds its injected actions on
  // every render, so depending on the function identity would reset the
  // interval each time and it would never actually fire.
  const pollStats = useRef(refreshStats)
  pollStats.current = refreshStats
  useEffect(() => {
    const timer = setInterval(() => { void pollStats.current() }, STATS_POLL_MS)
    return () => { clearInterval(timer) }
  }, [])
  const ready = Boolean(state.health?.version && state.health?.daemon && state.health?.pluginInstalled)
  const saveConcurrency = () => {
    const value = Number(detailConcurrency)
    if (Number.isInteger(value) && value >= 1 && value <= 8) void save({ ...settings, detailConcurrency: value })
  }
  return <section className="dsh_ref_settings">
    <header className="dsh_ref_header"><div><h2>Reference Anything</h2><p>Keep your external AI conversations searchable, local, and ready to cite.</p></div><button className="dsh_ref_recheck" type="button" onClick={() => { void refresh() }}>Recheck setup</button></header>
    <div className="dsh_ref_workspace">
    {state.error && <div className="dsh_ref_error" role="alert"><strong>Action failed</strong><span>{state.error}</span></div>}
    {state.notice && <div className="dsh_ref_notice" role="status">{state.notice}</div>}
    <section className="dsh_ref_panel"><div className="dsh_ref_section_head"><div><h3>Viability check</h3><p>Everything required to sync browser conversations.</p></div><span className={`dsh_ref_health ${ready ? 'is_ready' : ''}`}>{ready ? 'Ready' : 'Needs attention'}</span></div>
      {state.loading ? <div className="dsh_ref_skeleton"><i/><i/><i/></div> : <div className="dsh_ref_checklist">
        <CheckRow label="OpenCLI" detail={state.health?.version || state.health?.versionError || 'Not detected'} ready={Boolean(state.health?.version)} />
        <CheckRow label="Browser bridge" detail={state.health?.daemon || state.health?.daemonError || 'Daemon unavailable'} ready={Boolean(state.health?.daemon)} />
        <CheckRow label="Conversation adapter" detail={state.health?.pluginInstalled ? 'Installed and discoverable' : state.health?.pluginError || 'Adapter is not installed'} ready={Boolean(state.health?.pluginInstalled)} />
      </div>}
      {!state.health?.pluginInstalled && <div className="dsh_ref_install"><div><strong>Conversation adapter required</strong><span>Install the local OpenCLI adapter, then recheck automatically.</span></div><button type="button" disabled={installing} onClick={() => { setInstalling(true); void install().finally(() => { setInstalling(false) }) }}>{installing ? 'Installing…' : 'Install adapter'}</button></div>}
    </section>
    <section className="dsh_ref_sources"><div className="dsh_ref_section_head"><div><h3>Sources</h3><p>Local conversation index by provider.</p></div>{state.sync?.status === 'running' && <span className="dsh_ref_syncing">Syncing {state.sync.provider ? PROVIDER_LABEL[state.sync.provider] : 'sources'} · {state.sync.completed}/{state.sync.total}</span>}</div>
      <div className="dsh_ref_provider_grid">{PROVIDERS.map((provider, index) => <ProviderCard key={provider} provider={provider} index={index} stats={state.stats?.find(row => row.provider === provider)} busy={state.sync?.status === 'running'} autoSync={settings.autoSync} onSync={() => { void sync([provider], 'incremental') }} />)}</div>
      {!state.loading && state.stats?.every(item => item.conversations === 0) && <div className="dsh_ref_empty">No conversations indexed yet. Choose a browser profile, then run your first sync.</div>}
    </section>
    <section className="dsh_ref_panel dsh_ref_sync_settings"><div className="dsh_ref_section_head"><div><h3>Sync settings</h3><p>Control the browser profile and refresh cadence.</p></div><label className="dsh_ref_toggle"><input type="checkbox" checked={settings.autoSync} onChange={event => { void save({ ...settings, autoSync: event.target.checked }) }} /><span/><b>Auto sync</b></label></div>
      <div className="dsh_ref_form_grid">
        <label><span>OpenCLI executable</span><input value={opencliPath} onChange={event => { setOpencliPath(event.target.value) }} onBlur={() => { if (opencliPath.trim()) void save({ ...settings, opencliPath: opencliPath.trim() }) }} /></label>
        <label><span>Chrome profile</span><select value={settings.profile} onChange={event => { void save({ ...settings, profile: event.target.value }) }}><option value="">OpenCLI default profile</option>{state.profiles?.map(profile => <option key={profile.id} value={profile.alias || profile.id} disabled={!profile.connected}>{profile.alias ? `${profile.alias} · ${profile.id}` : profile.id}{profile.isDefault ? ' · default' : ''}{profile.connected ? '' : ' · disconnected'}</option>)}</select></label>
        <label><span>Detail concurrency</span><input type="number" min={1} max={8} value={detailConcurrency} aria-invalid={!(Number(detailConcurrency) >= 1 && Number(detailConcurrency) <= 8)} onChange={event => { setDetailConcurrency(event.target.value) }} onBlur={saveConcurrency} /></label>
        <label><span>Auto-sync interval</span><select disabled={!settings.autoSync} value={settings.autoSyncMinutes} onChange={event => { void save({ ...settings, autoSyncMinutes: Number(event.target.value) }) }}><option value={30}>Every 30 minutes</option><option value={60}>Every hour</option><option value={180}>Every 3 hours</option><option value={720}>Every 12 hours</option><option value={1440}>Daily</option></select></label>
      </div>
      <div className="dsh_ref_actions"><button className="is_primary" type="button" disabled={state.sync?.status === 'running'} onClick={() => { void sync(PROVIDERS, 'incremental') }}>Sync all now</button><button type="button" disabled={state.sync?.status === 'running'} onClick={() => { void sync(PROVIDERS, 'full') }}>Full rescan</button>{state.sync?.status === 'running' && <button className="is_danger" type="button" onClick={() => { void cancel() }}>Cancel sync</button>}</div>
      {state.sync && <SyncProgress sync={state.sync} />}
      {state.sync?.error && <p className="dsh_ref_inline_error">{state.sync.error}</p>}
      {settings.autoSync && <p className="dsh_ref_auto_note">Automatic incremental sync runs about every {settings.autoSyncMinutes} minutes, for providers that have synced before. One that keeps failing is retried less often.</p>}
    </section>
    <ManageConversations state={state} syncing={state.sync?.status === 'running'} browse={browse} deleteConversation={deleteConversation} />
    </div>
  </section>
}

/** Progress of the job this tab started, including its terminal outcome. */
function SyncProgress({ sync }: { sync: SyncStatus }) {
  const pct = sync.total > 0 ? Math.min(100, Math.round((sync.completed / sync.total) * 100)) : sync.status === 'running' ? 0 : 100
  return <div className="dsh_ref_progress_wrap">
    <div className="dsh_ref_progress_track" role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(sync.total, 1)} aria-valuenow={sync.completed}>
      <div className={`dsh_ref_progress_fill is_${sync.status}`} style={{ width: `${pct}%` }} />
    </div>
    <p className="dsh_ref_progress_label">{sync.status}{sync.provider ? ` · ${PROVIDER_LABEL[sync.provider]}` : ''} · {sync.completed}/{sync.total}</p>
  </div>
}

interface ManageProps {
  state: SettingsSnapshot
  syncing: boolean
  browse(query: string, provider: ChatProvider | undefined, offset: number): Promise<void>
  deleteConversation(uriId: string): Promise<void>
}
/**
 * The local mirror as a list you can prune.
 *
 * Unlike the provider cards, which count what is indexed, this surfaces
 * individual rows — including ones the provider no longer lists, which are
 * exactly the ones worth deleting.
 */
export function ManageConversations({ state, syncing, browse, deleteConversation }: ManageProps) {
  const browseState = state.browse
  const [text, setText] = useState(browseState?.query ?? '')
  const debounce = useRef<ReturnType<typeof setTimeout>>()

  // First page once, when the panel mounts.
  useEffect(() => {
    if (browseState === undefined) void browse('', undefined, 0)
  }, [])

  // Typed text is debounced; provider and pagination changes fetch at once.
  useEffect(() => {
    if (text === (browseState?.query ?? '')) return
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => { void browse(text, browseState?.provider, 0) }, SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(debounce.current) }
  }, [text])

  const page = browseState?.page
  const items = page?.items ?? []
  const total = page?.total ?? 0
  const offset = browseState?.offset ?? 0

  return <section className="dsh_ref_panel dsh_ref_manage">
    <div className="dsh_ref_section_head"><div><h3>Manage synced conversations</h3><p>Everything mirrored locally, including conversations the provider no longer lists.</p></div></div>
    <div className="dsh_ref_manage_filters">
      <input placeholder="Search titles…" value={text} onChange={event => { setText(event.target.value) }} />
      <select value={browseState?.provider ?? ''} onChange={event => {
        void browse(text, (event.target.value || undefined) as ChatProvider | undefined, 0)
      }}>
        <option value="">All providers</option>
        {PROVIDERS.map(provider => <option key={provider} value={provider}>{PROVIDER_LABEL[provider]}</option>)}
      </select>
    </div>
    {items.length === 0
      ? <p className="dsh_ref_manage_empty">{page === undefined ? 'Loading…' : 'No synced conversations match.'}</p>
      : <ul className="dsh_ref_manage_list">
        {items.map(item => <li className="dsh_ref_manage_row" key={item.uriId}>
          <div className="dsh_ref_manage_main">
            <div className="dsh_ref_manage_title_row">
              <span className="dsh_ref_manage_title">{item.title}</span>
              <span className="dsh_ref_badge">{PROVIDER_LABEL[item.provider]}</span>
              {item.partial && <span className="dsh_ref_badge is_warn">partial</span>}
              {item.remoteMissing && <span className="dsh_ref_badge is_warn">no longer listed</span>}
            </div>
            <span className="dsh_ref_manage_meta">{item.turnCount} turns · updated {formatRelative(item.updatedAt)}</span>
          </div>
          <button type="button" className="is_danger" disabled={syncing}
            title={syncing ? 'Cannot delete while a sync is running' : undefined}
            onClick={() => {
              if (window.confirm(`Delete "${item.title}" from the local mirror? A later sync may bring it back.`)) void deleteConversation(item.uriId)
            }}>Delete</button>
        </li>)}
      </ul>}
    <div className="dsh_ref_pagination">
      <button type="button" disabled={offset === 0} onClick={() => { void browse(text, browseState?.provider, Math.max(0, offset - PAGE_SIZE)) }}>Previous</button>
      <span>{total === 0 ? '0 of 0' : `${offset + 1}–${offset + items.length} of ${total}`}</span>
      <button type="button" disabled={offset + items.length >= total} onClick={() => { void browse(text, browseState?.provider, offset + PAGE_SIZE) }}>Next</button>
    </div>
  </section>
}

function CheckRow({ label, detail, ready }: { label: string; detail: string; ready: boolean }) {
  return <div className="dsh_ref_check"><span className={ready ? 'is_ready' : ''}>{ready ? '✓' : '!'}</span><div><strong>{label}</strong><small>{detail}</small></div></div>
}

function ProviderCard({ provider, stats, busy, autoSync, onSync, index }: { provider: ChatProvider; stats?: ProviderStats; busy: boolean; autoSync: boolean; onSync(): void; index: number }) {
  const label = PROVIDER_LABEL[provider]
  const date = stats?.lastSyncedAt ? new Date(stats.lastSyncedAt).toLocaleString() : 'Never synced'
  return <article className={`dsh_ref_provider dsh_ref_provider_${provider}`} style={{ '--dsh-ref-index': index } as CSSProperties}><div className="dsh_ref_provider_top"><span className="dsh_ref_provider_mark"><ProviderLogo provider={provider} /></span><span className={`dsh_ref_status_dot is_${stats?.status || 'empty'}`} /><span>{stats?.status === 'error' ? 'Error' : stats?.status === 'syncing' ? 'Syncing' : stats?.conversations ? 'Connected' : 'Not synced'}</span></div><h4>{label}</h4><strong>{stats?.conversations ?? 0}</strong><p>local conversations</p><small>Last updated · {date}</small>{stats?.error && <em>{stats.error}</em>}<div className="dsh_ref_provider_foot"><span>{autoSync ? 'Auto sync on' : 'Manual sync'}</span><button type="button" disabled={busy} onClick={onSync}>Sync now</button></div></article>
}

function ProviderLogo({ provider }: { provider: ChatProvider }) {
  if (provider === 'chatgpt') return <OpenAIIcon size={22} />
  if (provider === 'claude') return <ClaudeIcon size={22} />
  if (provider === 'gemini') return <GeminiIcon size={22} />
  if (provider === 'deepseek') return <DeepSeekIcon size={22} />
  return <XAIIcon size={22} />
}
