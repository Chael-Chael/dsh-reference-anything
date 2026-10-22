import { expect, it, vi } from 'vitest'
import type { InputTriggerCandidate, InputTriggerServiceContract, MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { adoptOfficialReferenceMenu } from '../src/client/official-reference-menu.ts'
import { defaultPickerSettings } from '../src/wire.ts'

function setup() {
  const picker = defaultPickerSettings()
  picker.files.limit = picker.sessions.limit = 2
  const menu = createSnapshotStore<MenuState>({ open: false, hit: null, generation: 0, groups: [], highlight: null })
  const picked = vi.fn()
  const headers = createSnapshotStore(new Map<string, { label: string }[]>())
  const controller = { menu, headers, pick: (source: string, index: number) => picked(menu.getSnapshot().groups.find(g => g.source === source)?.items[index]) }
  const service = { sessionOf: () => controller } as unknown as InputTriggerServiceContract
  const restore = adoptOfficialReferenceMenu(service, () => picker, (key, params) => key === 'menu.collapse' ? 'Collapse' : `More ${params!.count}`)
  service.sessionOf({} as never)
  const rows = (kind: string, section: string) => Array.from({ length: 8 }, (_, i) => ({ name: `${section}${i}`, section, value: JSON.stringify({ kind, mention: `@${i}` }) }))
  const files = rows('file', 'Files'), sessions = rows('session', 'Sessions'), children = rows('session', 'Children')
  const open: MenuState = { open: true, hit: { trigger: '@', query: '', quoted: false, position: 'inline', span: { start: 0, end: 1, draftRev: 1 } }, generation: 1, groups: [{ source: 'reference', status: 'ready', items: [...files, ...children, ...sessions] }], highlight: { source: 'reference', index: 0 } }
  const items = () => menu.getSnapshot().groups.filter(g => g.source === 'reference' || g.source === 'reference-anything:official-sessions').flatMap(g => g.items)
  const pick = (name: string) => { const group = menu.getSnapshot().groups.find(g => g.items.some(row => row.name === name))!; controller.pick(group.source, group.items.findIndex(row => row.name === name)) }
  return { picker, menu, controller, picked, restore, open, items, pick, files, service }
}

it('collapses each official section and forwards original candidates unchanged', () => {
  const h = setup()
  h.menu.set(h.open)
  expect(h.items().map(row => row.name)).toEqual(['Files0', 'Files1', 'More 5', 'Children0', 'Children1', 'More 5', 'Sessions0', 'Sessions1', 'More 5'])
  h.pick('Files1')
  expect(h.picked).toHaveBeenCalledWith(h.files[1])
  expect(h.items()[1]).toBe(h.files[1])
  h.menu.set(h.open)
  expect(h.items()).toHaveLength(9)
  h.pick('More 5')
  expect(h.picked).toHaveBeenCalledTimes(1)
  expect(h.items().filter(row => row.section === 'Files')).toHaveLength(9)
  h.pick('Collapse')
  expect(h.items().filter(row => row.section === 'Files')).toHaveLength(3)
  h.restore()
  expect(h.items()).toEqual(h.open.groups[0]!.items)
})

it('shows only files below the official root, including native-scroll, and restores sessions at root', () => {
  const h = setup()
  h.controller.headers.set(new Map([['reference', [{ label: 'Files' }, { label: 'folder' }]]]))
  h.menu.set(h.open)
  expect(h.items().every(row => row.section === 'Files')).toBe(true)
  h.picker.displayMode = 'native-scroll'; h.menu.set(h.open)
  expect(h.items()).toEqual(h.files)
  h.controller.headers.set(new Map([['reference', [{ label: 'Files' }]]]))
  h.menu.set(h.open)
  expect(h.items()).toEqual(h.open.groups[0]!.items)
  h.restore()
})

it('retains expansion on navigation and other source updates, resets on a new query', () => {
  const h = setup()
  h.menu.set(h.open); h.pick('More 5')
  const before = h.menu.getSnapshot()
  h.menu.set({ ...before, highlight: { source: 'reference', index: 5 } })
  expect(h.items()[5]!.name).toBe('Files5')
  h.menu.set({ ...h.menu.getSnapshot(), groups: [...h.menu.getSnapshot().groups, { source: 'other', status: 'ready', items: [{ name: 'other' }] }] })
  expect(h.items()[5]!.name).toBe('Files5')
  h.menu.set({ ...h.open, generation: 2, hit: { ...h.open.hit!, query: 'new' } })
  expect(h.items()[2]!.name).toBe('More 5')
  h.restore()
})

it('does not reparse official candidates on navigation or unrelated source updates', () => {
  const h = setup()
  h.menu.set(h.open)
  const parse = vi.spyOn(JSON, 'parse')
  try {
    const before = h.menu.getSnapshot()
    h.menu.set({ ...before, highlight: { source: 'reference', index: 1 } })
    h.menu.set({ ...h.menu.getSnapshot(), groups: [...before.groups, { source: 'other', status: 'ready', items: [] }] })
    expect(parse).not.toHaveBeenCalled()
    expect(h.menu.getSnapshot().groups.find(g => g.source === 'reference')!.items).toBe(before.groups.find(g => g.source === 'reference')!.items)
  } finally { parse.mockRestore(); h.restore() }
})

it('falls back on unknown candidate contracts and native-scroll', () => {
  const h = setup()
  const unknown: InputTriggerCandidate = { name: 'future', section: 'Files', value: '{}' }
  h.menu.set({ ...h.open, groups: [{ ...h.open.groups[0]!, items: [...h.files, unknown] }] })
  expect(h.items()).toEqual([...h.files, unknown])
  h.picker.displayMode = 'native-scroll'; h.menu.set(h.open)
  expect(h.items()).toEqual(h.open.groups[0]!.items)
  h.restore()
})

it('keeps session expansion independent and resets after closing or pending directory navigation', () => {
  const a = setup(), b = setup()
  a.menu.set(a.open); b.menu.set(b.open); a.pick('More 5')
  expect(b.items()).toHaveLength(9)
  a.menu.set({ ...a.open, open: false, hit: null, groups: [] })
  a.menu.set(a.open)
  expect(a.items()).toHaveLength(9)
  a.pick('More 5')
  a.menu.set({ ...a.open, generation: 2, hit: { ...a.open.hit!, query: 'folder/' }, groups: [{ ...a.open.groups[0]!, status: 'pending', items: [] }] })
  a.menu.set({ ...a.open, generation: 2, hit: { ...a.open.hit!, query: 'folder/' } })
  expect(a.items()).toHaveLength(9)
  a.restore(); b.restore()
})

it('honors official display switches and restores cached rows without another fetch', () => {
  const h = setup()
  h.menu.set(h.open)
  h.picker.files.enabled = false
  h.menu.set(h.menu.getSnapshot())
  expect(h.menu.getSnapshot().groups.flatMap(g => g.items).some(row => row.section === 'Files')).toBe(false)
  h.picker.sessions.enabled = false
  h.menu.set(h.menu.getSnapshot())
  expect(h.menu.getSnapshot().groups.flatMap(g => g.items)).toEqual([])
  h.picker.files.enabled = h.picker.sessions.enabled = true
  h.menu.set(h.menu.getSnapshot())
  expect(h.menu.getSnapshot().groups.flatMap(g => g.items)).toContain(h.files[0])
  h.restore()
})

it('interleaves official files and sessions with RA sources and routes picks to the official owner', () => {
  const h = setup()
  h.picker.sessions.order = 0; h.picker.agents.order = 10; h.picker.files.order = 20
  h.menu.set({ ...h.open, groups: [...h.open.groups, { source: 'Local agent conversations', status: 'ready', items: [{ name: 'agent' }] }] })
  const groups = h.menu.getSnapshot().groups.filter(g => g.items.length)
  expect(groups.map(g => g.items[0]!.name)).toEqual(['Children0', 'agent', 'Files0'])
  const sessions = groups[0]!
  h.controller.pick(sessions.source, 0)
  expect(h.picked).toHaveBeenCalledWith(h.open.groups[0]!.items[8])
  h.restore()
  expect(h.menu.getSnapshot().groups.some(g => g.source === sessions.source && g.items[0]?.name === 'Children0')).toBe(false)
})

it('keeps keyboard row identity when order changes and uses switches in native-scroll mode', () => {
  const h = setup()
  h.menu.set(h.open)
  h.menu.set({ ...h.menu.getSnapshot(), highlight: { source: 'reference', index: 1 } })
  h.picker.sessions.order = -1
  h.menu.set(h.menu.getSnapshot())
  expect(h.menu.getSnapshot().highlight).toEqual({ source: 'reference', index: 1 })
  h.picker.displayMode = 'native-scroll'; h.picker.sessions.enabled = false
  h.menu.set(h.menu.getSnapshot())
  expect(h.items()).toEqual(h.files)
  h.picker.files.enabled = false
  h.menu.set(h.menu.getSnapshot())
  expect(h.menu.getSnapshot().highlight).toBeNull()
  h.restore()
})
