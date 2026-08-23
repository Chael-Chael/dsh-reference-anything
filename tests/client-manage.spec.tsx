// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConversationSettings, ManageConversations, PAGE_SIZE, type BrowseState, type SettingsSnapshot } from '../src/client/components.tsx'
import type { Health, ManagedConversation } from '../src/client/remote.ts'
import { en } from '../src/client/locale.ts'
import { pickDirectoryWithError } from '../src/client/directory-picker.ts'
import { ALL_LOCAL_AGENTS, defaultPickerSettings, type SettingsRecord } from '../src/wire.ts'

// React only flushes effects synchronously inside act() when it is told it is
// in a test environment; without this every act() call warns and defers.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings = { opencliPath: 'opencli', profile: '', detailConcurrency: 8, autoSync: false, syncOnStartup: false, autoSyncMinutes: 60, historyMode: 'metadata-only' as const, enabledProviders: ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi'] as Array<'chatgpt' | 'claude' | 'gemini' | 'deepseek' | 'grok' | 'kimi'>, enabledAgents: [...ALL_LOCAL_AGENTS], maxReadTurns: 10, inputRenderMode: 'pill' as const, cloudDriveDownloadDirectory: '' }
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
  daemonVersion: '1.8.6', daemonStale: false, connectivityOk: true, connectivityChecked: true,
  pluginVersion: '0.2.1', adapterCommandsReady: true, adapterCompatible: true,
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
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined; host = undefined
  vi.restoreAllMocks()
})

type SettingsActions = {
  save?: (value: SettingsRecord) => Promise<boolean | void>
  setupAll?: (opened: boolean) => Promise<void>; discoverOpenCli?: () => Promise<void>; installOpenCli?: () => Promise<void>
  useProfile?: (profile: string) => Promise<void>; install?: () => Promise<void>; refresh?: () => Promise<void>
  checkUpdate?: () => Promise<void>; installUpdate?: () => Promise<void>
  quickRefreshOnOpen?: () => Promise<void>
  pickCloudDriveDownloadDirectory?: () => Promise<string | null>
}
function settingsElement(current: SettingsSnapshot, actions: SettingsActions = {}) {
  const noop = async () => {}
  const useScope = ((selector: (value: SettingsSnapshot) => unknown) => selector(current)) as never
  return <ConversationSettings close={() => {}} useSessions={(() => []) as never} useWorkspaces={(() => []) as never}
    useScope={useScope} save={actions.save ?? noop} sync={noop} cancel={noop} refresh={actions.refresh ?? noop} quickRefreshOnOpen={actions.quickRefreshOnOpen ?? noop}
    setupAll={actions.setupAll ?? noop} discoverOpenCli={actions.discoverOpenCli ?? noop} installOpenCli={actions.installOpenCli ?? noop}
    useProfile={actions.useProfile ?? noop} install={actions.install ?? noop} restartDaemon={noop} checkUpdate={actions.checkUpdate ?? noop} installUpdate={actions.installUpdate ?? noop} browse={noop} deleteConversation={noop}
    clearProvider={noop} clearOlder={noop} refreshStats={noop} pickCloudDriveDownloadDirectory={actions.pickCloudDriveDownloadDirectory} t={t} />
}
function renderSettings(current: SettingsSnapshot, actions: SettingsActions = {}): HTMLElement {
  return render(settingsElement(current, actions))
}
function rerenderSettings(current: SettingsSnapshot, actions: SettingsActions = {}): HTMLElement {
  act(() => { root!.render(settingsElement(current, actions)) })
  return host!
}

describe('cloud-drive download directory', () => {
  const directoryInput = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[aria-label="Cloud-drive download directory"]')!

  it('distinguishes the system temporary directory from a custom directory', () => {
    const system = renderSettings({ settings })
    expect(system.querySelector('.dsh_ref_cloud_download_state')?.textContent).toBe('System temporary directory')
    expect(directoryInput(system).value).toBe('')

    act(() => { root!.unmount() }); host!.remove()
    const custom = renderSettings({ settings: { ...settings, cloudDriveDownloadDirectory: 'D:\\Reference Downloads' } })
    expect(custom.querySelector('.dsh_ref_cloud_download_state')?.textContent).toBe('Custom directory')
    expect(directoryInput(custom).value).toBe('D:\\Reference Downloads')
  })

  it('saves a manually entered host path verbatim on blur or Enter', async () => {
    const saved: SettingsRecord[] = []
    const el = renderSettings({ settings }, { save: async value => { saved.push(value) } })
    const input = directoryInput(el)

    await act(async () => { setNativeValue(input, '/var/tmp/Drive Cache '); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(saved.at(-1)?.cloudDriveDownloadDirectory).toBe('/var/tmp/Drive Cache ')

    await act(async () => { setNativeValue(input, '\\\\server\\share\\cache'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(saved.at(-1)?.cloudDriveDownloadDirectory).toBe('\\\\server\\share\\cache')
  })

  it('rolls manual, picker, and reset failures back to the configured directory', async () => {
    const stable = '/var/tmp/stable'
    let save = vi.fn(async (_value: SettingsRecord) => false)
    let el = renderSettings({ settings: { ...settings, cloudDriveDownloadDirectory: stable } }, { save })
    let input = directoryInput(el)

    await act(async () => { setNativeValue(input, '/var/tmp/rejected'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(input.value).toBe(stable)

    act(() => { root!.unmount() }); host!.remove()
    save = vi.fn(async (_value: SettingsRecord) => false)
    el = renderSettings({ settings: { ...settings, cloudDriveDownloadDirectory: stable } }, { save, pickCloudDriveDownloadDirectory: async () => '/var/tmp/picked' })
    await act(async () => { Array.from(el.querySelectorAll<HTMLButtonElement>('.dsh_ref_cloud_download button')).find(button => button.textContent === 'Choose folder')!.click() })
    expect(directoryInput(el).value).toBe(stable)

    act(() => { root!.unmount() }); host!.remove()
    save = vi.fn(async (_value: SettingsRecord) => { throw new Error('save failed') })
    el = renderSettings({ settings: { ...settings, cloudDriveDownloadDirectory: stable } }, { save })
    await act(async () => { Array.from(el.querySelectorAll<HTMLButtonElement>('.dsh_ref_cloud_download button')).find(button => button.textContent === 'Use system temporary directory')!.click() })
    expect(directoryInput(el).value).toBe(stable)
  })

  it('serializes rapid saves and rolls back to the last successful value', async () => {
    const first = deferred<boolean | void>()
    const second = deferred<boolean | void>()
    const save = vi.fn((_value: SettingsRecord) => save.mock.calls.length === 1 ? first.promise : second.promise)
    const el = renderSettings({ settings: { ...settings, cloudDriveDownloadDirectory: '/stable' } }, { save })
    const input = directoryInput(el)

    act(() => { setNativeValue(input, '/first'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    act(() => { setNativeValue(input, '/second'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(save).toHaveBeenCalledTimes(1)

    await act(async () => { first.resolve(true); await first.promise; await Promise.resolve() })
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[0].cloudDriveDownloadDirectory).toBe('/second')
    await act(async () => { second.resolve(false); await second.promise })
    expect(input.value).toBe('/first')
  })

  it('locks the draft through a deferred save and scope write-back', async () => {
    const pending = deferred<boolean | void>()
    const actions: SettingsActions = { save: () => pending.promise }
    const stable = { ...settings, cloudDriveDownloadDirectory: '/var/tmp/stable' }
    const el = renderSettings({ settings: stable }, actions)
    const input = directoryInput(el)

    act(() => { setNativeValue(input, '/var/tmp/pending path'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    const [choose, reset] = Array.from(el.querySelectorAll<HTMLButtonElement>('.dsh_ref_cloud_download button'))
    expect(input.disabled).toBe(true)
    expect(choose?.disabled).toBe(true)
    expect(reset?.disabled).toBe(true)

    rerenderSettings({ settings: { ...stable, cloudDriveDownloadDirectory: '/var/tmp/pending path' } }, actions)
    expect(input.value).toBe('/var/tmp/pending path')
    expect(input.disabled).toBe(true)

    await act(async () => { pending.resolve(true); await pending.promise; await Promise.resolve() })
    expect(input.disabled).toBe(false)
    act(() => { setNativeValue(input, '/var/tmp/next path'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(input.value).toBe('/var/tmp/next path')
  })

  it('resets a custom directory to the system temporary directory', async () => {
    const save = vi.fn(async (_value: SettingsRecord) => {})
    const el = renderSettings({ settings: { ...settings, cloudDriveDownloadDirectory: '/var/tmp/references' } }, { save })
    const reset = Array.from(el.querySelectorAll<HTMLButtonElement>('.dsh_ref_cloud_download button')).find(button => button.textContent === 'Use system temporary directory')!

    await act(async () => { reset.click() })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cloudDriveDownloadDirectory: '' }))
  })

  it('saves the directory selected by the host picker', async () => {
    const save = vi.fn(async (_value: SettingsRecord) => {})
    const pickCloudDriveDownloadDirectory = vi.fn(async () => 'C:\\Users\\alice\\Downloads')
    const el = renderSettings({ settings }, { save, pickCloudDriveDownloadDirectory })
    const choose = Array.from(el.querySelectorAll<HTMLButtonElement>('.dsh_ref_cloud_download button')).find(button => button.textContent === 'Choose folder')!

    await act(async () => { choose.click() })
    expect(pickCloudDriveDownloadDirectory).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cloudDriveDownloadDirectory: 'C:\\Users\\alice\\Downloads' }))
  })

  it('does not save when the host picker is cancelled', async () => {
    const save = vi.fn(async (_value: SettingsRecord) => {})
    const el = renderSettings({ settings }, { save, pickCloudDriveDownloadDirectory: async () => null })
    const choose = Array.from(el.querySelectorAll<HTMLButtonElement>('.dsh_ref_cloud_download button')).find(button => button.textContent === 'Choose folder')!

    await act(async () => { choose.click() })
    expect(save).not.toHaveBeenCalled()
  })

  it('disables the chooser while the host picker is active', async () => {
    const selected = deferred<string | null>()
    const el = renderSettings({ settings }, { pickCloudDriveDownloadDirectory: () => selected.promise })
    const choose = Array.from(el.querySelectorAll<HTMLButtonElement>('.dsh_ref_cloud_download button')).find(button => button.textContent === 'Choose folder')!

    act(() => { choose.click() })
    expect(choose.disabled).toBe(true)
    await act(async () => { selected.resolve(null); await selected.promise })
    expect(choose.disabled).toBe(false)
  })

  it('reports host-picker failures and keeps the manual input usable', async () => {
    const save = vi.fn(async (_value: SettingsRecord) => {})
    const failure = new Error('Native directory picker unavailable')
    const reportError = vi.fn()
    const el = renderSettings({ settings }, {
      save,
      pickCloudDriveDownloadDirectory: () => pickDirectoryWithError({ pickDirectory: async () => { throw failure } }, reportError),
    })
    const choose = Array.from(el.querySelectorAll<HTMLButtonElement>('.dsh_ref_cloud_download button')).find(button => button.textContent === 'Choose folder')!

    await act(async () => { choose.click() })
    expect(reportError).toHaveBeenCalledWith(failure)
    const input = directoryInput(el)
    expect(input.disabled).toBe(false)
    await act(async () => { setNativeValue(input, '/tmp/manual'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await Promise.resolve() })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cloudDriveDownloadDirectory: '/tmp/manual' }))
  })
})

describe('local agent settings', () => {
  it('renders all 14 agents beside provider settings and saves an individual toggle', async () => {
    const save = vi.fn(async (_value: SettingsRecord) => {})
    const el = renderSettings({ settings }, { save })
    const cards = el.querySelectorAll('[data-local-agent]')
    expect(cards).toHaveLength(14)
    expect(Array.from(cards).map(card => card.getAttribute('data-local-agent'))).toContain('codex')
    const codex = el.querySelector('[data-local-agent="codex"] input') as HTMLInputElement
    await act(async () => { codex.click() })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabledAgents: expect.not.arrayContaining(['codex']) }))
  })
})

describe('settings update bar', () => {
  const currentUpdate = { currentVersion: '0.2.1', latestVersion: '0.2.1', updateAvailable: false, checkedAt: Date.now() }

  it('places the settings workspace directly below the update bar', () => {
    const el = renderSettings({ settings, update: currentUpdate })
    const header = el.querySelector('.dsh_ref_header')!
    const update = el.querySelector('.dsh_ref_update_bar')!
    const workspace = el.querySelector('.dsh_ref_workspace')!

    expect(header.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(update.nextElementSibling).toBe(workspace)
  })

  it('puts the GitHub repository link immediately to the right of check updates', async () => {
    const checkUpdate = vi.fn(async () => {})
    const el = renderSettings({ settings, update: currentUpdate }, { checkUpdate })
    const actions = el.querySelector('.dsh_ref_update_actions')!
    const [check, github] = Array.from(actions.children)

    expect(check?.textContent).toBe('Check for updates')
    expect(github?.textContent).toBe('GitHub')
    expect(github).toMatchObject({ tagName: 'A' })
    expect((github as HTMLAnchorElement).href).toBe('https://github.com/Chael-Chael/dsh-reference-anything')
    expect((github as HTMLAnchorElement).target).toBe('_blank')

    await act(async () => { (check as HTMLButtonElement).click() })
    expect(checkUpdate).toHaveBeenCalledOnce()
  })

  it('installs an available version only after confirmation', async () => {
    const installUpdate = vi.fn(async () => {})
    const update = { ...currentUpdate, latestVersion: '0.2.2', updateAvailable: true }
    const el = renderSettings({ settings, update }, { installUpdate })
    const button = Array.from(el.querySelectorAll('.dsh_ref_update_actions button')).find(item => item.textContent === 'Update to v0.2.2') as HTMLButtonElement
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)

    await act(async () => { button.click() })
    expect(installUpdate).not.toHaveBeenCalled()
    await act(async () => { button.click() })
    expect(installUpdate).toHaveBeenCalledOnce()
    expect(confirmation).toHaveBeenCalledTimes(2)
  })
})

describe('local agent source selection', () => {
  it('shows every supported agent and saves an explicit selection', async () => {
    const saved: SettingsRecord[] = []
    const el = renderSettings({ settings }, { save: async value => { saved.push(value) } })
    const choices = el.querySelector('.dsh_ref_selection_grid')!.querySelectorAll<HTMLInputElement>('input')
    expect(choices).toHaveLength(14)
    await act(async () => { choices[0]!.click() })
    expect(saved.at(-1)?.enabledAgents).not.toContain('claude-code')
    expect(saved.at(-1)?.enabledAgents).toHaveLength(13)
  })

  it('places agent and drive choices directly below external conversation cards', async () => {
    const saved: SettingsRecord[] = []
    const el = renderSettings({ settings, openListMounts: [
      { id: '1', name: '/work', driver: 'OneDrive', enabled: true, status: 'ready' },
      { id: '2', name: '/archive', driver: 'Aliyundrive', enabled: true, status: 'ready' },
    ] }, { save: async value => { saved.push(value) } })
    const providerGrid = el.querySelector('.dsh_ref_provider_grid')!
    const agentChoices = el.querySelector('.dsh_ref_agent_choices')!
    const cloudSetup = el.querySelector('.dsh_ref_cloud')!
    const driveChoices = el.querySelector('.dsh_ref_drive_choices')!
    expect(providerGrid.compareDocumentPosition(agentChoices) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(cloudSetup.compareDocumentPosition(driveChoices) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    const driveToggles = driveChoices.querySelectorAll<HTMLInputElement>('input')
    expect(driveToggles).toHaveLength(2)
    await act(async () => { driveToggles[0]!.click() })
    expect(saved.at(-1)?.enabledDriveMounts).toEqual(['/archive'])
  })
})

describe('adapter viability repair', () => {
  it('keeps only one-click setup in service actions because row actions already handle repairs', () => {
    const el = renderSettings({ settings, health: healthyHealth })
    const actions = el.querySelector('.dsh_ref_service_actions')!

    expect(actions.querySelectorAll('button')).toHaveLength(1)
    expect(actions.textContent).toBe('One-click setup')
  })

  it('shows an import failure and offers a working repair action', async () => {
    const install = vi.fn(async () => {})
    const health: Health = {
      ...healthyHealth, adapterCommandsReady: false, adapterCompatible: false,
      pluginError: "⚠ Plugin dsh-chat-history/chatgpt.js: Cannot find package '@jackwener/opencli'",
    }
    const el = renderSettings({ settings, health }, { install })
    const adapterRow = Array.from(el.querySelectorAll('.dsh_ref_check')).find(row => row.textContent?.includes('Conversation adapter'))!
    const repair = Array.from(adapterRow.querySelectorAll('button')).find(button => button.textContent === 'Repair adapter') as HTMLButtonElement

    expect(adapterRow.textContent).toContain('The adapter is registered but failed to load')
    await act(async () => { repair.click() })
    expect(install).toHaveBeenCalledOnce()
  })
})

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

  it('links each row to its original conversation in a new tab', () => {
    const page = { items: [conversation()], total: 1 }
    const el = render(<ManageConversations state={snapshot({ query: '', offset: 0, page })} syncing={false} browse={noop} deleteConversation={noop} t={t} />)
    const link = el.querySelector('.dsh_ref_manage_row_actions a') as HTMLAnchorElement

    expect(link.textContent).toBe('Open')
    expect(link.href).toBe('https://example.test/c/1')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
  })

  it('disables the open action when a legacy row has no URL', () => {
    const page = { items: [conversation({ url: '' })], total: 1 }
    const el = render(<ManageConversations state={snapshot({ query: '', offset: 0, page })} syncing={false} browse={noop} deleteConversation={noop} t={t} />)
    const link = el.querySelector('.dsh_ref_manage_row_actions a') as HTMLAnchorElement

    expect(link.hasAttribute('href')).toBe(false)
    expect(link.getAttribute('aria-disabled')).toBe('true')
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
    const el = render(<ConversationSettings close={() => {}} useSessions={(() => []) as never} useWorkspaces={(() => []) as never} useScope={useScope} save={async value => { saved.push(value) }} sync={noop} cancel={noop} refresh={noop} setupAll={noop} discoverOpenCli={noop} installOpenCli={noop} useProfile={noop} install={noop} restartDaemon={noop} checkUpdate={noop} installUpdate={noop} browse={noop} deleteConversation={noop} clearProvider={noop} clearOlder={noop} refreshStats={noop} t={t} />)
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

  it('switches the picker from collapse controls to native DSH scrolling', () => {
    const saved: SettingsRecord[] = []
    const current: SettingsSnapshot = { settings: { ...settings, picker: defaultPickerSettings() }, loading: true }
    const useScope = ((selector: (value: SettingsSnapshot) => unknown) => selector(current)) as never
    const el = render(<ConversationSettings close={() => {}} useSessions={(() => []) as never} useWorkspaces={(() => []) as never} useScope={useScope} save={async value => { saved.push(value) }} sync={noop} cancel={noop} refresh={noop} setupAll={noop} discoverOpenCli={noop} installOpenCli={noop} useProfile={noop} install={noop} restartDaemon={noop} checkUpdate={noop} installUpdate={noop} browse={noop} deleteConversation={noop} clearProvider={noop} clearOlder={noop} refreshStats={noop} t={t} />)
    const select = el.querySelector('.dsh_ref_render_mode select') as HTMLSelectElement

    act(() => { setNativeValue(select, 'native-scroll'); select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(saved.at(-1)?.picker?.displayMode).toBe('native-scroll')
  })

})

describe('viability recovery actions', () => {
  it('runs the quiet health refresh when the settings panel opens', async () => {
    const quickRefreshOnOpen = vi.fn(async () => {})
    renderSettings({ settings, loading: false }, { quickRefreshOnOpen })
    await act(async () => {})
    expect(quickRefreshOnOpen).toHaveBeenCalledOnce()
  })

  it('shows a connected extension as not yet connectivity-verified after a quiet check', () => {
    const health = { ...healthyHealth, connectivityChecked: false, connectivityOk: false }
    const el = renderSettings({ settings, loading: false, health })
    const row = Array.from(el.querySelectorAll('.dsh_ref_check')).find(item => item.textContent?.includes('Extension connected; connectivity not verified'))!
    expect(row.querySelector('span')?.classList.contains('is_neutral')).toBe(true)
    expect(row.querySelector('span')?.textContent).toBe('•')
    expect(row.querySelector('small')?.classList.contains('is_warning')).toBe(false)
  })

  it('disables setup while settings data is still loading', () => {
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
