import { describe, expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InputTriggerServiceContract, MenuState,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createPickerMenuActionGuard, createPickerMenuUpdater } from '../src/client/menu-update.ts'

const hit = {
  trigger: '@' as const,
  query: '',
  quoted: false,
  position: 'inline' as const,
  span: { start: 0, end: 1, draftRev: 1 },
}

function bench() {
  let state: MenuState = {
    open: true,
    hit,
    generation: 4,
    groups: [
      { source: 'Commands', status: 'ready', items: [{ name: 'plan' }] },
      { source: 'External conversations', status: 'ready', items: [{ name: 'old' }] },
    ],
    highlight: { source: 'External conversations', index: 0 },
  }
  const set = vi.fn((next: MenuState) => { state = next })
  const controller = { menu: { getSnapshot: () => state, set } }
  const inputTriggers = { sessionOf: () => controller } as unknown as InputTriggerServiceContract
  const sessions = { scope: () => ({}) } as unknown as ISessions
  let mutation: (() => void) | undefined
  const schedule = vi.fn((_source, _anchor, run: () => void) => { mutation = run })
  const update = createPickerMenuUpdater(inputTriggers, sessions, schedule)
  return {
    get state() { return state },
    close() { state = { open: false, hit: null, generation: state.generation, groups: [], highlight: null } },
    run() { mutation?.() },
    schedule,
    set,
    update,
  }
}

describe('in-place picker menu updates', () => {
  it('restores a handled action from the captured generation with only its source replaced', () => {
    const b = bench()
    expect(b.update({
      sessionId: 'session-1' as never,
      source: 'External conversations',
      query: '',
      candidates: [{ name: 'old' }, { name: 'new' }, { name: 'Show 5 more' }],
      reopen: true,
      anchor: 'viewport',
    })).toBe(true)
    b.close()
    b.run()
    expect(b.schedule).toHaveBeenCalledWith('External conversations', 'viewport', expect.any(Function))
    expect(b.state.open).toBe(true)
    expect(b.state.hit).toEqual(hit)
    expect(b.state.groups[0]?.items).toEqual([{ name: 'plan' }])
    expect(b.state.groups[1]?.items.map(item => item.name)).toEqual(['old', 'new', 'Show 5 more'])
    expect(b.state.highlight).toBeNull()
  })

  it('does not reopen a menu closed before a background update lands', () => {
    const b = bench()
    expect(b.update({
      sessionId: 'session-1' as never,
      source: 'External conversations',
      query: '',
      candidates: [{ name: 'Syncing 1/5' }],
      reopen: false,
    })).toBe(true)
    b.close()
    b.run()
    expect(b.set).not.toHaveBeenCalled()
    expect(b.state.open).toBe(false)
  })

  it('ignores cached results for a different active query', () => {
    const b = bench()
    expect(b.update({
      sessionId: 'session-1' as never,
      source: 'External conversations',
      query: 'other',
      candidates: [{ name: 'stale' }],
      reopen: true,
    })).toBe(false)
    expect(b.schedule).not.toHaveBeenCalled()
  })

  it('suppresses the native close only for plugin-owned menu actions', () => {
    let state: MenuState = {
      open: true,
      hit,
      generation: 2,
      groups: [{
        source: 'External conversations',
        status: 'ready',
        items: [
          { name: 'Show 5 more', value: JSON.stringify({ kind: 'action', action: 'expand' }) },
          { name: 'Conversation', value: JSON.stringify({ kind: 'conversation' }) },
        ],
      }],
      highlight: null,
    }
    const menu = {
      getSnapshot: () => state,
      set: (next: MenuState) => { state = next },
    }
    const nativePick = vi.fn((_source: string, _index: number) => {
      menu.set({ open: false, hit: null, generation: state.generation, groups: [], highlight: null })
    })
    const controller = { menu, pick: nativePick }
    const inputTriggers = { sessionOf: () => controller } as unknown as InputTriggerServiceContract
    const sessions = { scope: () => ({}) } as unknown as ISessions
    const guard = createPickerMenuActionGuard(inputTriggers, sessions)
    expect(guard('session-1' as never, 'External conversations')).toBe(true)

    controller.pick('External conversations', 0)
    expect(nativePick).toHaveBeenCalledOnce()
    expect(state.open).toBe(true)

    controller.pick('External conversations', 1)
    expect(nativePick).toHaveBeenCalledTimes(2)
    expect(state.open).toBe(false)
  })
})
