// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConversationSettings, ManageConversations, PAGE_SIZE, type BrowseState, type SettingsSnapshot } from '../src/client/components.tsx'
import type { Health, ManagedConversation } from '../src/client/remote.ts'
import { en } from '../src/client/locale.ts'
import { defaultPickerSettings, type SettingsRecord } from '../src/wire.ts'

// React only flushes effects synchronously inside act() when it is told it is
// in a test environment; without this every act() call warns and defers.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings = { opencliPath: 'opencli', profile: '', detailConcurrency: 8, autoSync: false, syncOnStartup: false, autoSyncMinutes: 60, historyMode: 'metadata-only' as const, enabledProviders: ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi'] as Array<'chatgpt' | 'claude' | 'gemini' | 'deepseek' | 'grok' | 'kimi'>, maxReadTurns: 10, inputRenderMode: 'pill' as const }
const t = ((key: keyof typeof en, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key])) as never

function conversation(overrides: Partial<ManagedConversation> = {}): ManagedConversation {
  return {
    uriId: 'a', provider: 'chatgpt', title: 'Cache design notes', url: 'https://example.test/c/1',
    updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
    turnCount: 24, partial: false, syncedAt: new Date().toISOString(), remoteMissing: false, ...overrides,
  }
}

function snapshot(browse: BrowseState): SettingsSnapshot { return { settings, browse } }

const healthyHealth: Health = {
  version: '1.8.6', daemon: 'Daemon: running', pluginInstalled: true, daemonRunning: true,
  extensionConnected: true, extensionState: 'connected', opencliCompatible: true,
  daemonVersion: '1.8.6', daemonStale: false, connectivityOk: true,
  pluginVersion: '0.2.0', adapterCommandsReady: true, adapterCompatible: true,
}

let root: Root | undefined
let host: HTMLElement | undefined
function render(node: Parameters<Root['render']>[0]): HTMLElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root!.render(node) })
  return host
}
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined; host = undefined
  vi.restoreAllMocks()
})

function renderSettings(current: SettingsSnapshot, actions: {
  setupAll?: (opened: boolean) => Promise<void>; discoverOpenCli?: () => Promise<void>; installOpenCli?: () => Promise<void>
  useProfile?: (profile: string) => Promise<void>; refresh?: () => Promise<void>
} = {}): HTMLElement {
  const noop = async () => {}
  const useScope = ((selector: (value: SettingsSnapshot) => unknown) => selector(current)) as never
  return render(<ConversationSettings close={() => {}} useSessions={(() => []) as never} useWorkspaces={(() => []) as never}
    useScope={useScope} save={noop} sync={noop} cancel={noop} refresh={actions.refresh ?? noop} refreshOnOpen={actions.refresh ?? noop}
    setupAll={actions.setupAll ?? noop} discoverOpenCli={actions.discoverOpenCli ?? noop} installOpenCli={actions.installOpenCli ?? noop}
    useProfile={actions.useProfile ?? noop} install={noop} restartDaemon={noop} browse={noop} deleteConversation={noop}
    clearProvider={noop} clearOlder={noop} refreshStats={noop} t={t} />)
}

describe('manage synced conversations', () => {
  const noop = async () => {}

  it('lists a page with the updated date and flags rows the provider no longer lists', () => {
    const page = { items: [conversation(), conversation({ uriId: 'b', title: 'Old thread', remoteMissing: true, partial: true })], total: 2 }
    const el = render(<ManageConversations state={snapshot({ query: '', offset: 0, page })} syncing={false} browse={noop} deleteConversation={noop} t={t} />)
    expect(el.querySelectorAll('.dsh_ref_manage_row')).toHaveLength(2)
    expect(el.textContent).toContain('Cache design notes')
    expect(el.textContent).toContain('no longer listed')
    expect(el.textContent).not.toContain('partial')
    expect(el.textContent).not.toContain('24 turns')
    expect(el.querySelector('.dsh_ref_pagination span')?.textContent).toBe('1–2 of 2')
  })

  it('refuses deletion while a sync could resurrect the row', () => {
    const page = { items: [conversation()], total: 1 }
    const el = render(<ManageConversations state={snapshot({ query: '', offset: 0, page })} syncing browse={noop} deleteConversation={noop} t={t} />)
    const button = el.querySelector('.dsh_ref_manage_row button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Cannot delete while a sync is running')
  })

  it('deletes only once the user confirms', () => {
    const deleted: string[] = []
    const remove = async (uriId: string) => { deleted.push(uriId) }
    const page = { items: [conversation()], total: 1 }
    const el = render(<ManageConversations state={snapshot({ query: '', offset: 0, page })} syncing={false} browse={noop} deleteConversation={remove} t={t} />)
    const button = el.querySelector('.dsh_ref_manage_row button') as HTMLButtonElement

    vi.spyOn(window, 'confirm').mockReturnValue(false)
    act(() => { button.click() })
    expect(deleted).toEqual([])

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    act(() => { button.click() })
    expect(deleted).toEqual(['a'])
  })

  it('bounds paging at both ends of the result set', () => {
    const requested: number[] = []
    const browse = async (_q: string, _p: undefined, offset: number) => { requested.push(offset) }
    const items = Array.from({ length: PAGE_SIZE }, (_, i) => conversation({ uriId: `c${String(i)}` }))
    const el = render(<ManageConversations state={snapshot({ query: '', offset: PAGE_SIZE, page: { items, total: 60 } })} syncing={false} browse={browse} deleteConversation={noop} t={t} />)
    const [previous, next] = Array.from(el.querySelectorAll('.dsh_ref_pagination button')) as HTMLButtonElement[]
    expect(previous!.disabled).toBe(false)
    expect(next!.disabled).toBe(false)
    act(() => { previous!.click() }); act(() => { next!.click() })
    expect(requested).toEqual([0, PAGE_SIZE * 2])
    expect(el.querySelector('.dsh_ref_pagination span')?.textContent).toBe('21–40 of 60')
  })

  it('says so when the mirror has nothing to show, distinctly from still loading', () => {
    const loading = render(<ManageConversations state={snapshot({ query: '', offset: 0 })} syncing={false} browse={noop} deleteConversation={noop} t={t} />)
    expect(loading.querySelector('.dsh_ref_manage_empty')?.textContent).toBe('Loading…')
    act(() => { root!.unmount() }); host!.remove()
    const empty = render(<ManageConversations state={snapshot({ query: 'zzz', offset: 0, page: { items: [], total: 0 } })} syncing={false} browse={noop} deleteConversation={noop} t={t} />)
    expect(empty.querySelector('.dsh_ref_manage_empty')?.textContent).toBe('No synced conversations match.')
  })

  it('offers one action for every conversation confirmed missing remotely', () => {
    const cleared: string[] = []
    const page = { items: [conversation({ remoteMissing: true })], total: 1 }
    const state = { ...snapshot({ query: '', offset: 0, page }), storage: { bytes: 100, conversations: 1, remoteMissing: 1, oldAccountConversations: 0 } }
    const el = render(<ManageConversations state={state} syncing={false} browse={noop} deleteConversation={noop} clearRemoteMissing={async () => { cleared.push('done') }} t={t} />)
    const button = Array.from(el.querySelectorAll('.dsh_ref_section_head button')).find(item => item.textContent === 'Delete cloud-missing conversations') as HTMLButtonElement
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    act(() => { button.click() })
    expect(cleared).toEqual(['done'])
  })

  it('offers a confirmed bulk action for conversations from old accounts', () => {
    const cleared: string[] = []
    const page = { items: [conversation()], total: 1 }
    const state = { ...snapshot({ query: '', offset: 0, page }), storage: { bytes: 100, conversations: 3, remoteMissing: 0, oldAccountConversations: 2 } }
    const el = render(<ManageConversations state={state} syncing={false} browse={noop} deleteConversation={noop} clearOldAccounts={async () => { cleared.push('done') }} t={t} />)
    const button = Array.from(el.querySelectorAll('.dsh_ref_section_head button')).find(item => item.textContent === 'Delete old-account chats') as HTMLButtonElement

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    act(() => { button.click() })
    expect(cleared).toEqual(['done'])
  })
})

describe('general settings editing', () => {
  const noop = async () => {}

  it('allows a picker limit to be temporarily empty, then validates it on commit', () => {
    const saved: SettingsRecord[] = []
    const current: SettingsSnapshot = { settings: { ...settings, picker: defaultPickerSettings() }, loading: true }
    const useScope = ((selector: (value: SettingsSnapshot) => unknown) => selector(current)) as never
    const el = render(<ConversationSettings close={() => {}} useSessions={(() => []) as never} useWorkspaces={(() => []) as never} useScope={useScope} save={async value => { saved.push(value) }} sync={noop} cancel={noop} refresh={noop} refreshOnOpen={noop} setupAll={noop} discoverOpenCli={noop} installOpenCli={noop} useProfile={noop} install={noop} restartDaemon={noop} browse={noop} deleteConversation={noop} clearProvider={noop} clearOlder={noop} refreshStats={noop} t={t} />)
    const input = el.querySelector('.dsh_ref_picker_limit input') as HTMLInputElement

    act(() => { setNativeValue(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(input.value).toBe('')
    expect(saved).toHaveLength(0)
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(input.value).toBe('6')
    expect(saved).toHaveLength(0)

    act(() => { setNativeValue(input, '12'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(saved.at(-1)?.picker?.commands.limit).toBe(12)
  })

  it('saves the Raw text input-rendering fallback', () => {
    const saved: SettingsRecord[] = []
    const current: SettingsSnapshot = { settings: { ...settings, picker: defaultPickerSettings() }, loading: true }
    const useScope = ((selector: (value: SettingsSnapshot) => unknown) => selector(current)) as never
    const el = render(<ConversationSettings close={() => {}} useSessions={(() => []) as never} useWorkspaces={(() => []) as never} useScope={useScope} save={async value => { saved.push(value) }} sync={noop} cancel={noop} refresh={noop} refreshOnOpen={noop} setupAll={noop} discoverOpenCli={noop} installOpenCli={noop} useProfile={noop} install={noop} restartDaemon={noop} browse={noop} deleteConversation={noop} clearProvider={noop} clearOlder={noop} refreshStats={noop} t={t} />)
    const select = el.querySelector('.dsh_ref_render_mode select') as HTMLSelectElement

    act(() => { setNativeValue(select, 'raw-text'); select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(saved.at(-1)?.inputRenderMode).toBe('raw-text')
  })
})

describe('viability recovery actions', () => {
  it('disables setup while the initial health check is still loading', () => {
    const el = renderSettings({ settings, loading: true })
    const button = Array.from(el.querySelectorAll('button')).find(item => item.textContent === 'One-click setup') as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('opens the extension store synchronously before setup starts', async () => {
    const order: string[] = []
    vi.spyOn(window, 'open').mockImplementation(() => {
      order.push('open')
      return { opener: window } as unknown as Window
    })
    const health = { ...healthyHealth, extensionConnected: false, extensionState: 'disconnected' as const, connectivityOk: false }
    const el = renderSettings({ settings, loading: false, health }, { setupAll: async opened => { order.push(`setup:${String(opened)}`) } })
    const button = Array.from(el.querySelectorAll('button')).find(item => item.textContent === 'One-click setup') as HTMLButtonElement

    await act(async () => { button.click() })
    expect(order).toEqual(['open', 'setup:true'])
  })

  it('locks setup synchronously against double clicks', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const pending = new Promise<void>(resolve => { release = resolve })
    const el = renderSettings({ settings, loading: false, health: healthyHealth }, {
      setupAll: async () => { calls++; await pending },
    })
    const button = Array.from(el.querySelectorAll('button')).find(item => item.textContent === 'One-click setup') as HTMLButtonElement

    act(() => { button.click(); button.click() })
    expect(calls).toBe(1)
    await act(async () => { release?.(); await pending })
  })

  it('shows a normal link when the extension-store popup is blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const health = { ...healthyHealth, extensionConnected: false, extensionState: 'disconnected' as const, connectivityOk: false }
    const el = renderSettings({ settings, loading: false, health })
    const button = Array.from(el.querySelectorAll('button')).find(item => item.textContent === 'One-click setup') as HTMLButtonElement

    await act(async () => { button.click() })
    expect(el.querySelector('.dsh_ref_store_fallback a')?.textContent).toBe('Open extension store')
  })

  it('offers installation and discovery when OpenCLI is missing', async () => {
    const called: string[] = []
    const health: Health = {
      ...healthyHealth, version: '', opencliCompatible: false, daemonRunning: false, daemonStale: false,
      extensionConnected: false, extensionState: 'daemon-offline', connectivityOk: false,
      pluginInstalled: false, adapterCompatible: false,
    }
    const el = renderSettings({ settings, loading: false, health }, {
      installOpenCli: async () => { called.push('install') }, discoverOpenCli: async () => { called.push('discover') },
    })
    const row = el.querySelector('.dsh_ref_check') as HTMLElement
    const buttons = Array.from(row.querySelectorAll('button')) as HTMLButtonElement[]

    await act(async () => { buttons[0]!.click() })
    expect(called).toEqual(['install'])
  })

  it('lets the user select a connected profile from the failing check row', async () => {
    const selected: string[] = []
    const health = { ...healthyHealth, extensionConnected: false, extensionState: 'profile-required' as const, connectivityOk: false, profileCount: 2 }
    const profiles = [
      { id: 'work-id', alias: 'work', connected: true, isDefault: false },
      { id: 'personal-id', alias: 'personal', connected: true, isDefault: false },
    ]
    const el = renderSettings({ settings, loading: false, health, profiles }, { useProfile: async profile => { selected.push(profile) } })
    const button = Array.from(el.querySelectorAll('.dsh_ref_check_profile button'))[0] as HTMLButtonElement

    await act(async () => { button.click() })
    expect(selected).toEqual(['work-id'])
  })
})

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')
  descriptor?.set?.call(element, value)
}
