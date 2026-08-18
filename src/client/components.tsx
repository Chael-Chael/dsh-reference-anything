import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { defaultPickerSettings, type ChatProvider, type PickerSettings, type PickerSource, type SettingsRecord } from '../wire.ts'
import type { BrowsePage, BrowserProfile, Health, ProviderStats, StorageStats, SyncStatus } from './remote.ts'
import { ProviderLogo } from './provider-icons.tsx'
import { type REFERENCE_ANYTHING_NS } from './locale.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'

/** Current query/filter/page of the "Manage synced conversations" list, plus its last fetched page. */
export interface BrowseState { query: string; provider?: ChatProvider; offset: number; page?: BrowsePage }

export interface SettingsSnapshot { settings: SettingsRecord; health?: Health; profiles?: readonly BrowserProfile[]; stats?: readonly ProviderStats[]; storage?: StorageStats; sync?: SyncStatus; error?: string; notice?: string; loading?: boolean; browse?: BrowseState }
export interface SettingsInjected {
  hooks: { scope: ObservableSnapshot<SettingsSnapshot> }
  save(value: SettingsRecord): Promise<void>
  sync(providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
  setupAll(): Promise<void>
  install(): Promise<void>
  restartDaemon(): Promise<void>
  browse(query: string, provider: ChatProvider | undefined, offset: number): Promise<void>
  deleteConversation(uriId: string): Promise<void>
  clearProvider(provider: ChatProvider): Promise<void>
  clearOlder(days: number): Promise<void>
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
const PICKER_SOURCES: ReadonlyArray<{ id: PickerSource; label: keyof typeof SOURCE_KEYS }> = [
  { id: 'commands', label: 'commands' },
  { id: 'skills', label: 'skills' },
  { id: 'files', label: 'files' },
  { id: 'sessions', label: 'sessions' },
  { id: 'conversations', label: 'conversations' },
]
const SOURCE_KEYS = { commands: 'source.commands', skills: 'source.skills', files: 'source.files', sessions: 'source.sessions', conversations: 'source.conversations' } as const
export function ConversationSettings({ useScope, save, sync, cancel, refresh, setupAll, install, restartDaemon, browse, deleteConversation, clearProvider, clearOlder, refreshStats, t }: SettingsProps) {
  const state = useScope(value => value)
  const settings = state.settings
  const [installing, setInstalling] = useState(false)
  const [settingUp, setSettingUp] = useState(false)
  const [opencliPath, setOpencliPath] = useState(settings.opencliPath)
  const [profile, setProfile] = useState(settings.profile)
  const [detailConcurrency, setDetailConcurrency] = useState(String(settings.detailConcurrency))
  const [autoSyncMinutes, setAutoSyncMinutes] = useState(String(settings.autoSyncMinutes))
  const [cleanupDays, setCleanupDays] = useState('90')
  const [maxReadTurns, setMaxReadTurns] = useState(String(settings.maxReadTurns))
  useEffect(() => { setOpencliPath(settings.opencliPath); setProfile(settings.profile); setDetailConcurrency(String(settings.detailConcurrency)); setAutoSyncMinutes(String(settings.autoSyncMinutes)); setMaxReadTurns(String(settings.maxReadTurns)) }, [settings.opencliPath, settings.profile, settings.detailConcurrency, settings.autoSyncMinutes, settings.maxReadTurns])
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
  const saveConcurrency = () => {
    const value = Number(detailConcurrency)
    if (Number.isInteger(value) && value >= 1 && value <= 8) void save({ ...settings, detailConcurrency: value })
  }
  const saveAutoSyncMinutes = () => {
    const value = Number(autoSyncMinutes)
    if (Number.isInteger(value) && value >= 15 && value <= 1440) void save({ ...settings, autoSyncMinutes: value })
  }
  const autoSyncMinutesValue = Number(autoSyncMinutes)
  const hasValidAutoSyncMinutes = Number.isInteger(autoSyncMinutesValue) && autoSyncMinutesValue >= 15 && autoSyncMinutesValue <= 1440
  const picker = settings.picker ?? defaultPickerSettings()
  const syncMode = settings.autoSync ? 'interval' : settings.syncOnStartup ? 'startup' : 'manual'
  const enabled = new Set(settings.enabledProviders)
  const setProviderEnabled = (provider: ChatProvider, value: boolean) => {
    const next = value ? [...new Set([...settings.enabledProviders, provider])] : settings.enabledProviders.filter(item => item !== provider)
    void save({ ...settings, enabledProviders: next })
  }
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
    <header className="dsh_ref_header"><div><h2>{t('settings.title')}</h2><p>{t('settings.subtitle')}</p></div></header>
    <div className="dsh_ref_workspace">
    {state.error && <div className="dsh_ref_error" role="alert"><strong>{t('settings.actionFailed')}</strong><span>{state.error}</span></div>}
    {state.notice && <div className="dsh_ref_notice" role="status">{state.notice}</div>}
    <section className="dsh_ref_panel dsh_ref_general_settings"><div className="dsh_ref_section_head"><div><h3>{t('settings.general')}</h3><p>{t('settings.generalDetail')}</p></div></div>
      <div className="dsh_ref_picker_list">{[...PICKER_SOURCES].sort((a, b) => picker[a.id].order - picker[b.id].order).map((row, index, rows) => <div className="dsh_ref_picker_row" key={row.id}>
        <label className="dsh_ref_toggle dsh_ref_picker_toggle"><input type="checkbox" checked={picker[row.id].enabled} onChange={event => { patchPicker(row.id, { enabled: event.target.checked }) }} /><span/><b>{t(SOURCE_KEYS[row.label])}</b></label>
        <label className="dsh_ref_picker_limit"><span>{t('settings.maxItems')}</span><input type="number" min={1} max={50} inputMode="numeric" value={picker[row.id].limit} onChange={event => { const limit = Number(event.target.value); if (Number.isInteger(limit) && limit >= 1 && limit <= 50) patchPicker(row.id, { limit }) }} /></label>
        <div className="dsh_ref_picker_order"><button type="button" disabled={index === 0} aria-label={t('settings.moveUp', { item: t(SOURCE_KEYS[row.label]) })} onClick={() => { movePicker(row.id, -1) }}>↑</button><button type="button" disabled={index === rows.length - 1} aria-label={t('settings.moveDown', { item: t(SOURCE_KEYS[row.label]) })} onClick={() => { movePicker(row.id, 1) }}>↓</button></div>
      </div>)}</div>
    </section>
    <section className="dsh_ref_sources dsh_ref_chat"><div className="dsh_ref_section_head"><div><h3>{t('settings.sources')}</h3><p>{t('settings.sourcesDetail')}</p></div>{state.sync?.status === 'running' && <span className="dsh_ref_syncing">{t('settings.syncing', { source: t('settings.sources'), completed: state.sync.completed, total: state.sync.total })}</span>}</div>
      <section className="dsh_ref_viability"><div className="dsh_ref_section_head"><div><h3>{t('settings.viability')}</h3><p>{t('settings.viabilityDetail')}</p></div><div className="dsh_ref_viability_actions"><button className="dsh_ref_recheck" type="button" onClick={() => { void refresh() }}>{t('settings.recheck')}</button></div></div>
        {state.loading ? <div className="dsh_ref_skeleton"><i/><i/><i/></div> : <div className="dsh_ref_checklist">
          <CheckRow label="OpenCLI" detail={state.health?.version || state.health?.versionError || t('settings.notDetected')} ready={Boolean(state.health?.version)} />
          <CheckRow label={t('check.browserBridge')} detail={state.health?.daemonRunning ? t('settings.daemonRunning') : state.health?.daemonError || t('settings.daemonNotRunning')} ready={Boolean(state.health?.daemonRunning)} />
          <CheckRow label={t('check.browserExtension')} detail={extensionStateDetail(state.health, t)} ready={Boolean(state.health?.extensionConnected)} />
          <CheckRow label={t('check.conversationAdapter')} detail={state.health?.pluginInstalled ? t('settings.adapterInstalled') : state.health?.pluginError || t('settings.adapterMissing')} ready={Boolean(state.health?.pluginInstalled)} />
        </div>}
        <div className="dsh_ref_install"><div><strong>{t('settings.serviceActions')}</strong><span>{t('settings.serviceActionsDetail')}</span></div><div className="dsh_ref_service_actions"><button className="is_primary" type="button" disabled={settingUp} onClick={() => { setSettingUp(true); void setupAll().finally(() => { setSettingUp(false) }) }}>{settingUp ? t('settings.settingUp') : t('settings.oneClickSetup')}</button><button type="button" disabled={installing} onClick={() => { setInstalling(true); void install().finally(() => { setInstalling(false) }) }}>{installing ? t('settings.installing') : state.health?.pluginInstalled ? t('settings.reinstall') : t('settings.install')}</button><button type="button" onClick={() => { void restartDaemon() }}>{t('settings.restartDaemon')}</button></div></div>
      </section>
      <div className="dsh_ref_chat_divider" />
      <div className="dsh_ref_provider_grid">{PROVIDERS.map((provider, index) => <ProviderCard key={provider} provider={provider} index={index} stats={state.stats?.find(row => row.provider === provider)} busy={state.sync?.status === 'running'} autoSync={settings.autoSync} enabled={enabled.has(provider)} onEnabled={value => { setProviderEnabled(provider, value) }} onSync={(mode) => { void sync([provider], mode) }} onClear={() => { if (window.confirm(t('storage.clearProviderConfirm', { provider: PROVIDER_LABEL[provider] }))) void clearProvider(provider) }} t={t} />)}</div>
      {!state.loading && state.stats?.every(item => item.conversations === 0) && <div className="dsh_ref_empty">{t('settings.empty')}</div>}
      <div className="dsh_ref_chat_divider" />
      <div className="dsh_ref_sync_settings"><div className="dsh_ref_section_head"><div><h3>{t('settings.syncSettings')}</h3><p>{t('settings.syncSettingsDetail')}</p></div></div>
      <div className="dsh_ref_form_grid">
        <label><span>{t('settings.syncMode')}</span><select value={syncMode} onChange={event => { const mode = event.target.value; void save({ ...settings, autoSync: mode === 'interval', syncOnStartup: mode === 'startup' || mode === 'interval' }) }}><option value="manual">{t('settings.syncManual')}</option><option value="startup">{t('settings.syncStartup')}</option><option value="interval">{t('settings.syncInterval')}</option></select><small className="dsh_ref_field_note">{syncMode === 'manual' ? t('settings.syncManualDetail') : syncMode === 'startup' ? t('settings.syncStartupDetail') : t('settings.autoNote', { minutes: settings.autoSyncMinutes })}</small></label>
        <label><span>{t('settings.historyMode')}</span><select value={settings.historyMode} onChange={event => { void save({ ...settings, historyMode: event.target.value as SettingsRecord['historyMode'] }) }}><option value="metadata-only">{t('settings.metadataOnly')}</option><option value="offline-mirror">{t('settings.offlineMirror')}</option></select><small className="dsh_ref_field_note">{settings.historyMode === 'metadata-only' ? t('settings.metadataOnlyDetail') : t('settings.offlineMirrorDetail')}</small></label>
        <label><span>{t('settings.opencli')}</span><input value={opencliPath} onChange={event => { setOpencliPath(event.target.value) }} onBlur={() => { if (opencliPath.trim()) void save({ ...settings, opencliPath: opencliPath.trim() }) }} /><small className="dsh_ref_field_note">{t('settings.opencliDetail')}</small></label>
        <label><span>{t('settings.chromeProfile')}</span><input list="dsh-ref-profiles" value={profile} placeholder={t('settings.defaultProfile')} onChange={event => { setProfile(event.target.value) }} onBlur={() => { void save({ ...settings, profile: profile.trim() }) }} /><datalist id="dsh-ref-profiles">{state.profiles?.filter(item => item.connected).map(item => <option key={item.id} value={item.alias || item.id}>{item.id}</option>)}</datalist><small className="dsh_ref_field_note">{t('settings.chromeProfileDetail')}</small></label>
        <label><span>{t('settings.detailConcurrency')}</span><input type="number" min={1} max={8} value={detailConcurrency} aria-invalid={!(Number(detailConcurrency) >= 1 && Number(detailConcurrency) <= 8)} onChange={event => { setDetailConcurrency(event.target.value) }} onBlur={saveConcurrency} /><small className="dsh_ref_field_note">{t('settings.detailConcurrencyDetail')}</small></label>
        <label><span>{t('settings.maxReadTurns')}</span><input type="number" min={1} max={100} value={maxReadTurns} aria-invalid={!(Number(maxReadTurns) >= 1 && Number(maxReadTurns) <= 100)} onChange={event => { setMaxReadTurns(event.target.value) }} onBlur={() => { const value = Number(maxReadTurns); if (Number.isInteger(value) && value >= 1 && value <= 100) void save({ ...settings, maxReadTurns: value }) }} /><small className="dsh_ref_field_note">{t('settings.maxReadTurnsDetail')}</small></label>
        <label><span>{t('settings.interval')}</span><input type="number" min={15} max={1440} inputMode="numeric" disabled={!settings.autoSync} value={autoSyncMinutes} aria-invalid={!hasValidAutoSyncMinutes} onChange={event => { setAutoSyncMinutes(event.target.value) }} onBlur={saveAutoSyncMinutes} />{settings.autoSync && <small className="dsh_ref_field_note">{t('settings.autoNote', { minutes: settings.autoSyncMinutes })}</small>}</label>
      </div>
      <div className="dsh_ref_actions"><button className="is_primary" type="button" disabled={state.sync?.status === 'running' || settings.enabledProviders.length === 0} onClick={() => { void sync(settings.enabledProviders, 'incremental') }}>{t('settings.syncAll')}</button><button type="button" disabled={state.sync?.status === 'running' || settings.enabledProviders.length === 0} onClick={() => { if (window.confirm(t('settings.fullConfirmAll'))) void sync(settings.enabledProviders, 'full') }}>{t('settings.fullRescanAll')}</button>{state.sync?.status === 'running' && <button className="is_danger" type="button" onClick={() => { void cancel() }}>{t('settings.cancel')}</button>}</div>
      {state.sync && <SyncProgress sync={state.sync} t={t} />}
      {state.sync?.error && <p className="dsh_ref_inline_error">{state.sync.error}</p>}
      </div>
      <div className="dsh_ref_chat_divider" />
      <section className="dsh_ref_storage"><div className="dsh_ref_storage_header"><div><h3>{t('storage.title')}</h3><p>{t('storage.detail')}</p></div><div className="dsh_ref_storage_metric"><span>{t('storage.usage')}</span><strong>{formatBytes(state.storage?.bytes ?? 0)}</strong></div></div><div className="dsh_ref_storage_cleanup"><label><span>{t('storage.olderThan')}</span><div className="dsh_ref_number_field"><input type="number" min={1} max={36500} value={cleanupDays} onChange={event => { setCleanupDays(event.target.value) }} /><b>{t('storage.days')}</b></div></label><button className="is_danger" type="button" disabled={state.sync?.status === 'running' || !(Number(cleanupDays) >= 1)} onClick={() => { const days = Number(cleanupDays); if (window.confirm(t('storage.clearOlderConfirm', { days }))) void clearOlder(days) }}>{t('storage.clearOlder')}</button></div></section>
      <div className="dsh_ref_chat_divider" />
      <ManageConversations state={state} syncing={state.sync?.status === 'running'} browse={browse} deleteConversation={deleteConversation} t={t} />
    </section>
    </div>
  </section>
}

/** Progress of the job this tab started, including its terminal outcome. */
export function SyncProgress({ sync, t }: { sync: SyncStatus; t: T }) {
  const listing = sync.providerProgress.filter(row => row.phase === 'listing').length
  const pct = sync.total > 0 ? Math.min(100, Math.round((sync.completed / sync.total) * 100)) : sync.status === 'running' ? 0 : 100
  return <div className="dsh_ref_progress_wrap">
    <div className={`dsh_ref_progress_track${listing > 0 ? ' is_listing' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(sync.total, 1)} aria-valuenow={sync.completed} aria-valuetext={listing > 0 ? tProgressListing(listing, sync.completed, sync.total, t) : `${sync.completed}/${sync.total}`}>
      <div className={`dsh_ref_progress_fill is_${sync.status}`} style={{ width: `${pct}%` }} />
    </div>
    <p className="dsh_ref_progress_label">{t(syncStatusKey(sync.status))} · {sync.completed}/{sync.total}{listing > 0 ? ` · ${t('sync.progressSourcesListing', { count: listing })}` : ''}</p>
    <div className="dsh_ref_progress_sources">{sync.providerProgress.map(row => <span key={row.provider}><b>{PROVIDER_LABEL[row.provider]}</b><i>{row.phase === 'listing' ? t('sync.progressSourceListing') : `${row.completed}/${row.total}`}</i></span>)}</div>
  </div>
}

function tProgressListing(listing: number, completed: number, total: number, t: T): string {
  return t('sync.progressListing', { listing, completed, total })
}

function syncStatusKey(status: SyncStatus['status']): 'sync.running' | 'sync.complete' | 'sync.partial' | 'sync.cancelled' | 'sync.failed' {
  return `sync.${status}` as 'sync.running' | 'sync.complete' | 'sync.partial' | 'sync.cancelled' | 'sync.failed'
}

interface ManageProps {
  state: SettingsSnapshot
  syncing: boolean
  browse(query: string, provider: ChatProvider | undefined, offset: number): Promise<void>
  deleteConversation(uriId: string): Promise<void>
  t: T
}
/**
 * The local mirror as a list you can prune.
 *
 * Unlike the provider cards, which count what is indexed, this surfaces
 * individual rows — including ones the provider no longer lists, which are
 * exactly the ones worth deleting.
 */
export function ManageConversations({ state, syncing, browse, deleteConversation, t }: ManageProps) {
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
    <div className="dsh_ref_section_head"><div><h3>{t('manage.title')}</h3><p>{t('manage.detail')}</p></div></div>
    <div className="dsh_ref_manage_filters">
      <input placeholder={t('manage.searchPlaceholder')} value={text} onChange={event => { setText(event.target.value) }} />
      <select value={browseState?.provider ?? ''} onChange={event => {
        void browse(text, (event.target.value || undefined) as ChatProvider | undefined, 0)
      }}>
        <option value="">{t('manage.allProviders')}</option>
        {PROVIDERS.map(provider => <option key={provider} value={provider}>{PROVIDER_LABEL[provider]}</option>)}
      </select>
    </div>
    {items.length === 0
      ? <p className="dsh_ref_manage_empty">{page === undefined ? t('manage.loading') : t('manage.empty')}</p>
      : <ul className="dsh_ref_manage_list">
        {items.map(item => <li className="dsh_ref_manage_row" key={item.uriId}>
          <div className="dsh_ref_manage_main">
            <div className="dsh_ref_manage_title_row">
              <span className="dsh_ref_manage_title">{item.title}</span>
              <span className="dsh_ref_badge">{PROVIDER_LABEL[item.provider]}</span>
              {item.remoteMissing && <span className="dsh_ref_badge is_warn">{t('manage.noLongerListed')}</span>}
            </div>
            <span className="dsh_ref_manage_meta">{t('manage.updated', { date: formatUpdatedDate(item.updatedAt, t) })}</span>
          </div>
          <button type="button" className="is_danger" disabled={syncing}
            title={syncing ? t('manage.deleteDisabled') : undefined}
            onClick={() => {
              if (window.confirm(t('manage.deleteConfirm', { title: item.title }))) void deleteConversation(item.uriId)
            }}>{t('manage.delete')}</button>
        </li>)}
      </ul>}
    <div className="dsh_ref_pagination">
      <button type="button" disabled={offset === 0} onClick={() => { void browse(text, browseState?.provider, Math.max(0, offset - PAGE_SIZE)) }}>{t('manage.previous')}</button>
      <span>{total === 0 ? t('manage.paginationEmpty') : t('manage.pagination', { start: offset + 1, end: offset + items.length, total })}</span>
      <button type="button" disabled={offset + items.length >= total} onClick={() => { void browse(text, browseState?.provider, offset + PAGE_SIZE) }}>{t('manage.next')}</button>
    </div>
  </div>
}

function formatUpdatedDate(value: string, t: T): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? t('conversation.unknownDate') : date.toLocaleDateString()
}

function CheckRow({ label, detail, ready }: { label: string; detail: string; ready: boolean }) {
  return <div className="dsh_ref_check"><span className={ready ? 'is_ready' : 'is_error'}>{ready ? '✓' : '×'}</span><div><strong>{label}</strong><small className={ready ? undefined : 'is_warning'}>{detail}</small></div></div>
}

function extensionStateDetail(health: Health | undefined, t: T): string {
  if (!health) return t('settings.extensionDisconnected')
  switch (health.extensionState) {
    case 'connected': return health.extensionVersion ? t('settings.extensionConnected', { version: health.extensionVersion }) : t('settings.extensionConnectedUnknown')
    case 'profile-required': return t('settings.extensionProfileRequired', { count: health.profileCount ?? 0 })
    case 'profile-disconnected': return t('settings.extensionProfileDisconnected')
    case 'daemon-offline': return t('settings.daemonNotRunning')
    default: return t('settings.extensionDisconnected')
  }
}

function ProviderCard({ provider, stats, busy, autoSync, enabled, onEnabled, onSync, onClear, index, t }: { provider: ChatProvider; stats?: ProviderStats; busy: boolean; autoSync: boolean; enabled: boolean; onEnabled(value: boolean): void; onSync(mode: 'incremental' | 'full'): void; onClear(): void; index: number; t: T }) {
  const label = PROVIDER_LABEL[provider]
  const date = stats?.lastSyncedAt ? new Date(stats.lastSyncedAt).toLocaleString() : t('provider.neverSynced')
  return <article className={`dsh_ref_provider dsh_ref_provider_${provider}`} style={{ '--dsh-ref-index': index } as CSSProperties}><span className="dsh_ref_provider_mark"><ProviderLogo provider={provider} /></span><div className="dsh_ref_provider_content"><div className="dsh_ref_provider_summary"><h4>{label}</h4><strong>{stats?.conversations ?? 0}<span>{t('provider.localConversations')}</span></strong><small>{t('provider.lastUpdated', { date })}</small></div><div className="dsh_ref_provider_controls"><label className="dsh_ref_toggle"><input type="checkbox" checked={enabled} onChange={event => { onEnabled(event.target.checked) }} /><span/><b>{t('provider.enabled')}</b></label><div className="dsh_ref_provider_actions"><button type="button" disabled={busy} onClick={() => { onSync('incremental') }}>{t('provider.syncNow')}</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(t('provider.fullConfirm', { provider: label }))) onSync('full') }}>{t('provider.fullResync')}</button><button className="is_danger" type="button" disabled={busy || !stats?.conversations} onClick={onClear}>{t('storage.clearProvider')}</button></div></div>{stats?.error && <em className="dsh_ref_provider_error">{stats.error}</em>}</div></article>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `≈ ${bytes} B`
  if (bytes < 1024 ** 2) return `≈ ${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `≈ ${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `≈ ${(bytes / 1024 ** 3).toFixed(1)} GiB`
}
