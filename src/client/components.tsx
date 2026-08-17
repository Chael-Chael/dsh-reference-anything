import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import * as ClaudeModule from '@lobehub/icons/es/Claude/components/Mono.js'
import * as DeepSeekModule from '@lobehub/icons/es/DeepSeek/components/Mono.js'
import * as GeminiModule from '@lobehub/icons/es/Gemini/components/Mono.js'
import * as OpenAIModule from '@lobehub/icons/es/OpenAI/components/Mono.js'
import * as XAIModule from '@lobehub/icons/es/XAI/components/Mono.js'
import { useEffect, useState, type ComponentType, type CSSProperties } from 'react'
import type { ChatProvider, SettingsRecord } from '../wire.ts'
import type { BrowserProfile, Health, ProviderStats, SyncStatus } from './remote.ts'

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

export interface SettingsSnapshot { settings: SettingsRecord; health?: Health; profiles?: readonly BrowserProfile[]; stats?: readonly ProviderStats[]; sync?: SyncStatus; error?: string; notice?: string; loading?: boolean }
export interface SettingsInjected {
  hooks: { scope: ObservableSnapshot<SettingsSnapshot> }
  save(value: SettingsRecord): Promise<void>
  sync(providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
  install(): Promise<void>
}
type SettingsProps = PropsRuntime<'settings.section'> & InjectFace<SettingsInjected>
const PROVIDERS: ChatProvider[] = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok']
const PROVIDER_LABEL: Record<ChatProvider, string> = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok',
}
const OpenAIIcon = OpenAIModule.default as unknown as ComponentType<{ size?: number }>
const ClaudeIcon = ClaudeModule.default as unknown as ComponentType<{ size?: number }>
const GeminiIcon = GeminiModule.default as unknown as ComponentType<{ size?: number }>
const DeepSeekIcon = DeepSeekModule.default as unknown as ComponentType<{ size?: number }>
const XAIIcon = XAIModule.default as unknown as ComponentType<{ size?: number }>
export function ConversationSettings({ useScope, save, sync, cancel, refresh, install }: SettingsProps) {
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
      {state.sync?.error && <p className="dsh_ref_inline_error">{state.sync.error}</p>}
      {settings.autoSync && <p className="dsh_ref_auto_note">Automatic incremental sync runs every {settings.autoSyncMinutes} minutes while DSH is running.</p>}
    </section>
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
