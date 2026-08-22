import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ALL_LOCAL_AGENTS, LOCAL_AGENT_LABEL, defaultPickerSettings, type ChatProvider, type LocalAgent, type PickerSettings, type PickerSource, type SettingsRecord } from '../wire.ts'
import { syncProgressFraction, type BrowsePage, type BrowserProfile, type Health, type OpenListDriver, type OpenListMount, type OpenListStatus, type PackageUpdateStatus, type ProviderStats, type StorageStats, type SyncStatus } from './remote.ts'
import { AgentLogo, ProviderLogo } from './provider-icons.tsx'
import { type REFERENCE_ANYTHING_NS } from './locale.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { OPENCLI_EXTENSION_STORE_URL, openExtensionStore, setupReady, type SetupStage } from './health.ts'

/** Current query/filter/page of the "Manage synced conversations" list, plus its last fetched page. */
export interface BrowseState { query: string; provider?: ChatProvider; offset: number; page?: BrowsePage }
export interface SettingsSnapshot { settings: SettingsRecord; health?: Health; update?: PackageUpdateStatus; profiles?: readonly BrowserProfile[]; stats?: readonly ProviderStats[]; storage?: StorageStats; sync?: SyncStatus; openList?: OpenListStatus; openListDrivers?: readonly OpenListDriver[]; openListMounts?: readonly OpenListMount[]; error?: string; notice?: string; loading?: boolean; browse?: BrowseState; setupStep?: SetupStage }
export interface SettingsInjected {
  hooks: { scope: ObservableSnapshot<SettingsSnapshot> }
  save(value: SettingsRecord): Promise<void>
  sync(providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
  refreshOpenList?(): Promise<void>
  quickRefreshOnOpen?(): Promise<void>
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
  openListInstall?(): Promise<void>
  openListUpgrade?(rollback?: boolean): Promise<void>
  openListConnectExternal?(input: { endpoint: string; username?: string; password?: string; token?: string }): Promise<void>
  openListDisconnect?(): Promise<void>
  openListCreateMount?(input: { id?: string; mountPath: string; driver: string; addition: Record<string, unknown> }): Promise<void>
  openListDisableMount?(id: string, disabled?: boolean): Promise<void>
  openListRemoveMount?(id: string): Promise<void>
  openListReindex?(id: string): Promise<{ supported: boolean; reason?: string }>
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
  { id: 'agents', label: 'agents' },
  { id: 'drives', label: 'drives' },
  { id: 'conversations', label: 'conversations' },
]
const SOURCE_KEYS = { commands: 'source.commands', skills: 'source.skills', files: 'source.files', sessions: 'source.sessions', agents: 'source.agents', conversations: 'source.conversations', drives: 'source.drives' } as const
const REFERENCE_ANYTHING_LOGO = '__REFERENCE_ANYTHING_LOGO_DATA_URI__'
const GITHUB_REPOSITORY_URL = 'https://github.com/Chael-Chael/dsh-reference-anything'
export function ConversationSettings({ useScope, save, sync, cancel, refresh, refreshOpenList = async () => undefined, quickRefreshOnOpen, setupAll, discoverOpenCli, installOpenCli, useProfile, install, restartDaemon, checkUpdate, installUpdate, browse, deleteConversation, clearProvider, clearOlder, clearRemoteMissing, clearOldAccounts, refreshStats, openListInstall = async () => undefined, openListUpgrade = async () => undefined, openListConnectExternal = async () => undefined, openListDisconnect = async () => undefined, openListCreateMount = async () => undefined, openListDisableMount = async () => undefined, openListRemoveMount = async () => undefined, openListReindex = async () => ({ supported: false }), t }: SettingsProps) {
  const state = useScope(value => value)
  const settings = state.settings
  const picker = settings.picker ?? defaultPickerSettings()
  const [busyAction, setBusyAction] = useState<string>()
  const busyActionRef = useRef(false)
  const [storeBlocked, setStoreBlocked] = useState(false)
  const [opencliPath, setOpencliPath] = useState(settings.opencliPath)
  const [profile, setProfile] = useState(settings.profile)
  const [detailConcurrency, setDetailConcurrency] = useState(String(settings.detailConcurrency))
  const [autoSyncMinutes, setAutoSyncMinutes] = useState(String(settings.autoSyncMinutes))
  const [cleanupDays, setCleanupDays] = useState('90')
  const [maxReadTurns, setMaxReadTurns] = useState(String(settings.maxReadTurns))
  const [repairProfile, setRepairProfile] = useState('')
  const [pickerLimits, setPickerLimits] = useState<Record<PickerSource, string>>(() => pickerLimitDrafts(picker))
  const [pickerMaxCandidates, setPickerMaxCandidates] = useState<Record<PickerSource, string>>(() => pickerMaxCandidateDrafts(picker))
  const automaticQuickRefresh = useRef(quickRefreshOnOpen)
  useEffect(() => { setOpencliPath(settings.opencliPath); setProfile(settings.profile); setDetailConcurrency(String(settings.detailConcurrency)); setAutoSyncMinutes(String(settings.autoSyncMinutes)); setMaxReadTurns(String(settings.maxReadTurns)) }, [settings.opencliPath, settings.profile, settings.detailConcurrency, settings.autoSyncMinutes, settings.maxReadTurns])
  useEffect(() => { setPickerLimits(pickerLimitDrafts(picker)) }, [picker.commands.limit, picker.skills.limit, picker.files.limit, picker.sessions.limit, picker.agents.limit, picker.conversations.limit, picker.drives.limit])
  useEffect(() => { setPickerMaxCandidates(pickerMaxCandidateDrafts(picker)) }, [picker.commands.maxCandidates, picker.skills.maxCandidates, picker.files.maxCandidates, picker.sessions.maxCandidates, picker.agents.maxCandidates, picker.conversations.maxCandidates, picker.drives.maxCandidates])
  automaticQuickRefresh.current = quickRefreshOnOpen
  useEffect(() => {
    if (!state.loading) void automaticQuickRefresh.current?.()
  }, [state.loading])
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
  const enabledAgents = new Set(settings.enabledAgents)
  const opencliReady = Boolean(state.health?.version && state.health.opencliCompatible)
  const daemonReady = Boolean(state.health?.daemonRunning && !state.health.daemonStale)
  const extensionReady = Boolean(state.health?.extensionConnected && state.health.connectivityOk)
  const extensionUnverified = Boolean(state.health?.extensionConnected && !state.health.connectivityChecked)
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
  } else if (!daemonReady || Boolean(state.health?.extensionConnected && state.health.connectivityChecked && !state.health.connectivityOk)) {
    extensionActionLabel = t('settings.restartDaemon'); extensionAction = () => { runAction('daemon', restartDaemon) }
  } else if (state.health?.extensionState === 'disconnected' || (needsProfileRecovery && !profileControl)) {
    extensionActionLabel = t('settings.openExtensionStore'); extensionAction = () => { runAction('extension', async () => { openStore() }) }
  }
  const extensionSecondaryLabel = state.health?.extensionState === 'disconnected' && daemonReady ? t('settings.restartDaemon') : undefined
  const setProviderEnabled = (provider: ChatProvider, value: boolean) => {
    const next = value ? [...new Set([...settings.enabledProviders, provider])] : settings.enabledProviders.filter(item => item !== provider)
    void save({ ...settings, enabledProviders: next })
  }
  const setAgentEnabled = (agent: LocalAgent, value: boolean) => {
    const next = value ? [...new Set([...settings.enabledAgents, agent])] : settings.enabledAgents.filter(item => item !== agent)
    void save({ ...settings, enabledAgents: next })
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
  const commitPickerMaxCandidates = (id: PickerSource) => {
    const value = Number(pickerMaxCandidates[id])
    if (Number.isInteger(value) && value >= 1 && value <= 50) {
      setPickerMaxCandidates(current => ({ ...current, [id]: String(value) }))
      if (value !== picker[id].maxCandidates) patchPicker(id, { maxCandidates: value })
      return
    }
    setPickerMaxCandidates(current => ({ ...current, [id]: String(picker[id].maxCandidates) }))
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
      <label className="dsh_ref_render_mode"><span><b>{t('settings.pickerDisplayMode')}</b><small>{t('settings.pickerDisplayModeDetail')}</small></span><select value={picker.displayMode} onChange={event => { savePicker({ ...picker, displayMode: event.target.value as PickerSettings['displayMode'] }) }}><option value="collapse">{t('settings.pickerDisplayCollapse')}</option><option value="native-scroll">{t('settings.pickerDisplayNative')}</option></select></label>
      <div className="dsh_ref_picker_list">{[...PICKER_SOURCES].sort((a, b) => picker[a.id].order - picker[b.id].order).map((row, index, rows) => <div className="dsh_ref_picker_row" key={row.id}>
        <label className="dsh_ref_toggle dsh_ref_picker_toggle"><input type="checkbox" checked={picker[row.id].enabled} onChange={event => { patchPicker(row.id, { enabled: event.target.checked }) }} /><span/><b>{t(SOURCE_KEYS[row.label])}</b></label>
        <label className="dsh_ref_picker_limit"><span>{t('settings.collapsedItems')}</span><input type="number" min={1} max={50} inputMode="numeric" value={pickerLimits[row.id]} aria-invalid={pickerLimits[row.id] !== '' && !validPickerLimit(pickerLimits[row.id])} onChange={event => { setPickerLimits(current => ({ ...current, [row.id]: event.target.value })) }} onBlur={() => { commitPickerLimit(row.id) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
        <label className="dsh_ref_picker_limit"><span>{t('settings.maxCandidates')}</span><input type="number" min={1} max={50} inputMode="numeric" value={pickerMaxCandidates[row.id]} aria-invalid={pickerMaxCandidates[row.id] !== '' && !validPickerLimit(pickerMaxCandidates[row.id])} onChange={event => { setPickerMaxCandidates(current => ({ ...current, [row.id]: event.target.value })) }} onBlur={() => { commitPickerMaxCandidates(row.id) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
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
          <CheckRow label={t('check.browserExtension')} detail={extensionStateDetail(state.health, t)} ready={extensionReady} neutral={extensionUnverified}
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
      <div className="dsh_ref_chat_divider" />
      <AgentSelectionCards enabledAgents={enabledAgents} onEnabled={setAgentEnabled} t={t} />
      {!state.loading && state.stats?.every(item => item.conversations === 0) && <div className="dsh_ref_empty">{t('settings.empty')}</div>}
      <div className="dsh_ref_chat_divider" />
      <CloudDrives state={state} refreshOpenList={refreshOpenList} install={openListInstall} upgrade={openListUpgrade} connect={openListConnectExternal} disconnect={openListDisconnect} createMount={openListCreateMount} disableMount={openListDisableMount} removeMount={openListRemoveMount} reindexMount={openListReindex} t={t} />
      <DriveSelectionCards state={state} save={save} t={t} />
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

/** A separate, read-only-with-respect-to-drive-files OpenList control plane. */
export function CloudDrives({ state, refreshOpenList, install, upgrade, connect, disconnect, createMount, disableMount, removeMount, reindexMount, t }: {
  state: SettingsSnapshot; refreshOpenList(): Promise<void>; install(): Promise<void>; upgrade(rollback?: boolean): Promise<void>
  connect(input: { endpoint: string; username?: string; password?: string; token?: string }): Promise<void>; disconnect(): Promise<void>
  createMount(input: { id?: string; mountPath: string; driver: string; addition: Record<string, unknown> }): Promise<void>; disableMount(id: string, disabled?: boolean): Promise<void>; removeMount(id: string): Promise<void>; reindexMount(id: string): Promise<{ supported: boolean; reason?: string }>; t: T
}) {
  const [endpoint, setEndpoint] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [quickToken, setQuickToken] = useState('')
  const [quickDriverName, setQuickDriverName] = useState('')
  const [driverName, setDriverName] = useState('')
  const [fields, setFields] = useState<Record<string, unknown>>({})
  const [touchedFields, setTouchedFields] = useState<Record<string, true>>({})
  const [mountPath, setMountPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [optimisticState, setOptimisticState] = useState<OpenListStatus['state']>()
  const [formError, setFormError] = useState<string>()
  const [quickError, setQuickError] = useState<string>()
  const [feedback, setFeedback] = useState<string>()
  const [reauthMount, setReauthMount] = useState<OpenListMount>()
  const [showExternal, setShowExternal] = useState(false)
  const [showAddDrive, setShowAddDrive] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const status = state.openList
  const drivers = state.openListDrivers ?? []
  const quickDrivers = drivers.filter(item => item.quickAuth === true)
  const quickDriver = quickDrivers.find(item => item.name === quickDriverName) ?? quickDrivers[0]
  const quickGuide = apiPagesProviderGuide(quickDriver?.name ?? '')
  const driver = drivers.find(item => item.name === driverName) ?? drivers[0]
  const mountNames = (state.openListMounts ?? []).map(item => item.name)
  useEffect(() => {
    if (driver && driver.name !== driverName) { setDriverName(driver.name); setFields(reauthMount ? {} : driverDefaults(driver)); setTouchedFields({}) }
  }, [driver, driverName])
  useEffect(() => {
    if (driver && mountPath === '') setMountPath(defaultOpenListMountPath(driver.name, mountNames))
  }, [driver?.name, mountNames.join('|')])
  useEffect(() => {
    if (status?.mode !== undefined) return
    setPassword(''); setQuickToken(''); setFields({}); setTouchedFields({}); setReauthMount(undefined); setFormError(undefined)
  }, [status?.mode])
  useEffect(() => {
    if (!state.openListMounts?.some(mount => mount.indexStatus === 'running')) return
    const timer = setInterval(() => { void refreshOpenList() }, 2_000)
    return () => clearInterval(timer)
  }, [state.openListMounts, refreshOpenList])
  const act = (action: () => Promise<void>, operation?: OpenListStatus['state']) => { if (busy) return; setBusy(true); setOptimisticState(operation); void action().catch(() => undefined).finally(() => { setBusy(false); setOptimisticState(undefined) }) }
  const submitExternal = () => {
    const input = { endpoint: endpoint.trim(), ...(username.trim() ? { username: username.trim() } : {}), ...(password ? { password } : {}) }
    act(async () => { try { await connect(input) } finally { setPassword('') } })
  }
  const submitQuick = () => {
    const addition = quickDriver && parseQuickProviderAddition(quickDriver, quickToken)
    if (!quickDriver || !addition || !status?.mode) { setQuickError(t('cloud.quickRequired')); return }
    const path = mountPath.trim() || defaultOpenListMountPath(quickDriver.name, mountNames)
    // API Pages returns a provider OAuth token, not an OpenList admin JWT.
    // It belongs only in the selected driver's addition payload.
    setQuickError(undefined)
    act(async () => { try { await createMount({ mountPath: path, driver: quickDriver.name, addition }); setMountPath(defaultOpenListMountPath(quickDriver.name, [...mountNames, path])); setFeedback(t('cloud.quickSuccess', { provider: quickDriver.name })); setQuickError(undefined) } catch { setQuickError(t('cloud.quickFailed')); throw new Error('mount failed') } finally { setQuickToken('') } })
  }
  const submitMount = () => {
    if (!driver) return
    const path = mountPath.trim() || defaultOpenListMountPath(driver.name, mountNames)
    const addition = reauthMount ? sparseReauthAddition(driver, fields, touchedFields) : normalizedDriverAddition(driver, fields)
    if (addition === undefined) { setFormError(t('cloud.required')); return }
    setFormError(undefined)
    act(async () => { try { await createMount({ ...(reauthMount === undefined ? {} : { id: reauthMount.id }), mountPath: reauthMount?.name ?? path, driver: driver.name, addition }); setReauthMount(undefined); if (reauthMount === undefined) setMountPath(defaultOpenListMountPath(driver.name, [...mountNames, path])); setFields({}); setTouchedFields({}); setFormError(undefined) } catch { setFormError(t('cloud.error')); throw new Error('mount failed') } })
  }
  return <section className="dsh_ref_cloud" aria-label={t('cloud.title')}>
    <div className="dsh_ref_section_head"><div><h3>{t('cloud.title')}</h3><p>{t('cloud.detail')}</p></div><span className="dsh_ref_health">{status ? t(`cloud.state.${optimisticState ?? status.state}` as keyof typeof import('./locale.ts').zh) : t('cloud.state.install')}</span></div>
    <ol className="dsh_ref_cloud_steps"><li className={status?.mode ? 'is_done' : 'is_current'}><b>1</b><span><strong>{t('cloud.stepEnable')}</strong><small>{status?.mode ? t('cloud.stepDone') : t('cloud.stepEnableDetail')}</small></span></li><li className={(state.openListMounts?.length ?? 0) > 0 ? 'is_done' : status?.mode ? 'is_current' : ''}><b>2</b><span><strong>{t('cloud.stepAdd')}</strong><small>{(state.openListMounts?.length ?? 0) > 0 ? t('cloud.stepDone') : t('cloud.stepAddDetail')}</small></span></li><li className={(state.openListMounts?.some(mount => mount.status === 'ready')) ? 'is_done' : ''}><b>3</b><span><strong>{t('cloud.stepUse')}</strong><small>{t('cloud.stepUseDetail')}</small></span></li></ol>
    <p className="dsh_ref_auto_note">{t('cloud.license')} <a href="https://github.com/OpenListTeam/OpenList/tree/v4.2.2" target="_blank" rel="noreferrer">{t('cloud.source')}</a></p>
    {status?.error && <p className="dsh_ref_inline_error">{status.error}</p>}
    <div className="dsh_ref_cloud_actions">
      {status?.mode !== 'external' && (!status?.installed || !status.mode) && <button className="is_primary" type="button" disabled={busy} onClick={() => act(install, 'downloading')}>{t('cloud.enable')}</button>}
      {status?.mode && <button className="is_primary" type="button" disabled={busy} onClick={() => { setShowAddDrive(value => { if (value) { setQuickToken(''); setQuickError(undefined) }; return !value }); setShowAdvanced(false) }}>{showAddDrive ? t('cloud.cancelAdd') : t('cloud.addDrive')}</button>}
      {status?.upgradeAvailable && <button type="button" disabled={busy} onClick={() => act(() => upgrade(false), 'upgrade')}>{t('cloud.upgrade')}</button>}
      {status?.mode !== 'external' && status?.installed && !status.upgradeAvailable && status.newerVersion !== true && <button type="button" disabled={busy} onClick={() => act(() => upgrade(false), 'downloading')}>{t('cloud.repair')}</button>}
      {status?.mode !== 'external' && status?.supportsRollback && <button type="button" disabled={busy} onClick={() => act(() => upgrade(true), 'downloading')}>{t('cloud.rollback')}</button>}
      {status?.mode && <button type="button" disabled={busy} onClick={() => act(disconnect)}>{t('cloud.disconnect')}</button>}
      {!status?.mode && <button type="button" disabled={busy} onClick={() => setShowExternal(value => !value)}>{showExternal ? t('cloud.hideAdvanced') : t('cloud.connectExisting')}</button>}
    </div>
    {!status?.mode && showExternal && <div className="dsh_ref_cloud_connect">
      <label><span>{t('cloud.endpoint')}</span><input value={endpoint} placeholder="https://openlist.example" onChange={event => setEndpoint(event.target.value)} /></label>
      <label><span>{t('cloud.username')}</span><input value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label><span>{t('cloud.password')}</span><input type="password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button type="button" disabled={busy || !endpoint.trim()} onClick={submitExternal}>{t('cloud.connect')}</button>
    </div>}
    {status?.mode && showAddDrive && quickDrivers.length > 0 && <div className="dsh_ref_cloud_quick">
      <div className="dsh_ref_cloud_quick_head"><h4>{t('cloud.quickLoginTitle')}</h4><p>{t('cloud.quickLoginDetail')}</p></div>
      <ol className="dsh_ref_quick_tasks">
        <li className="is_done"><b>1</b><div><strong>{t('cloud.quickStepChoose')}</strong><label><span>{t('cloud.quickChooseLabel')}</span><select value={quickDriver?.name ?? ''} disabled={busy} onChange={event => { setQuickDriverName(event.target.value); setMountPath(defaultOpenListMountPath(event.target.value, mountNames)); setQuickToken(''); setQuickError(undefined) }}>{quickDrivers.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label></div></li>
        <li><b>2</b><div><strong>{t('cloud.quickStepAuthorize', { provider: quickDriver?.name ?? '' })}</strong><p>{t('cloud.quickAuthorizeDetail', { provider: quickDriver?.name ?? '' })}</p><div className="dsh_ref_api_pages_guide"><strong>{t('cloud.quickOnPage')}</strong><ol><li>{t('cloud.quickPageChoose', { option: quickGuide.option })}</li>{quickGuide.parameters === 'official' && <li>{t('cloud.quickPageOfficial')}</li>}{quickGuide.parameters === 'automatic' && <li>{t('cloud.quickPageAutomatic')}</li>}{quickGuide.parameters === 'own' && <li>{t('cloud.quickPageOwn')}</li>}<li>{t('cloud.quickPageGet')}</li><li>{t('cloud.quickPageCopy', { result: quickGuide.result })}</li></ol></div><a className="dsh_ref_button is_primary" href="https://api.oplist.org/" target="_blank" rel="noreferrer">{t('cloud.quickProviderNamed', { provider: quickDriver?.name ?? '' })}</a></div></li>
        <li className={quickToken ? 'is_done' : 'is_current'}><b>3</b><div><strong>{t('cloud.quickStepPaste')}</strong><label><span>{t('cloud.quickPasteLabel')}</span><textarea className="dsh_ref_masked_secret" rows={3} value={quickToken} placeholder={t('cloud.quickPastePlaceholder')} aria-invalid={quickError ? true : undefined} aria-describedby="dsh-ref-quick-secret-note" onChange={event => { setQuickToken(event.target.value); setQuickError(undefined) }} autoComplete="off" spellCheck={false} /></label><small id="dsh-ref-quick-secret-note">{t('cloud.quickSecretNote')}</small>{quickError && <p className="dsh_ref_inline_error" role="alert">{quickError}</p>}</div></li>
      </ol>
      <div className="dsh_ref_quick_summary"><span>{t('cloud.quickWillAdd')}</span><strong>{quickDriver?.name} · {mountPath || (quickDriver ? defaultOpenListMountPath(quickDriver.name, mountNames) : '')}</strong></div>
      <button className="is_primary dsh_ref_quick_submit" type="button" aria-busy={busy} disabled={busy || !quickDriver || quickProviderAuthFields(quickDriver).length === 0} onClick={submitQuick}>{busy ? t('cloud.quickConnecting') : t('cloud.quickAdd')}</button>
    </div>}
    {status?.mode && showAddDrive && !reauthMount && <button className="dsh_ref_advanced_toggle" type="button" onClick={() => setShowAdvanced(value => !value)}>{showAdvanced ? t('cloud.hideAdvanced') : t('cloud.showAdvanced')}</button>}
    {status?.mode && (reauthMount !== undefined || (showAddDrive && (showAdvanced || quickDrivers.length === 0))) && <div className="dsh_ref_cloud_mount_form">
      <h4>{reauthMount ? t('cloud.reauthTitle', { name: reauthMount.name }) : t('cloud.advancedConnection')}</h4>
      <label><span>{t('cloud.driver')}</span><select value={driver?.name ?? ''} disabled={reauthMount !== undefined} onChange={event => { const next = drivers.find(item => item.name === event.target.value); setDriverName(event.target.value); setFields(next ? driverDefaults(next) : {}); setTouchedFields({}); setMountPath(defaultOpenListMountPath(event.target.value, mountNames)) }}>{drivers.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      {driver?.description && <small>{driver.description}</small>}
      {driver?.fields.map(field => <label key={field.name}><span>{field.label}{field.required && !reauthMount ? ' *' : ''}</span>{field.type === 'boolean' ? <input type="checkbox" checked={fields[field.name] === true} onChange={event => { setFields(value => ({ ...value, [field.name]: event.target.checked })); setTouchedFields(value => ({ ...value, [field.name]: true })) }} /> : field.type === 'select' ? <select value={String(fields[field.name] ?? '')} onChange={event => { setFields(value => ({ ...value, [field.name]: event.target.value })); setTouchedFields(value => ({ ...value, [field.name]: true })) }}>{reauthMount && <option value="" disabled>—</option>}{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'} value={String(fields[field.name] ?? '')} onChange={event => { setFields(value => ({ ...value, [field.name]: event.target.value })); setTouchedFields(value => ({ ...value, [field.name]: true })) }} />}</label>)}
      {!reauthMount && <label><span>{t('cloud.mountPath')}</span><input value={mountPath} onChange={event => setMountPath(event.target.value)} /></label>}<button type="button" disabled={busy || !driver} onClick={submitMount}>{reauthMount ? t('cloud.reauth') : t('cloud.create')}</button>{formError && <p className="dsh_ref_inline_error">{formError}</p>}
    </div>}
    <div className="dsh_ref_cloud_cards">{(state.openListMounts ?? []).map(mount => <article key={mount.id}>
      <strong>{mount.name}</strong>
      <span>{mount.driver} · {mount.status === 'ready' ? t('cloud.ready') : mount.status === 'disabled' || !mount.enabled ? t('cloud.disabled') : t('cloud.error')}{mount.indexStatus ? ` · ${mount.indexStatus}` : ''}</span>
      {mount.error && <small className="dsh_ref_inline_error">{mount.error}</small>}
      {mount.capacityTotal !== undefined && <small>{formatBytes(mount.capacityUsed ?? 0)} / {formatBytes(mount.capacityTotal)}</small>}
      {mount.indexProgress !== undefined && <div className="dsh_ref_progress_track"><div className="dsh_ref_progress_fill" style={{ width: `${Math.round(mount.indexProgress * 100)}%` }} /></div>}
      <div>
        <button type="button" disabled={busy} onClick={() => act(() => disableMount(mount.id, mount.enabled))}>{mount.enabled ? t('cloud.disable') : t('cloud.enableMount')}</button>
        <button type="button" disabled={busy} onClick={() => { setShowAddDrive(true); setReauthMount(mount); setDriverName(mount.driver); setFields({}); setTouchedFields({}) }}>{t('cloud.reauth')}</button>
        <button type="button" disabled={busy} onClick={() => act(async () => { const result = await reindexMount(mount.id); setFeedback(result.supported ? t('cloud.reindexStarted') : (result.reason ?? t('cloud.reindexUnsupported'))) })}>{t('cloud.reindex')}</button>
        <button className="is_danger" type="button" disabled={busy} onClick={() => { if (window.confirm(t('cloud.removeConfirm'))) act(() => removeMount(mount.id)) }}>{t('cloud.remove')}</button>
      </div>
    </article>)}</div>
    {feedback && <p className="dsh_ref_auto_note" role="status">{feedback}</p>}
    {status?.mode && <p className="dsh_ref_auto_note">{t('cloud.removeDetail')}</p>}
  </section>
}

export function defaultOpenListMountPath(driver: string, existing: readonly string[]): string {
  const base = `/${driver.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'drive'}`
  const set = new Set(existing)
  if (!set.has(base)) return base
  for (let suffix = 2; ; suffix += 1) if (!set.has(`${base}-${suffix}`)) return `${base}-${suffix}`
}

export interface ApiPagesProviderGuide { readonly option: string; readonly parameters: 'official' | 'automatic' | 'own'; readonly result: string }

/** Exact labels currently shown by the official API Pages token tool. */
export function apiPagesProviderGuide(driver: string): ApiPagesProviderGuide {
  const name = driver.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (name === 'onedrive' || name === 'onedriveapp') return { option: 'OneDrive (OAuth2) 个人账号', parameters: 'official', result: '刷新令牌（Refresh Token）' }
  if (['aliyundrive', 'aliyundriveopen', 'aliyunpan'].includes(name)) return { option: '阿里云盘 (Client) 直接登录', parameters: 'automatic', result: '刷新令牌（Refresh Token）' }
  if (['baidu', 'baidunetdisk', 'baiduphoto'].includes(name)) return { option: '百度网盘 (OAuth2) 验证登录', parameters: 'official', result: '刷新令牌（Refresh Token）' }
  if (name === 'quark' || name === 'quarktv') return { option: '夸克网盘 (OAuth2) 验证登录', parameters: 'official', result: '刷新令牌（Refresh Token）' }
  if (name === '115' || name === '115cloud') return { option: '115 网盘 (QRCode) 扫码登录', parameters: 'automatic', result: '页面生成的完整令牌' }
  if (['123pan', '123panopen', '123panlink'].includes(name)) return { option: '123 网盘 (OAuth2) 跳转登录', parameters: 'automatic', result: '访问令牌（Access Token）' }
  if (name === 'dropbox') return { option: 'Drop Box (OAuth2) 跳转登录', parameters: 'own', result: '刷新令牌（Refresh Token）' }
  if (name === 'googledrive' || name === 'googlephoto' || name === 'googlephotos') return { option: 'GoogleDrive Login (OAuth2)', parameters: 'official', result: '刷新令牌（Refresh Token）' }
  if (name === 'yandex' || name === 'yandexdisk') return { option: 'YandexDrive Login (OAuth2)', parameters: 'official', result: '刷新令牌（Refresh Token）' }
  return { option: driver, parameters: 'official', result: '页面底部生成的完整令牌' }
}

export function driverDefaults(driver: OpenListDriver): Record<string, unknown> {
  return Object.fromEntries(driver.fields.map(field => [field.name, field.secret && field.hasDefault ? undefined : field.default ?? (field.type === 'boolean' ? false : field.type === 'select' ? field.options?.[0]?.value ?? '' : '')]))
}

/** Returns undefined when a schema-required value is absent or malformed. */
export function normalizedDriverAddition(driver: OpenListDriver, values: Record<string, unknown>): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {}
  for (const field of driver.fields) {
    const value = values[field.name]
    if (field.type === 'number') {
      const number = typeof value === 'number' ? value : Number(value)
      if (String(value ?? '').trim() === '' && field.hasDefault === true) continue
      if (!Number.isFinite(number) || (field.required && String(value ?? '').trim() === '')) return undefined
      if (String(value ?? '').trim() !== '') output[field.name] = number
    } else if (field.type === 'boolean') {
      if (value === undefined && field.hasDefault === true) continue
      if (value === undefined && field.required) return undefined
      output[field.name] = value === true
    } else {
      const text = typeof value === 'string' ? value : ''
      if (field.required && field.hasDefault !== true && text.trim() === '') return undefined
      if (text !== '') output[field.name] = text
    }
  }
  return output
}

/** Reauth is a sparse credential patch: untouched schema defaults stay remote. */
export function sparseReauthAddition(driver: OpenListDriver, values: Record<string, unknown>, touched: Readonly<Record<string, true>>): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {}
  for (const field of driver.fields) {
    if (touched[field.name] !== true) continue
    const value = values[field.name]
    if (field.type === 'boolean') { output[field.name] = value === true; continue }
    if (field.type === 'number') {
      const text = String(value ?? '').trim()
      if (text === '') continue
      const number = Number(text)
      if (!Number.isFinite(number)) return undefined
      output[field.name] = number
      continue
    }
    const text = typeof value === 'string' ? value.trim() : ''
    // Clearing an existing remote secret needs a dedicated explicit action;
    // an empty text field is merely left unchanged.
    if (text !== '') output[field.name] = text
  }
  return output
}

/** Curated API Pages flow only chooses a field; schema remains server-driven. */
export function quickProviderAuthFields(driver: OpenListDriver): OpenListDriver['fields'][number][] {
  return driver.fields.filter(field => (field.secret ?? /(token|password|secret|cookie|authorization|credential)/i.test(field.name)) && /(token|oauth|refresh|access|authorization|cookie|credential)/i.test(field.name))
}

/** Parse API Pages output without guessing which credential a multi-field driver needs. */
export function parseQuickProviderAddition(driver: OpenListDriver, input: string): Record<string, unknown> | undefined {
  const text = input.trim()
  if (text === '') return undefined
  const authFields = quickProviderAuthFields(driver)
  if (authFields.length === 0) return undefined
  let supplied: Record<string, unknown>
  if (text.startsWith('{')) {
    try { const value: unknown = JSON.parse(text); if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined; supplied = value as Record<string, unknown> } catch { return undefined }
  } else if (text.includes('=')) {
    supplied = {}
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      const separator = line.indexOf('=')
      if (separator < 1) return undefined
      const key = line.slice(0, separator).trim(); const value = line.slice(separator + 1).trim()
      if (key === '' || Object.hasOwn(supplied, key)) return undefined
      supplied[key] = value
    }
  } else {
    if (authFields.length !== 1) return undefined
    supplied = { [authFields[0]!.name]: text }
  }
  const allowed = new Set(driver.fields.map(field => field.name))
  if (Object.keys(supplied).some(key => !allowed.has(key))) return undefined
  return normalizedDriverAddition(driver, { ...driverDefaults(driver), ...supplied })
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
          <div className="dsh_ref_manage_row_actions">
            <a className={item.url ? undefined : 'is_disabled'} href={item.url || undefined} target="_blank" rel="noopener noreferrer"
              aria-disabled={!item.url} onClick={event => { if (!item.url) event.preventDefault() }}>{t('manage.open')}</a>
            <button type="button" className="is_danger" disabled={syncing}
              title={syncing ? t('manage.deleteDisabled') : undefined}
              onClick={() => {
                if (window.confirm(t('manage.deleteConfirm', { title: item.title }))) void deleteConversation(item.uriId)
              }}>{t('manage.delete')}</button>
          </div>
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

function CheckRow({ label, detail, ready, neutral = false, actionLabel, secondaryLabel, actionBusy, actionDisabled, onAction, onSecondary, control }: {
  label: string; detail: string; ready: boolean; neutral?: boolean; actionLabel?: string; secondaryLabel?: string
  actionBusy?: boolean; actionDisabled?: boolean; onAction?: () => void; onSecondary?: () => void; control?: ReactNode
}) {
  const stateClass = ready ? 'is_ready' : neutral ? 'is_neutral' : 'is_error'
  return <div className="dsh_ref_check"><span className={stateClass}>{ready ? '✓' : neutral ? '•' : '×'}</span><div className="dsh_ref_check_body"><strong>{label}</strong><small className={!ready && !neutral ? 'is_warning' : undefined}>{detail}</small>{!ready && !neutral && (control || onAction || onSecondary) && <div className="dsh_ref_check_actions">{control}{onAction && actionLabel && <button type="button" aria-busy={actionBusy} disabled={actionDisabled} onClick={onAction}>{actionBusy ? `${actionLabel}…` : actionLabel}</button>}{onSecondary && secondaryLabel && <button type="button" disabled={actionDisabled} onClick={onSecondary}>{secondaryLabel}</button>}</div>}</div></div>
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
  return { commands: String(picker.commands.limit), skills: String(picker.skills.limit), files: String(picker.files.limit), sessions: String(picker.sessions.limit), agents: String(picker.agents.limit), conversations: String(picker.conversations.limit), drives: String(picker.drives.limit) }
}

function pickerMaxCandidateDrafts(picker: PickerSettings): Record<PickerSource, string> {
  return { commands: String(picker.commands.maxCandidates), skills: String(picker.skills.maxCandidates), files: String(picker.files.maxCandidates), sessions: String(picker.sessions.maxCandidates), agents: String(picker.agents.maxCandidates), conversations: String(picker.conversations.maxCandidates), drives: String(picker.drives.maxCandidates) }
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
  if (health.extensionConnected && !health.connectivityChecked) return t('settings.extensionConnectivityUnchecked')
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

export function AgentSelectionCards({ enabledAgents, onEnabled, t }: { enabledAgents: ReadonlySet<LocalAgent>; onEnabled(agent: LocalAgent, value: boolean): void; t: T }) {
  return <div className="dsh_ref_reference_choices dsh_ref_agent_choices">
    <div className="dsh_ref_section_head dsh_ref_agent_heading"><div><h3>{t('settings.localAgents')}</h3><p>{t('settings.localAgentsDetail')}</p></div></div>
    <div className="dsh_ref_provider_grid dsh_ref_agent_grid dsh_ref_selection_grid">{ALL_LOCAL_AGENTS.map((agent, index) => <AgentCard key={agent} agent={agent} index={index} enabled={enabledAgents.has(agent)} onEnabled={value => { onEnabled(agent, value) }} t={t} />)}</div>
  </div>
}

export function DriveSelectionCards({ state, save, t }: { state: SettingsSnapshot; save(value: SettingsRecord): Promise<void>; t: T }) {
  const mounts = state.openListMounts ?? []
  const selectedMounts = state.settings.enabledDriveMounts ?? mounts.filter(mount => mount.enabled).map(mount => mount.name)
  return <div className="dsh_ref_reference_choices dsh_ref_drive_choices">
    <div className="dsh_ref_section_head dsh_ref_mount_selection_head"><div><h3>{t('cloud.selectionTitle')}</h3><p>{t('cloud.selectionDetail')}</p></div></div>
    {mounts.length === 0 ? <div className="dsh_ref_empty">{t('cloud.selectionEmpty')}</div> : <div className="dsh_ref_provider_grid dsh_ref_selection_grid">{mounts.map((mount, index) => <article className="dsh_ref_provider dsh_ref_selection_card" style={{ '--dsh-ref-index': index } as CSSProperties} key={mount.id}>
      <span className="dsh_ref_provider_mark dsh_ref_text_mark">☁</span><div className="dsh_ref_provider_content"><div className="dsh_ref_provider_summary"><h4>{mount.name}</h4><small>{mount.driver} · {mount.status === 'ready' ? t('cloud.ready') : mount.enabled ? t('cloud.error') : t('cloud.disabled')}</small></div><div className="dsh_ref_provider_controls"><label className="dsh_ref_toggle"><input type="checkbox" checked={selectedMounts.includes(mount.name)} disabled={!mount.enabled} onChange={event => { const enabledDriveMounts = event.target.checked ? [...new Set([...selectedMounts, mount.name])] : selectedMounts.filter(value => value !== mount.name); void save({ ...state.settings, enabledDriveMounts }) }} /><span/><b>{t('provider.enabled')}</b></label></div></div>
    </article>)}</div>}
  </div>
}

function AgentCard({ agent, enabled, onEnabled, index, t }: { agent: LocalAgent; enabled: boolean; onEnabled(value: boolean): void; index: number; t: T }) {
  return <article className="dsh_ref_provider dsh_ref_agent_provider" data-local-agent={agent} style={{ '--dsh-ref-index': index } as CSSProperties}><span className="dsh_ref_provider_mark"><AgentLogo /></span><div className="dsh_ref_provider_content"><div className="dsh_ref_provider_summary"><h4>{LOCAL_AGENT_LABEL[agent]}</h4><small>{t('settings.localAgentOnDisk')}</small></div><div className="dsh_ref_provider_controls"><label className="dsh_ref_toggle"><input type="checkbox" checked={enabled} onChange={event => { onEnabled(event.target.checked) }} /><span/><b>{t('provider.enabled')}</b></label></div></div></article>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `≈ ${bytes} B`
  if (bytes < 1024 ** 2) return `≈ ${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `≈ ${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `≈ ${(bytes / 1024 ** 3).toFixed(1)} GiB`
}
