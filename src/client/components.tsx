import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatProvider, SettingsRecord } from '../wire.ts'
import type { Health, SyncStatus } from './remote.ts'

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

export interface SettingsSnapshot { settings: SettingsRecord; health?: Health; sync?: SyncStatus; error?: string }
export interface SettingsInjected {
  hooks: { scope: ObservableSnapshot<SettingsSnapshot> }
  save(value: SettingsRecord): Promise<void>
  sync(providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
}
type SettingsProps = PropsRuntime<'settings.section'> & InjectFace<SettingsInjected>
const PROVIDERS: ChatProvider[] = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok']
export function ConversationSettings({ useScope, save, sync, cancel, refresh }: SettingsProps) {
  const state = useScope(value => value)
  const settings = state.settings
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
    <div className="dsh_ref_actions">
      <button type="button" disabled={state.sync?.status === 'running'} onClick={() => { void sync(PROVIDERS, 'incremental') }}>Sync all</button>
      <button type="button" disabled={state.sync?.status === 'running'} onClick={() => { void sync(PROVIDERS, 'full') }}>Full rescan</button>
      {state.sync?.status === 'running' && <button type="button" onClick={() => { void cancel() }}>Cancel</button>}
    </div>
    {state.sync && <p>{state.sync.status} · {state.sync.provider || ''} · {state.sync.completed}/{state.sync.total}{state.sync.error ? ` · ${state.sync.error}` : ''}</p>}
    <div className="dsh_ref_provider_grid">{PROVIDERS.map(provider => <button type="button" key={provider} disabled={state.sync?.status === 'running'} onClick={() => { void sync([provider], 'incremental') }}>{provider}</button>)}</div>
  </section>
}
