// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import type { InputTriggerServiceContract, MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { adoptMenuOpening } from '../src/client/menu-opening.ts'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); document.body.innerHTML = '' })
function setup() {
  let state: MenuState = { open: false, hit: null, generation: 0, groups: [], highlight: null }
  const menu = { getSnapshot: () => state, set: (next: MenuState) => { state = next } }
  const originalSet = menu.set
  const service = { sessionOf: () => ({ menu }) } as unknown as InputTriggerServiceContract
  // A session controller is stable across calls in DSH.
  const controller = { menu }
  service.sessionOf = (() => controller) as unknown as typeof service.sessionOf
  const sessionOf = service.sessionOf
  dispose = adoptMenuOpening(service)
  service.sessionOf({} as never)
  const hit = { trigger: '@' as const, query: '', quoted: false, position: 'inline' as const, span: { start: 0, end: 1, draftRev: 1 } }
  const open: MenuState = { open: true, hit, generation: 1, groups: [
    { source: 'Files', status: 'pending', items: [] },
    { source: 'Agents', status: 'ready', items: [{ name: 'session' }, { name: 'second' }] },
  ], highlight: { source: 'Agents', index: 0 } }
  document.body.innerHTML = '<div data-composer-card><input></div>'
  return { menu, open, service, sessionOf, originalSet }
}

it('does not select a fast lower group before preceding groups settle', () => {
  const { menu, open } = setup()
  menu.set(open)
  expect(menu.getSnapshot().highlight).toBeNull()
  menu.set({ ...open, groups: [{ source: 'Files', status: 'ready', items: [{ name: 'README' }] }, open.groups[1]!] })
  expect(menu.getSnapshot().highlight).toEqual({ source: 'Files', index: 0 })
})

it('makes ready official references selectable while RA sources are pending', () => {
  const { menu, open } = setup()
  menu.set({ ...open, groups: [open.groups[0]!, { source: 'reference', status: 'ready', items: [{ name: 'file' }] }] })
  expect(menu.getSnapshot().highlight).toEqual({ source: 'reference', index: 0 })
})

it.each([0, 1])('keeps native keyboard selection %i without a document keydown event', index => {
  const { menu, open } = setup()
  menu.set(open)
  const before = menu.getSnapshot()
  const highlight = { source: 'Agents', index }
  // Native navigation changes the highlight while retaining the candidate groups.
  menu.set({ ...before, highlight })
  expect(menu.getSnapshot().highlight).toEqual(highlight)
  menu.set({ ...menu.getSnapshot(), groups: [{ source: 'Files', status: 'ready', items: [{ name: 'README' }] }, open.groups[1]!] })
  expect(menu.getSnapshot().highlight).toEqual(highlight)
  menu.set({ ...open, open: false, hit: null, groups: [], highlight: null })
  menu.set(open)
  expect(menu.getSnapshot().highlight).toBeNull()
})

it('lets native navigation leave the first settled candidate without a DOM event', () => {
  const { menu, open } = setup()
  menu.set({ ...open, groups: [open.groups[1]!] })
  expect(menu.getSnapshot().highlight).toEqual({ source: 'Agents', index: 0 })
  menu.set({ ...menu.getSnapshot(), highlight: { source: 'Agents', index: 1 } })
  expect(menu.getSnapshot().highlight).toEqual({ source: 'Agents', index: 1 })
})

it.each(['pointermove', 'pointerdown', 'wheel', 'touchmove', 'keydown'])('respects user interaction: %s', event => {
  const { menu, open } = setup()
  menu.set(open)
  document.querySelector('input')!.dispatchEvent(event === 'keydown' ? new KeyboardEvent(event, { key: 'ArrowDown', bubbles: true }) : new Event(event, { bubbles: true }))
  const selected = { ...open, highlight: { source: 'Agents', index: 1 } }
  menu.set(selected)
  expect(menu.getSnapshot().highlight).toEqual(selected.highlight)
  menu.set({ ...open, open: false, hit: null, groups: [], highlight: null })
  menu.set(open)
  expect(menu.getSnapshot().highlight).toBeNull()
})

it('releases initial selection on search refinement and restores hooks on disposal', () => {
  const { menu, open, service, sessionOf, originalSet } = setup()
  menu.set(open)
  const refined = { ...open, hit: { ...open.hit!, query: 'docs/' } }
  menu.set(refined)
  expect(menu.getSnapshot().highlight).toEqual(refined.highlight)
  dispose!()
  expect(service.sessionOf).toBe(sessionOf)
  expect(menu.set).toBe(originalSet)
})

it('uses the first nonempty settled group and leaves slash menus alone', () => {
  const { menu, open } = setup()
  menu.set({ ...open, groups: [{ source: 'Files', status: 'ready', items: [] }, open.groups[1]!] })
  expect(menu.getSnapshot().highlight).toEqual({ source: 'Agents', index: 0 })
  menu.set({ ...open, open: false, hit: null })
  menu.set({ ...open, hit: { ...open.hit!, trigger: '/' } })
  expect(menu.getSnapshot().highlight).toEqual(open.highlight)
})

it('isolates agent actions from official and RA groups until returning to the list', () => {
  const { menu, open } = setup()
  const agent = { source: 'Local agent conversations', status: 'ready' as const, items: [
    { name: 'Confirm import', value: JSON.stringify({ kind: 'agent-import' }) },
    { name: 'Back', value: JSON.stringify({ kind: 'agent-back' }) },
  ] }
  const others = [{ source: 'reference', status: 'ready' as const, items: [{ name: 'file' }] }, ...open.groups]
  const nested = { ...open, hit: { ...open.hit!, query: 'agents:' }, groups: [...others, agent] }
  menu.set(nested)
  expect(menu.getSnapshot().groups).toEqual([agent])
  expect(menu.getSnapshot().highlight).toEqual({ source: agent.source, index: 0 })
  // Late results and background refreshes cannot bring another source back.
  menu.set({ ...nested, highlight: { source: agent.source, index: 1 } })
  expect(menu.getSnapshot().groups).toEqual([agent])
  expect(menu.getSnapshot().highlight?.index).toBe(1)
  const list = { ...agent, items: [{ name: 'Conversation', value: JSON.stringify({ kind: 'agent' }) }] }
  menu.set({ ...nested, generation: 2, groups: [...others, list] })
  expect(menu.getSnapshot().groups).toEqual([...others, list])
})
