import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { defaultPickerSettings, type ChatProvider, type PickerSettings, type PickerSource, type SettingsRecord } from '../wire.ts'
import type { BrowsePage, BrowserProfile, Health, ProviderStats, SyncStatus } from './remote.ts'
import { ProviderLogo } from './provider-icons.tsx'
import { type REFERENCE_ANYTHING_NS } from './locale.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'

interface Mention { label: string; uri: string; start: number; end: number }
const MENTION = /@\[([^\]]+)]\((dsh-ref:[A-Za-z0-9_-]+)\)/g
export function conversationMentions(value: string): Mention[] {
  return [...value.matchAll(MENTION)].map(match => ({ label: match[1]!, uri: match[2]!, start: match.index, end: match.index + match[0].length }))
}

export interface DockInjected { open(uri: string): void }
type DockProps = PropsRuntime<'conversation.input.dock'> & InjectFace<DockInjected> & { t: T }
export function ConversationsDock({ input, inputActions, open, t }: DockProps) {
  const rows = conversationMentions(input.draft)
  if (!rows.length) return null
  return <div className="dsh_ref_rail" role="group" aria-label={t('dock.aria')} data-reference-anything-dock>
    {rows.map(row => <span className="dsh_ref_chip" key={`${row.start}:${row.uri}`}>
      <button type="button" className="dsh_ref_open" title={row.label} onClick={() => { open(row.uri) }}><span className="dsh_ref_chip_mark" aria-hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a8 8 0 0 1-8.5 8A8.9 8.9 0 0 1 7.7 18.6L3.5 20l1.4-3.7A8 8 0 1 1 20 11.5Z"/></svg></span>{row.label}</button>
      <button type="button" className="dsh_ref_remove" aria-label={t('dock.remove', { label: row.label })} onClick={() => {
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
  restartDaemon(): Promise<void>
  browse(query: string, provider: ChatProvider | undefined, offset: number): Promise<void>
  deleteConversation(uriId: string): Promise<void>
  refreshStats(): Promise<void>
}
type T = TranslateNS<typeof REFERENCE_ANYTHING_NS>
type SettingsProps = PropsRuntime<'settings.section'> & InjectFace<SettingsInjected> & { t: T }
const PROVIDERS: ChatProvider[] = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi']
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
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok', kimi: 'Kimi',
}
const PICKER_SOURCES: ReadonlyArray<{ id: PickerSource; label: string }> = [
  { id: 'commands', label: 'Commands' },
  { id: 'skills', label: 'Skills' },
  { id: 'files', label: 'Files & folders' },
  { id: 'sessions', label: 'DSH sessions' },
  { id: 'conversations', label: 'External conversations' },
]
export function ConversationSettings({ useScope, save, sync, cancel, refresh, install, restartDaemon, browse, deleteConversation, refreshStats, t }: SettingsProps) {
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
  const picker = settings.picker ?? defaultPickerSettings()
  const savePicker = (next: PickerSettings) => { void save({ ...settings, picker: next }) }
  const patchPicker = (id: PickerSource, patch: Partial<PickerSettings[PickerSource]>) => {
    savePicker({ ...picker, [id]: { ...picker[id], ...patch } })
  }
  const movePicker = (id: PickerSource, direction: -1 | 1) => {
    const ids = [...PICKER_SOURCES].sort((a, b) => picker[a.id].order - picker[b.id].order).map(row => row.id)
    const index = ids.indexOf(id); const other = ids[index + direction]
    if (other === undefined) return
    savePicker({ ...picker, [id]: { ...picker[id], order: picker[other].order }, [other]: { ...picker[other], order: picker[id].order } })
  }
  return <section className="dsh_ref_settings">
    <header className="dsh_ref_header"><div><h2>{t('settings.title')}</h2><p>{t('settings.subtitle')}</p></div><button className="dsh_ref_recheck" type="button" onClick={() => { void refresh() }}>{t('settings.recheck')}</button></header>
    <div className="dsh_ref_workspace">
    {state.error && <div className="dsh_ref_error" role="alert"><strong>{t('settings.actionFailed')}</strong><span>{state.error}</span></div>}
    {state.notice && <div className="dsh_ref_notice" role="status">{state.notice}</div>}
    <section className="dsh_ref_panel dsh_ref_general_settings"><div className="dsh_ref_section_head"><div><h3>{t('settings.general')}</h3><p>{t('settings.generalDetail')}</p></div></div>
      <div className="dsh_ref_picker_list">{[...PICKER_SOURCES].sort((a, b) => picker[a.id].order - picker[b.id].order).map((row, index, rows) => <div className="dsh_ref_picker_row" key={row.id}>
        <label><input type="checkbox" checked={picker[row.id].enabled} onChange={event => { patchPicker(row.id, { enabled: event.target.checked }) }} /><span>{row.label}</span></label>
        <label className="dsh_ref_picker_limit"><span>{t('settings.maxItems')}</span><select value={picker[row.id].limit} onChange={event => { patchPicker(row.id, { limit: Number(event.target.value) }) }}>{[5, 8, 12, 20, 50].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <div className="dsh_ref_picker_order"><button type="button" disabled={index === 0} aria-label={t('settings.moveUp', { item: row.label })} onClick={() => { movePicker(row.id, -1) }}>↑</button><button type="button" disabled={index === rows.length - 1} aria-label={t('settings.moveDown', { item: row.label })} onClick={() => { movePicker(row.id, 1) }}>↓</button></div>
      </div>)}</div>
    </section>
    <section className="dsh_ref_panel"><div className="dsh_ref_section_head"><div><h3>{t('settings.viability')}</h3><p>{t('settings.viabilityDetail')}</p></div><span className={`dsh_ref_health ${ready ? 'is_ready' : ''}`}>{ready ? t('settings.ready') : t('settings.needsAttention')}</span></div>
      {state.loading ? <div className="dsh_ref_skeleton"><i/><i/><i/></div> : <div className="dsh_ref_checklist">
        <CheckRow label="OpenCLI" detail={state.health?.version || state.health?.versionError || t('settings.notDetected')} ready={Boolean(state.health?.version)} />
        <CheckRow label="Browser bridge" detail={state.health?.daemon || state.health?.daemonError || t('settings.daemonUnavailable')} ready={Boolean(state.health?.daemon)} />
        <CheckRow label="Conversation adapter" detail={state.health?.pluginInstalled ? t('settings.adapterInstalled') : state.health?.pluginError || t('settings.adapterMissing')} ready={Boolean(state.health?.pluginInstalled)} />
      </div>}
      <div className="dsh_ref_install"><div><strong>{t('settings.serviceActions')}</strong><span>{t('settings.serviceActionsDetail')}</span></div><div className="dsh_ref_service_actions"><button type="button" disabled={installing} onClick={() => { setInstalling(true); void install().finally(() => { setInstalling(false) }) }}>{installing ? t('settings.installing') : state.health?.pluginInstalled ? t('settings.reinstall') : t('settings.install')}</button><button type="button" onClick={() => { void restartDaemon() }}>{t('settings.restartDaemon')}</button></div></div>
    </section>
    <section className="dsh_ref_sources dsh_ref_chat"><div className="dsh_ref_section_head"><div><h3>{t('settings.sources')}</h3><p>{t('settings.sourcesDetail')}</p></div>{state.sync?.status === 'running' && <span className="dsh_ref_syncing">{t('settings.syncing', { source: t('settings.sources'), completed: state.sync.completed, total: state.sync.total })}</span>}</div>
      <div className="dsh_ref_provider_grid">{PROVIDERS.map((provider, index) => <ProviderCard key={provider} provider={provider} index={index} stats={state.stats?.find(row => row.provider === provider)} busy={state.sync?.status === 'running'} autoSync={settings.autoSync} onSync={(mode) => { void sync([provider], mode) }} t={t} />)}</div>
      {!state.loading && state.stats?.every(item => item.conversations === 0) && <div className="dsh_ref_empty">{t('settings.empty')}</div>}
      <div className="dsh_ref_chat_divider" />
      <div className="dsh_ref_sync_settings"><div className="dsh_ref_section_head"><div><h3>{t('settings.syncSettings')}</h3><p>{t('settings.syncSettingsDetail')}</p></div><label className="dsh_ref_toggle"><input type="checkbox" checked={settings.autoSync} onChange={event => { void save({ ...settings, autoSync: event.target.checked }) }} /><span/><b>{t('settings.autoSync')}</b></label></div>
      <div className="dsh_ref_form_grid">
        <label><span>{t('settings.historyMode')}</span><select value={settings.historyMode} onChange={event => { void save({ ...settings, historyMode: event.target.value as SettingsRecord['historyMode'] }) }}><option value="metadata-only">{t('settings.metadataOnly')}</option><option value="offline-mirror">{t('settings.offlineMirror')}</option></select></label>
        <label><span>{t('settings.opencli')}</span><input value={opencliPath} onChange={event => { setOpencliPath(event.target.value) }} onBlur={() => { if (opencliPath.trim()) void save({ ...settings, opencliPath: opencliPath.trim() }) }} /></label>
        <label><span>{t('settings.chromeProfile')}</span><select value={settings.profile} onChange={event => { void save({ ...settings, profile: event.target.value }) }}><option value="">{t('settings.defaultProfile')}</option>{state.profiles?.map(profile => <option key={profile.id} value={profile.alias || profile.id} disabled={!profile.connected}>{profile.alias ? `${profile.alias} · ${profile.id}` : profile.id}{profile.isDefault ? ` · ${t('settings.default')}` : ''}{profile.connected ? '' : ` · ${t('settings.disconnected')}`}</option>)}</select></label>
        <label><span>{t('settings.detailConcurrency')}</span><input type="number" min={1} max={8} value={detailConcurrency} aria-invalid={!(Number(detailConcurrency) >= 1 && Number(detailConcurrency) <= 8)} onChange={event => { setDetailConcurrency(event.target.value) }} onBlur={saveConcurrency} /></label>
        <label><span>{t('settings.interval')}</span><select disabled={!settings.autoSync} value={settings.autoSyncMinutes} onChange={event => { void save({ ...settings, autoSyncMinutes: Number(event.target.value) }) }}><option value={30}>{t('settings.every30')}</option><option value={60}>{t('settings.everyHour')}</option><option value={180}>{t('settings.every3Hours')}</option><option value={720}>{t('settings.every12Hours')}</option><option value={1440}>{t('settings.daily')}</option></select></label>
      </div>
      <p className="dsh_ref_auto_note">{settings.historyMode === 'metadata-only' ? t('settings.metadataOnlyDetail') : t('settings.offlineMirrorDetail')}</p>
      <div className="dsh_ref_actions"><button className="is_primary" type="button" disabled={state.sync?.status === 'running'} onClick={() => { void sync(PROVIDERS, 'incremental') }}>{t('settings.syncAll')}</button><button type="button" disabled={state.sync?.status === 'running'} onClick={() => { if (window.confirm(t('settings.fullConfirmAll'))) void sync(PROVIDERS, 'full') }}>{t('settings.fullRescanAll')}</button>{state.sync?.status === 'running' && <button className="is_danger" type="button" onClick={() => { void cancel() }}>{t('settings.cancel')}</button>}</div>
      {state.sync && <SyncProgress sync={state.sync} />}
      {state.sync?.error && <p className="dsh_ref_inline_error">{state.sync.error}</p>}
      {settings.autoSync && <p className="dsh_ref_auto_note">{t('settings.autoNote', { minutes: settings.autoSyncMinutes })}</p>}
      </div>
      <div className="dsh_ref_chat_divider" />
      <ManageConversations state={state} syncing={state.sync?.status === 'running'} browse={browse} deleteConversation={deleteConversation} />
    </section>
    </div>
  </section>
}

/** Progress of the job this tab started, including its terminal outcome. */
export function SyncProgress({ sync }: { sync: SyncStatus }) {
  const listing = sync.providerProgress.filter(row => row.phase === 'listing').length
  const pct = sync.total > 0 ? Math.min(100, Math.round((sync.completed / sync.total) * 100)) : sync.status === 'running' ? 0 : 100
  return <div className="dsh_ref_progress_wrap">
    <div className={`dsh_ref_progress_track${listing > 0 ? ' is_listing' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(sync.total, 1)} aria-valuenow={sync.completed} aria-valuetext={listing > 0 ? tProgressListing(listing, sync.completed, sync.total) : `${sync.completed}/${sync.total}`}>
      <div className={`dsh_ref_progress_fill is_${sync.status}`} style={{ width: `${pct}%` }} />
    </div>
    <p className="dsh_ref_progress_label">{sync.status} · {sync.completed}/{sync.total}{listing > 0 ? ` · ${listing} source${listing === 1 ? '' : 's'} listing` : ''}</p>
    <div className="dsh_ref_progress_sources">{sync.providerProgress.map(row => <span key={row.provider}><b>{PROVIDER_LABEL[row.provider]}</b><i>{row.phase === 'listing' ? 'listing…' : `${row.completed}/${row.total}`}</i></span>)}</div>
  </div>
}

function tProgressListing(listing: number, completed: number, total: number): string {
  return `${String(listing)} sources are still listing; ${String(completed)} of ${String(total)} discovered conversations processed`
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

  return <div className="dsh_ref_manage">
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
              {item.remoteMissing && <span className="dsh_ref_badge is_warn">no longer listed</span>}
            </div>
            <span className="dsh_ref_manage_meta">updated {formatUpdatedDate(item.updatedAt)}</span>
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
  </div>
}

function formatUpdatedDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleDateString()
}

function CheckRow({ label, detail, ready }: { label: string; detail: string; ready: boolean }) {
  return <div className="dsh_ref_check"><span className={ready ? 'is_ready' : ''}>{ready ? '✓' : '!'}</span><div><strong>{label}</strong><small>{detail}</small></div></div>
}

function ProviderCard({ provider, stats, busy, autoSync, onSync, index, t }: { provider: ChatProvider; stats?: ProviderStats; busy: boolean; autoSync: boolean; onSync(mode: 'incremental' | 'full'): void; index: number; t: T }) {
  const label = PROVIDER_LABEL[provider]
  const date = stats?.lastSyncedAt ? new Date(stats.lastSyncedAt).toLocaleString() : t('provider.neverSynced')
  return <article className={`dsh_ref_provider dsh_ref_provider_${provider}`} style={{ '--dsh-ref-index': index } as CSSProperties}><div className="dsh_ref_provider_top"><span className="dsh_ref_provider_mark"><ProviderLogo provider={provider} /></span><span className={`dsh_ref_status_dot is_${stats?.status || 'empty'}`} /><span>{stats?.status === 'error' ? t('provider.error') : stats?.status === 'syncing' ? t('provider.syncing') : stats?.conversations ? t('provider.connected') : t('provider.notSynced')}</span></div><h4>{label}</h4><strong>{stats?.conversations ?? 0}</strong><p>{t('provider.localConversations')}</p><small>{t('provider.lastUpdated', { date })}</small>{stats?.error && <em>{stats.error}</em>}<div className="dsh_ref_provider_foot"><span>{autoSync ? t('provider.autoSyncOn') : t('provider.manualSync')}</span><div className="dsh_ref_provider_actions"><button type="button" disabled={busy} onClick={() => { onSync('incremental') }}>{t('provider.syncNow')}</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(t('provider.fullConfirm', { provider: label }))) onSync('full') }}>{t('provider.fullResync')}</button></div></div></article>
}
