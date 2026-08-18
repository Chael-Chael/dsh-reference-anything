// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ManageConversations, PAGE_SIZE, type BrowseState, type SettingsSnapshot } from '../src/client/components.tsx'
import type { ManagedConversation } from '../src/client/remote.ts'
import { en } from '../src/client/locale.ts'

// React only flushes effects synchronously inside act() when it is told it is
// in a test environment; without this every act() call warns and defers.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings = { opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false, autoSyncMinutes: 60, historyMode: 'metadata-only' as const }
const t = ((key: keyof typeof en, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key])) as never

function conversation(overrides: Partial<ManagedConversation> = {}): ManagedConversation {
  return {
    uriId: 'a', provider: 'chatgpt', title: 'Cache design notes', url: 'https://example.test/c/1',
    updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
    turnCount: 24, partial: false, syncedAt: new Date().toISOString(), remoteMissing: false, ...overrides,
  }
}

function snapshot(browse: BrowseState): SettingsSnapshot { return { settings, browse } }

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
})
