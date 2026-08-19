import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { defaultPickerSettings, type ChatProvider, type PickerSettings, type PickerSource, type SettingsRecord } from '../wire.ts'
import { syncProgressFraction, type BrowsePage, type BrowserProfile, type Health, type PackageUpdateStatus, type ProviderStats, type StorageStats, type SyncStatus } from './remote.ts'
import { ProviderLogo } from './provider-icons.tsx'
import { type REFERENCE_ANYTHING_NS } from './locale.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { OPENCLI_EXTENSION_STORE_URL, openExtensionStore, setupReady, type SetupStage } from './health.ts'

/** Current query/filter/page of the "Manage synced conversations" list, plus its last fetched page. */
export interface BrowseState { query: string; provider?: ChatProvider; offset: number; page?: BrowsePage }
export interface SettingsSnapshot { settings: SettingsRecord; health?: Health; update?: PackageUpdateStatus; profiles?: readonly BrowserProfile[]; stats?: readonly ProviderStats[]; storage?: StorageStats; sync?: SyncStatus; error?: string; notice?: string; loading?: boolean; browse?: BrowseState; setupStep?: SetupStage }
export interface SettingsInjected {
  hooks: { scope: ObservableSnapshot<SettingsSnapshot> }
  save(value: SettingsRecord): Promise<void>
  sync(providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
  refreshOnOpen(): Promise<void>
  setupAll(extensionPageOpened: boolean): Promise<void>
  discoverOpenCli(): Promise<void>
  installOpenCli(): Promise<void>
  useProfile(profile: string): Promise<void>
  install(): Promise<void>
  restartDaemon(): Promise<void>
  checkUpdate(): Promise<void>
  installUpdate(): Promise<void>
  browse(query: string, provider: ChatProvider | undefined, offset: number): Promise<void>
  deleteConversation(uriId: string): Promise<void>
  clearProvider(provider: ChatProvider): Promise<void>
  clearOlder(days: number): Promise<void>
  clearRemoteMissing?: () => Promise<void>
  clearOldAccounts?: () => Promise<void>
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
const REFERENCE_ANYTHING_LOGO = '__REFERENCE_ANYTHING_LOGO_DATA_URI__'
const GITHUB_REPOSITORY_URL = 'https://github.com/Chael-Chael/dsh-reference-anything'
export function ConversationSettings({ useScope, save, sync, cancel, refresh, refreshOnOpen, setupAll, discoverOpenCli, installOpenCli, useProfile, install, restartDaemon, checkUpdate, installUpdate, browse, deleteConversation, clearProvider, clearOlder, clearRemoteMissing, clearOldAccounts, refreshStats, t }: SettingsProps) {
  const state = useScope(value => value)
  const settings = state.settings
  const picker = settings.picker ?? defaultPickerSettings()
  const [busyAction, setBusyAction] = useState<string>()
  const busyActionRef = useRef(false)
  const automaticRefresh = useRef(refreshOnOpen)
  const checkedWhileEnabled = useRef(false)
  const [storeBlocked, setStoreBlocked] = useState(false)
  const [opencliPath, setOpencliPath] = useState(settings.opencliPath)
  const [profile, setProfile] = useState(settings.profile)
  const [detailConcurrency, setDetailConcurrency] = useState(String(settings.detailConcurrency))
  const [autoSyncMinutes, setAutoSyncMinutes] = useState(String(settings.autoSyncMinutes))
  const [cleanupDays, setCleanupDays] = useState('90')
  const [maxReadTurns, setMaxReadTurns] = useState(String(settings.maxReadTurns))
  const [repairProfile, setRepairProfile] = useState('')
  const [pickerLimits, setPickerLimits] = useState<Record<PickerSource, string>>(() => pickerLimitDrafts(picker))
  useEffect(() => { setOpencliPath(settings.opencliPath); setProfile(settings.profile); setDetailConcurrency(String(settings.detailConcurrency)); setAutoSyncMinutes(String(settings.autoSyncMinutes)); setMaxReadTurns(String(settings.maxReadTurns)) }, [settings.opencliPath, settings.profile, settings.detailConcurrency, settings.autoSyncMinutes, settings.maxReadTurns])
  useEffect(() => { setPickerLimits(pickerLimitDrafts(picker)) }, [picker.commands.limit, picker.skills.limit, picker.files.limit, picker.sessions.limit, picker.conversations.limit])
  automaticRefresh.current = refreshOnOpen
  useEffect(() => {
    if (!picker.conversations.enabled) {
      checkedWhileEnabled.current = false
      return
    }
    if (state.loading || checkedWhileEnabled.current) return
    checkedWhileEnabled.current = true
    void automaticRefresh.current()
  }, [picker.conversations.enabled, state.loading])
  const connectedProfiles = state.profiles?.filter(item => item.connected) ?? []
  useEffect(() => {
    if (!connectedProfiles.some(item => item.id === repairProfile)) setRepairProfile(connectedProfiles[0]?.id ?? '')
  }, [state.profiles, repairProfile])
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
  const syncMode = settings.autoSync ? 'interval' : settings.syncOnStartup ? 'startup' : 'manual'
  const enabled = new Set(settings.enabledProviders)
  const opencliReady = Boolean(state.health?.version && state.health.opencliCompatible)
  const daemonReady = Boolean(state.health?.daemonRunning && !state.health.daemonStale)
  const extensionReady = Boolean(state.health?.extensionConnected && state.health.connectivityOk)
  const adapterReady = Boolean(state.health?.pluginInstalled && state.health.adapterCompatible)
  const adapterNeedsRepair = Boolean(state.health?.pluginInstalled && !adapterReady)
  const runAction = (name: string, action: () => Promise<void>) => {
    if (busyActionRef.current || state.loading) return
    busyActionRef.current = true
    setBusyAction(name)
    void action().finally(() => { busyActionRef.current = false; setBusyAction(undefined) })
  }
  const openStore = (): boolean => {
    const opened = openExtensionStore()
    setStoreBlocked(!opened)
    return opened
  }
  const profileControl = connectedProfiles.length > 0 ? <div className="dsh_ref_check_profile">
    <select aria-label={t('settings.profileRecoveryChoice')} value={repairProfile} onChange={event => { setRepairProfile(event.target.value) }}>
      {connectedProfiles.map(item => <option key={item.id} value={item.id}>{item.alias || item.id}</option>)}
    </select>
    <button type="button" disabled={!repairProfile || Boolean(busyAction)} onClick={() => { runAction('profile', () => useProfile(repairProfile)) }}>{busyAction === 'profile' ? t('settings.applying') : t('settings.useProfile')}</button>
  </div> : undefined
  const needsProfileRecovery = state.health?.extensionState === 'profile-required' || state.health?.extensionState === 'profile-disconnected'
  let extensionActionLabel: string | undefined
  let extensionAction: (() => void) | undefined
  if (!opencliReady) {
    extensionActionLabel = t('settings.installOpenCli'); extensionAction = () => { runAction('opencli', installOpenCli) }
  } else if (!daemonReady || Boolean(state.health?.extensionConnected && !state.health.connectivityOk)) {
    extensionActionLabel = t('settings.restartDaemon'); extensionAction = () => { runAction('daemon', restartDaemon) }
  } else if (state.health?.extensionState === 'disconnected' || (needsProfileRecovery && !profileControl)) {
    extensionActionLabel = t('settings.openExtensionStore'); extensionAction = () => { runAction('extension', async () => { openStore() }) }
  }
  const extensionSecondaryLabel = state.health?.extensionState === 'disconnected' && daemonReady ? t('settings.restartDaemon') : undefined
  const setProviderEnabled = (provider: ChatProvider, value: boolean) => {
    const next = value ? [...new Set([...settings.enabledProviders, provider])] : settings.enabledProviders.filter(item => item !== provider)
    void save({ ...settings, enabledProviders: next })
  }
  const savePicker = (next: PickerSettings) => { void save({ ...settings, picker: next }) }
  const patchPicker = (id: PickerSource, patch: Partial<PickerSettings[PickerSource]>) => {
    savePicker({ ...picker, [id]: { ...picker[id], ...patch } })
  }
  const commitPickerLimit = (id: PickerSource) => {
    const value = Number(pickerLimits[id])
    if (Number.isInteger(value) && value >= 1 && value <= 50) {
      setPickerLimits(current => ({ ...current, [id]: String(value) }))
      if (value !== picker[id].limit) patchPicker(id, { limit: value })
      return
    }
    setPickerLimits(current => ({ ...current, [id]: String(picker[id].limit) }))
  }
  const movePicker = (id: PickerSource, direction: -1 | 1) => {
    const ids = [...PICKER_SOURCES].sort((a, b) => picker[a.id].order - picker[b.id].order).map(row => row.id)
    const index = ids.indexOf(id); const other = ids[index + direction]
    if (other === undefined) return
    savePicker({ ...picker, [id]: { ...picker[id], order: picker[other].order }, [other]: { ...picker[other], order: picker[id].order } })
  }
  return <section className="dsh_ref_settings">
    <div className="dsh_ref_notice_layer">{state.notice && <div className="dsh_ref_notice" role="status">{state.notice}</div>}</div>
    <header className="dsh_ref_header"><div className="dsh_ref_header_brand"><img src={REFERENCE_ANYTHING_LOGO} alt=""/><div><h2>{t('settings.title')}</h2><p>{t('settings.subtitle')}</p></div></div></header>
    <section className={`dsh_ref_update_bar${state.update?.updateAvailable ? ' is_available' : ''}`} aria-label={t('settings.updateTitle')}>
      <div className="dsh_ref_update_copy"><strong>{updateTitle(state.update, t)}</strong><small>{updateDetail(state.update, t)}</small></div>
      <div className="dsh_ref_update_actions">
        {state.update?.updateAvailable && <button className="is_primary" type="button" disabled={Boolean(busyAction)} onClick={() => {
          if (window.confirm(t('settings.updateConfirm', { version: state.update?.latestVersion ?? '' }))) runAction('package-update', installUpdate)
        }}>{busyAction === 'package-update' ? t('settings.updating') : t('settings.updateNow', { version: state.update.latestVersion })}</button>}
        <button type="button" disabled={Boolean(busyAction)} onClick={() => { runAction('update-check', checkUpdate) }}>{busyAction === 'update-check' ? t('settings.checkingUpdate') : t('settings.checkUpdate')}</button>
        <a className="dsh_ref_button" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer">{t('settings.github')}</a>
      </div>
    </section>
    <div className="dsh_ref_workspace">
    {state.error && <div className="dsh_ref_error" role="alert"><strong>{t('settings.actionFailed')}</strong><span>{state.error}</span></div>}
    <section className="dsh_ref_panel dsh_ref_general_settings"><div className="dsh_ref_section_head"><div><h3>{t('settings.general')}</h3><p>{t('settings.generalDetail')}</p></div></div>
      <label className="dsh_ref_render_mode"><span><b>{t('settings.inputRenderMode')}</b><small>{t('settings.inputRenderModeDetail')}</small></span><select value={settings.inputRenderMode} onChange={event => { void save({ ...settings, inputRenderMode: event.target.value as SettingsRecord['inputRenderMode'] }) }}><option value="pill">{t('settings.inputRenderPill')}</option><option value="raw-text">{t('settings.inputRenderRaw')}</option></select></label>
      <div className="dsh_ref_picker_list">{[...PICKER_SOURCES].sort((a, b) => picker[a.id].order - picker[b.id].order).map((row, index, rows) => <div className="dsh_ref_picker_row" key={row.id}>
        <label className="dsh_ref_toggle dsh_ref_picker_toggle"><input type="checkbox" checked={picker[row.id].enabled} onChange={event => { patchPicker(row.id, { enabled: event.target.checked }) }} /><span/><b>{t(SOURCE_KEYS[row.label])}</b></label>
        <label className="dsh_ref_picker_limit"><span>{t('settings.maxItems')}</span><input type="number" min={1} max={50} inputMode="numeric" value={pickerLimits[row.id]} aria-invalid={pickerLimits[row.id] !== '' && !validPickerLimit(pickerLimits[row.id])} onChange={event => { setPickerLimits(current => ({ ...current, [row.id]: event.target.value })) }} onBlur={() => { commitPickerLimit(row.id) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
        <div className="dsh_ref_picker_order"><button type="button" disabled={index === 0} aria-label={t('settings.moveUp', { item: t(SOURCE_KEYS[row.label]) })} onClick={() => { movePicker(row.id, -1) }}>↑</button><button type="button" disabled={index === rows.length - 1} aria-label={t('settings.moveDown', { item: t(SOURCE_KEYS[row.label]) })} onClick={() => { movePicker(row.id, 1) }}>↓</button></div>
      </div>)}</div>
    </section>
    <section className="dsh_ref_sources dsh_ref_chat"><div className="dsh_ref_section_head"><div><h3>{t('settings.sources')}</h3><p>{t('settings.sourcesDetail')}</p></div>{state.sync?.status === 'running' && <span className="dsh_ref_syncing">{t('settings.syncing', { source: t('settings.sources'), completed: state.sync.completed, total: state.sync.total })}</span>}</div>
      <section className="dsh_ref_viability"><div className="dsh_ref_section_head"><div><h3>{t('settings.viability')}</h3><p>{t('settings.viabilityDetail')}</p></div><div className="dsh_ref_viability_actions"><button className="dsh_ref_recheck" type="button" disabled={state.loading || Boolean(busyAction)} onClick={() => { runAction('refresh', refresh) }}>{busyAction === 'refresh' ? t('settings.checking') : t('settings.recheck')}</button></div></div>
        {state.loading ? <div className="dsh_ref_skeleton"><i/><i/><i/></div> : <div className="dsh_ref_checklist">
          <CheckRow label="OpenCLI" detail={openCliStateDetail(state.health, t)} ready={opencliReady}
            actionLabel={!state.health?.version ? t('settings.installOpenCli') : t('settings.upgradeOpenCli')} actionBusy={busyAction === 'opencli'} actionDisabled={Boolean(busyAction)} onAction={() => { runAction('opencli', installOpenCli) }}
            secondaryLabel={t('settings.findOpenCli')} onSecondary={() => { runAction('discover', discoverOpenCli) }} />
          <CheckRow label={t('check.browserBridge')} detail={daemonStateDetail(state.health, t)} ready={daemonReady}
            actionLabel={!opencliReady ? t('settings.installOpenCli') : t('settings.restartDaemon')} actionBusy={busyAction === 'daemon'} actionDisabled={Boolean(busyAction)} onAction={() => { runAction(!opencliReady ? 'opencli' : 'daemon', !opencliReady ? installOpenCli : restartDaemon) }} />
          <CheckRow label={t('check.browserExtension')} detail={extensionStateDetail(state.health, t)} ready={extensionReady}
            actionLabel={extensionActionLabel} actionBusy={busyAction === 'extension' || busyAction === 'daemon' || busyAction === 'opencli'} actionDisabled={Boolean(busyAction)} onAction={extensionAction}
            secondaryLabel={extensionSecondaryLabel} onSecondary={extensionSecondaryLabel ? () => { runAction('daemon', restartDaemon) } : undefined}
            control={needsProfileRecovery ? profileControl : undefined} />
          <CheckRow label={t('check.conversationAdapter')} detail={adapterStateDetail(state.health, t)} ready={adapterReady}
            actionLabel={!opencliReady ? t('settings.installOpenCli') : adapterNeedsRepair ? t('settings.repairAdapter') : state.health?.pluginInstalled ? t('settings.reinstall') : t('settings.install')}
            actionBusy={busyAction === 'adapter'} actionDisabled={Boolean(busyAction)} onAction={() => { runAction(!opencliReady ? 'opencli' : 'adapter', !opencliReady ? installOpenCli : install) }} />
        </div>}
        {storeBlocked && <p className="dsh_ref_store_fallback" role="alert">{t('settings.extensionStoreBlocked')} <a href={OPENCLI_EXTENSION_STORE_URL} target="_blank" rel="noreferrer">{t('settings.openExtensionStore')}</a></p>}
        {busyAction === 'setup' && state.setupStep && <p className="dsh_ref_setup_step" role="status">{t(`settings.setupStep.${state.setupStep}` as keyof typeof import('./locale.ts').zh)}</p>}
        <div className="dsh_ref_install"><div><strong>{t('settings.serviceActions')}</strong><span>{t('settings.serviceActionsDetail')}</span></div><div className="dsh_ref_service_actions"><button className="is_primary" type="button" disabled={state.loading || Boolean(busyAction)} onClick={() => { const opened = state.health?.extensionConnected ? true : openStore(); runAction('setup', () => setupAll(opened)) }}>{busyAction === 'setup' ? t('settings.settingUp') : t('settings.oneClickSetup')}</button></div></div>
      </section>
      <div className="dsh_ref_chat_divider" />
      <div className="dsh_ref_provider_grid">{PROVIDERS.map((provider, index) => <ProviderCard key={provider} provider={provider} index={index} stats={state.stats?.find(row => row.provider === provider)} busy={state.sync?.status === 'running'} autoSync={settings.autoSync} enabled={enabled.has(provider)} onEnabled={value => { setProviderEnabled(provider, value) }} onSync={(mode) => { void sync([provider], mode) }} onClear={() => { if (window.confirm(t('storage.clearProviderConfirm', { provider: PROVIDER_LABEL[provider] }))) void clearProvider(provider) }} t={t} />)}</div>
      {!state.loading && state.stats?.every(item => item.conversations === 0) && <div className="dsh_ref_empty">{t('settings.empty')}</div>}
      <div className="dsh_ref_chat_divider" />
      <div className="dsh_ref_sync_settings"><div className="dsh_ref_section_head"><div><h3>{t('settings.syncSettings')}</h3><p>{t('settings.syncSettingsDetail')}</p></div></div>
      <div className="dsh_ref_form_grid">
        <label><span>{t('settings.syncMode')}</span><select value={syncMode} onChange={event => { const mode = event.target.value; void save({ ...settings, autoSync: mode === 'interval', syncOnStartup: mode === 'startup' || mode === 'interval' }) }}><option value="manual">{t('settings.syncManual')}</option><option value="startup">{t('settings.syncStartup')}</option><option value="interval">{t('settings.syncInterval')}</option></select><small className="dsh_ref_field_note">{syncMode === 'manual' ? t('settings.syncManualDetail') : syncMode === 'startup' ? t('settings.syncStartupDetail') : t('settings.autoNote', { minutes: settings.autoSyncMinutes })}</small></label>
        <label><span>{t('settings.historyMode')}</span><select value={settings.historyMode} onChange={event => { void save({ ...settings, historyMode: event.target.value as SettingsRecord['historyMode'] }) }}><option value="metadata-only">{t('settings.metadataOnly')}</option><option value="offline-mirror">{t('settings.offlineMirror')}</option></select><small className="dsh_ref_field_note">{settings.historyMode === 'metadata-only' ? t('settings.metadataOnlyDetail') : t('settings.offlineMirrorDetail')}</small></label>
        <label><span>{t('settings.opencli')}</span><input value={opencliPath} onChange={event => { setOpencliPath(event.target.value) }} onBlur={() => { if (opencliPath.trim()) void save({ ...settings, opencliPath: opencliPath.trim() }).then(refresh) }} /><small className="dsh_ref_field_note">{t('settings.opencliDetail')}</small></label>
        <label><span>{t('settings.chromeProfile')}</span><input list="dsh-ref-profiles" value={profile} placeholder={t('settings.defaultProfile')} onChange={event => { setProfile(event.target.value) }} onBlur={() => { void save({ ...settings, profile: profile.trim() }).then(refresh) }} /><datalist id="dsh-ref-profiles">{state.profiles?.filter(item => item.connected).map(item => <option key={item.id} value={item.alias || item.id}>{item.id}</option>)}</datalist><small className="dsh_ref_field_note">{t('settings.chromeProfileDetail')}</small></label>
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
      <ManageConversations state={state} syncing={state.sync?.status === 'running'} browse={browse} deleteConversation={deleteConversation} clearRemoteMissing={clearRemoteMissing} clearOldAccounts={clearOldAccounts} t={t} />
    </section>
    </div>
  </section>
}

/** Progress of the job this tab started, including its terminal outcome. */
export function SyncProgress({ sync, t }: { sync: SyncStatus; t: T }) {
  const listing = sync.providerProgress.filter(row => row.phase === 'listing').length
  const pct = sync.status === 'running' ? Math.round(syncProgressFraction(sync) * 100) : 100
  return <div className="dsh_ref_progress_wrap">
    <div className={`dsh_ref_progress_track${listing > 0 ? ' is_listing' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={listing > 0 ? tProgressListing(listing, sync.completed, sync.total, t) : `${pct}% · ${sync.completed}/${sync.total}`}>
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
  clearRemoteMissing?: () => Promise<void>
  clearOldAccounts?: () => Promise<void>
  t: T
}
/**
 * The local mirror as a list you can prune.
 *
 * Unlike the provider cards, which count what is indexed, this surfaces
 * individual rows — including ones the provider no longer lists, which are
 * exactly the ones worth deleting.
 */
export function ManageConversations({ state, syncing, browse, deleteConversation, clearRemoteMissing, clearOldAccounts, t }: ManageProps) {
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
    <div className="dsh_ref_section_head"><div><h3>{t('manage.title')}</h3><p>{t('manage.detail')}</p></div><div className="dsh_ref_manage_actions"><button className="is_danger" type="button" disabled={syncing || !(state.storage?.oldAccountConversations) || !clearOldAccounts} title={syncing ? t('manage.deleteDisabled') : undefined} onClick={() => { if (window.confirm(t('manage.deleteOldAccountsConfirm'))) void clearOldAccounts?.() }}>{t('manage.deleteOldAccounts')}</button><button className="is_danger" type="button" disabled={syncing || !(state.storage?.remoteMissing) || !clearRemoteMissing} title={syncing ? t('manage.deleteDisabled') : undefined} onClick={() => { if (window.confirm(t('manage.deleteMissingConfirm'))) void clearRemoteMissing?.() }}>{t('manage.deleteMissing')}</button></div></div>
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

function CheckRow({ label, detail, ready, actionLabel, secondaryLabel, actionBusy, actionDisabled, onAction, onSecondary, control }: {
  label: string; detail: string; ready: boolean; actionLabel?: string; secondaryLabel?: string
  actionBusy?: boolean; actionDisabled?: boolean; onAction?: () => void; onSecondary?: () => void; control?: ReactNode
}) {
  return <div className="dsh_ref_check"><span className={ready ? 'is_ready' : 'is_error'}>{ready ? '✓' : '×'}</span><div className="dsh_ref_check_body"><strong>{label}</strong><small className={ready ? undefined : 'is_warning'}>{detail}</small>{!ready && (control || onAction || onSecondary) && <div className="dsh_ref_check_actions">{control}{onAction && actionLabel && <button type="button" aria-busy={actionBusy} disabled={actionDisabled} onClick={onAction}>{actionBusy ? `${actionLabel}…` : actionLabel}</button>}{onSecondary && secondaryLabel && <button type="button" disabled={actionDisabled} onClick={onSecondary}>{secondaryLabel}</button>}</div>}</div></div>
}

function updateTitle(update: PackageUpdateStatus | undefined, t: T): string {
  if (!update) return t('settings.updateTitle')
  if (update.updateAvailable) return t('settings.updateAvailable', { version: update.latestVersion })
  if (update.error) return t('settings.updateCheckFailed')
  return t('settings.upToDate', { version: update.currentVersion })
}

function updateDetail(update: PackageUpdateStatus | undefined, t: T): string {
  if (!update) return t('settings.updateCheckingAutomatically')
  if (update.error) return update.error
  if (update.updateAvailable) return t('settings.updateAvailableDetail', { current: update.currentVersion, latest: update.latestVersion })
  return t('settings.upToDateDetail')
}

function pickerLimitDrafts(picker: PickerSettings): Record<PickerSource, string> {
  return { commands: String(picker.commands.limit), skills: String(picker.skills.limit), files: String(picker.files.limit), sessions: String(picker.sessions.limit), conversations: String(picker.conversations.limit) }
}

export function validPickerLimit(value: string): boolean {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50
}

function openCliStateDetail(health: Health | undefined, t: T): string {
  if (!health?.version) return health?.versionError || t('settings.notDetected')
  if (!health.opencliCompatible) return t('settings.opencliVersionUnsupported', { version: health.version })
  return `v${health.version}`
}

function daemonStateDetail(health: Health | undefined, t: T): string {
  if (!health?.daemonRunning) return health?.daemonError || t('settings.daemonNotRunning')
  if (health.daemonStale) return t('settings.daemonStale', { version: health.daemonVersion || t('settings.unknownVersion') })
  return health.daemonVersion ? t('settings.daemonRunningVersion', { version: health.daemonVersion }) : t('settings.daemonRunning')
}

function adapterStateDetail(health: Health | undefined, t: T): string {
  if (!health?.pluginInstalled) return health?.pluginError || t('settings.adapterMissing')
  if (health.pluginError) return t('settings.adapterLoadFailed', { error: health.pluginError })
  if (!health.adapterCommandsReady) return t('settings.adapterIncomplete')
  if (!health.adapterCompatible) return t('settings.adapterVersionUnsupported', { version: health.pluginVersion || t('settings.unknownVersion') })
  return health.pluginVersion ? t('settings.adapterInstalledVersion', { version: health.pluginVersion }) : t('settings.adapterInstalled')
}

function extensionStateDetail(health: Health | undefined, t: T): string {
  if (!health) return t('settings.extensionDisconnected')
  if (health.extensionConnected && !health.connectivityOk) return health.doctorError || t('settings.extensionConnectivityFailed')
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
