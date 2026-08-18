import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useState, type CSSProperties } from 'react'
import type { ChatProvider, SettingsRecord } from '../wire.ts'
import type { BrowserProfile, Health, ProviderStats, SyncStatus } from './remote.ts'
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
  return <div className="dsh_ref_rail" data-reference-anything-dock>
    {rows.map(row => <span className="dsh_ref_chip" key={`${row.start}:${row.uri}`}>
      <button type="button" className="dsh_ref_open" onClick={() => { open(row.uri) }}><span className="dsh_ref_chip_mark" aria-hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a8 8 0 0 1-8.5 8A8.9 8.9 0 0 1 7.7 18.6L3.5 20l1.4-3.7A8 8 0 1 1 20 11.5Z"/></svg></span>{row.label}</button>
      <button type="button" className="dsh_ref_remove" aria-label={t('dock.remove', { label: row.label })} onClick={() => {
        inputActions.setDraft(input.draft.slice(0, row.start) + input.draft.slice(row.end))
      }}>×</button>
    </span>)}
  </div>
}

export interface SettingsSnapshot { settings: SettingsRecord; health?: Health; profiles?: readonly BrowserProfile[]; stats?: readonly ProviderStats[]; sync?: SyncStatus; error?: string; notice?: string; loading?: boolean }
export interface SettingsInjected {
  hooks: { scope: ObservableSnapshot<SettingsSnapshot> }
  save(value: SettingsRecord): Promise<void>
  sync(providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
  install(): Promise<void>
}
type T = TranslateNS<typeof REFERENCE_ANYTHING_NS>
type SettingsProps = PropsRuntime<'settings.section'> & InjectFace<SettingsInjected> & { t: T }
const PROVIDERS: ChatProvider[] = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok']
const PROVIDER_LABEL: Record<ChatProvider, string> = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok',
}
export function ConversationSettings({ useScope, save, sync, cancel, refresh, install, t }: SettingsProps) {
  const state = useScope(value => value)
  const settings = state.settings
  const [installing, setInstalling] = useState(false)
  const [opencliPath, setOpencliPath] = useState(settings.opencliPath)
  const [detailConcurrency, setDetailConcurrency] = useState(String(settings.detailConcurrency))
  useEffect(() => { setOpencliPath(settings.opencliPath); setDetailConcurrency(String(settings.detailConcurrency)) }, [settings.opencliPath, settings.detailConcurrency])
  const ready = Boolean(state.health?.version && state.health?.daemon && state.health?.pluginInstalled)
  const saveConcurrency = () => {
    const value = Number(detailConcurrency)
    if (Number.isInteger(value) && value >= 1 && value <= 8) void save({ ...settings, detailConcurrency: value })
  }
  return <section className="dsh_ref_settings">
    <header className="dsh_ref_header"><div><h2>{t('settings.title')}</h2><p>{t('settings.subtitle')}</p></div><button className="dsh_ref_recheck" type="button" onClick={() => { void refresh() }}>{t('settings.recheck')}</button></header>
    <div className="dsh_ref_workspace">
    {state.error && <div className="dsh_ref_error" role="alert"><strong>{t('settings.actionFailed')}</strong><span>{state.error}</span></div>}
    {state.notice && <div className="dsh_ref_notice" role="status">{state.notice}</div>}
    <section className="dsh_ref_panel"><div className="dsh_ref_section_head"><div><h3>{t('settings.viability')}</h3><p>{t('settings.viabilityDetail')}</p></div><span className={`dsh_ref_health ${ready ? 'is_ready' : ''}`}>{ready ? t('settings.ready') : t('settings.needsAttention')}</span></div>
      {state.loading ? <div className="dsh_ref_skeleton"><i/><i/><i/></div> : <div className="dsh_ref_checklist">
        <CheckRow label="OpenCLI" detail={state.health?.version || state.health?.versionError || t('settings.notDetected')} ready={Boolean(state.health?.version)} />
        <CheckRow label="Browser bridge" detail={state.health?.daemon || state.health?.daemonError || t('settings.daemonUnavailable')} ready={Boolean(state.health?.daemon)} />
        <CheckRow label="Conversation adapter" detail={state.health?.pluginInstalled ? t('settings.adapterInstalled') : state.health?.pluginError || t('settings.adapterMissing')} ready={Boolean(state.health?.pluginInstalled)} />
      </div>}
      {!state.health?.pluginInstalled && <div className="dsh_ref_install"><div><strong>{t('settings.adapterRequired')}</strong><span>{t('settings.adapterRequiredDetail')}</span></div><button type="button" disabled={installing} onClick={() => { setInstalling(true); void install().finally(() => { setInstalling(false) }) }}>{installing ? t('settings.installing') : t('settings.install')}</button></div>}
    </section>
    <section className="dsh_ref_sources"><div className="dsh_ref_section_head"><div><h3>{t('settings.sources')}</h3><p>{t('settings.sourcesDetail')}</p></div>{state.sync?.status === 'running' && <span className="dsh_ref_syncing">{t('settings.syncing', { source: state.sync.provider ? PROVIDER_LABEL[state.sync.provider] : t('settings.sources'), completed: state.sync.completed, total: state.sync.total })}</span>}</div>
      <div className="dsh_ref_provider_grid">{PROVIDERS.map((provider, index) => <ProviderCard key={provider} provider={provider} index={index} stats={state.stats?.find(row => row.provider === provider)} busy={state.sync?.status === 'running'} autoSync={settings.autoSync} onSync={() => { void sync([provider], 'incremental') }} t={t} />)}</div>
      {!state.loading && state.stats?.every(item => item.conversations === 0) && <div className="dsh_ref_empty">{t('settings.empty')}</div>}
    </section>
    <section className="dsh_ref_panel dsh_ref_sync_settings"><div className="dsh_ref_section_head"><div><h3>{t('settings.syncSettings')}</h3><p>{t('settings.syncSettingsDetail')}</p></div><label className="dsh_ref_toggle"><input type="checkbox" checked={settings.autoSync} onChange={event => { void save({ ...settings, autoSync: event.target.checked }) }} /><span/><b>{t('settings.autoSync')}</b></label></div>
      <div className="dsh_ref_form_grid">
        <label><span>{t('settings.opencli')}</span><input value={opencliPath} onChange={event => { setOpencliPath(event.target.value) }} onBlur={() => { if (opencliPath.trim()) void save({ ...settings, opencliPath: opencliPath.trim() }) }} /></label>
        <label><span>{t('settings.chromeProfile')}</span><select value={settings.profile} onChange={event => { void save({ ...settings, profile: event.target.value }) }}><option value="">{t('settings.defaultProfile')}</option>{state.profiles?.map(profile => <option key={profile.id} value={profile.alias || profile.id} disabled={!profile.connected}>{profile.alias ? `${profile.alias} · ${profile.id}` : profile.id}{profile.isDefault ? ` · ${t('settings.default')}` : ''}{profile.connected ? '' : ` · ${t('settings.disconnected')}`}</option>)}</select></label>
        <label><span>{t('settings.detailConcurrency')}</span><input type="number" min={1} max={8} value={detailConcurrency} aria-invalid={!(Number(detailConcurrency) >= 1 && Number(detailConcurrency) <= 8)} onChange={event => { setDetailConcurrency(event.target.value) }} onBlur={saveConcurrency} /></label>
        <label><span>{t('settings.interval')}</span><select disabled={!settings.autoSync} value={settings.autoSyncMinutes} onChange={event => { void save({ ...settings, autoSyncMinutes: Number(event.target.value) }) }}><option value={30}>{t('settings.every30')}</option><option value={60}>{t('settings.everyHour')}</option><option value={180}>{t('settings.every3Hours')}</option><option value={720}>{t('settings.every12Hours')}</option><option value={1440}>{t('settings.daily')}</option></select></label>
      </div>
      <div className="dsh_ref_actions"><button className="is_primary" type="button" disabled={state.sync?.status === 'running'} onClick={() => { void sync(PROVIDERS, 'incremental') }}>{t('settings.syncAll')}</button><button type="button" disabled={state.sync?.status === 'running'} onClick={() => { void sync(PROVIDERS, 'full') }}>{t('settings.fullRescan')}</button>{state.sync?.status === 'running' && <button className="is_danger" type="button" onClick={() => { void cancel() }}>{t('settings.cancel')}</button>}</div>
      {state.sync?.error && <p className="dsh_ref_inline_error">{state.sync.error}</p>}
      {settings.autoSync && <p className="dsh_ref_auto_note">{t('settings.autoNote', { minutes: settings.autoSyncMinutes })}</p>}
    </section>
    </div>
  </section>
}

function CheckRow({ label, detail, ready }: { label: string; detail: string; ready: boolean }) {
  return <div className="dsh_ref_check"><span className={ready ? 'is_ready' : ''}>{ready ? '✓' : '!'}</span><div><strong>{label}</strong><small>{detail}</small></div></div>
}

function ProviderCard({ provider, stats, busy, autoSync, onSync, index, t }: { provider: ChatProvider; stats?: ProviderStats; busy: boolean; autoSync: boolean; onSync(): void; index: number; t: T }) {
  const label = PROVIDER_LABEL[provider]
  const date = stats?.lastSyncedAt ? new Date(stats.lastSyncedAt).toLocaleString() : t('provider.neverSynced')
  return <article className={`dsh_ref_provider dsh_ref_provider_${provider}`} style={{ '--dsh-ref-index': index } as CSSProperties}><div className="dsh_ref_provider_top"><span className="dsh_ref_provider_mark"><ProviderLogo provider={provider} /></span><span className={`dsh_ref_status_dot is_${stats?.status || 'empty'}`} /><span>{stats?.status === 'error' ? t('provider.error') : stats?.status === 'syncing' ? t('provider.syncing') : stats?.conversations ? t('provider.connected') : t('provider.notSynced')}</span></div><h4>{label}</h4><strong>{stats?.conversations ?? 0}</strong><p>{t('provider.localConversations')}</p><small>{t('provider.lastUpdated', { date })}</small>{stats?.error && <em>{stats.error}</em>}<div className="dsh_ref_provider_foot"><span>{autoSync ? t('provider.autoSyncOn') : t('provider.manualSync')}</span><button type="button" disabled={busy} onClick={onSync}>{t('provider.syncNow')}</button></div></article>
}
