import { describe, expect, it } from 'vitest'
import { continuationFooter, renderReferences } from '../src/render.ts'
import { parseWindow } from '../src/tool.ts'
import { sliceTurns } from '../src/window.ts'
import { encodeReferenceUri } from '../src/uri.ts'
import type { ConversationItem, ReferenceSnapshot } from '../src/types.ts'

const turns: ConversationItem[] = Array.from({ length: 10 }, (_v, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  text: `turn ${index}`,
}))

describe('sliceTurns', () => {
  it('returns the newest turns when no bound is given', () => {
    expect(sliceTurns(turns, { limit: 3 })).toEqual({
      kind: 'conversation',
      items: turns.slice(7),
      startIndex: 7,
      totalTurns: 10,
      hasOlder: true,
    })
  })

  it('walks backwards from an exclusive bound', () => {
    const first = sliceTurns(turns, { limit: 3 })
    const second = sliceTurns(turns, { limit: 3, before: first.startIndex })
    expect(second.items).toEqual(turns.slice(4, 7))
    expect(second.startIndex).toBe(4)
    // Paging backwards must not repeat or skip a turn.
    expect(second.startIndex + second.items.length).toBe(first.startIndex)
  })

  it('reports the start of the conversation once it is reached', () => {
    const slice = sliceTurns(turns, { limit: 50 })
    expect(slice).toMatchObject({ startIndex: 0, hasOlder: false })
    expect(slice.items).toHaveLength(10)
  })

  it('returns nothing before the first turn, without claiming more exists', () => {
    expect(sliceTurns(turns, { limit: 5, before: 0 })).toMatchObject({
      items: [],
      startIndex: 0,
      hasOlder: false,
    })
  })

  it('clamps a bound past the end instead of failing', () => {
    // A model reading backwards knows its last index but not always the total,
    // so asking beyond the end is an ordinary first request.
    expect(sliceTurns(turns, { limit: 2, before: 999 }).items).toEqual(turns.slice(8))
  })

  it('handles an empty conversation', () => {
    expect(sliceTurns([], { limit: 5 })).toMatchObject({
      items: [],
      startIndex: 0,
      totalTurns: 0,
      hasOlder: false,
    })
  })

  it('indices stay stable when the conversation gains turns', () => {
    const before = sliceTurns(turns, { limit: 4, before: 5 })
    const grown = sliceTurns([...turns, { role: 'user', text: 'turn 10' }], { limit: 4, before: 5 })
    // Counting from the oldest turn is what buys this; counting from the
    // newest would have slid the whole window.
    expect(grown.items).toEqual(before.items)
    expect(grown.startIndex).toBe(before.startIndex)
  })
})

describe('continuationFooter', () => {
  it('names the next coordinate when older turns remain', () => {
    expect(continuationFooter({ from: 7, count: 3, totalTurns: 10, hasOlder: true }))
      .toBe('(Showing turns 7-9 of 10. Use before=7 to read older turns.)')
  })

  it('says so at the start of the conversation', () => {
    expect(continuationFooter({ from: 0, count: 10, totalTurns: 10, hasOlder: false }))
      .toBe('(Showing turns 0-9 of 10. This is the start of the conversation.)')
  })

  it('omits the total when the source cannot count', () => {
    expect(continuationFooter({ from: 3, count: 2, hasOlder: true }))
      .toBe('(Showing turns 3-4. Use before=3 to read older turns.)')
  })

  it('reports an empty range plainly', () => {
    expect(continuationFooter({ from: 0, count: 0, hasOlder: false })).toBe('(No turns in this range.)')
  })
})

describe('parseWindow', () => {
  it('falls back to the deployment default', () => {
    expect(parseWindow({}, 10, 50)).toEqual({ limit: 10 })
  })

  it('passes a bound through', () => {
    expect(parseWindow({ limit: 5, before: 20 }, 10, 50)).toEqual({ limit: 5, before: 20 })
  })

  it('refuses a limit past the ceiling rather than silently clamping', () => {
    // Clamping would hand back fifty turns to a model that asked for a
    // hundred, which then assumes fifty was all there was.
    expect(() => parseWindow({ limit: 100 }, 10, 50)).toThrow(/less than or equal to 50/u)
  })

  it.each([
    ['zero', { limit: 0 }],
    ['negative', { limit: -1 }],
    ['fractional', { limit: 1.5 }],
  ])('refuses a %s limit', (_label, args) => {
    expect(() => parseWindow(args, 10, 50)).toThrow(/positive integer/u)
  })

  it('refuses a negative or fractional bound', () => {
    expect(() => parseWindow({ before: -1 }, 10, 50)).toThrow(/zero or more/u)
    expect(() => parseWindow({ before: 2.5 }, 10, 50)).toThrow(/zero or more/u)
  })
})

/**
 * The two things v0.1 got wrong. Both were invisible to its tests because both
 * are about what the model can see and do, not about what the code returns.
 */
describe('a preview must be a door, not a dead end', () => {
  const ref = { source: 'file', id: 'chat.json' }

  function windowed(from: number, count: number, total: number): ReferenceSnapshot {
    return {
      ref,
      label: 'Cache design',
      body: {
        kind: 'conversation',
        items: turns.slice(from, from + count),
        startIndex: from,
        totalTurns: total,
        hasOlder: from > 0,
      },
      partial: false,
      capturedAt: Date.UTC(2026, 7, 16),
    }
  }

  it('carries the reference uri, so the model can ask for the rest', () => {
    const rendered = renderReferences([{ snapshot: windowed(7, 3, 10) }], 65_536)
    expect(rendered.text).toContain(encodeReferenceUri(ref))
  })

  it('states in model-visible text that turns were left out', () => {
    const rendered = renderReferences([{ snapshot: windowed(7, 3, 10) }], 65_536)
    // Not merely recorded in the durable source for the UI — the model itself
    // must be able to tell that this is an excerpt.
    expect(rendered.text).toContain('"hasMore": true')
    expect(rendered.text).toContain('"order": "newest_first"')
    expect(rendered.text).toContain('"limit": 3')
  })

  it('says plainly when nothing was left out', () => {
    const rendered = renderReferences([{ snapshot: windowed(0, 10, 10) }], 65_536)
    expect(rendered.text).toContain('"hasMore": false')
  })

  it('turns the byte backstop into more available turns, not silent loss', () => {
    const long: ReferenceSnapshot = {
      ...windowed(0, 10, 10),
      body: {
        kind: 'conversation',
        items: Array.from({ length: 6 }, (_v, index) => ({
          role: 'user' as const,
          text: `turn ${index} ${'x'.repeat(400)}`,
        })),
        startIndex: 0,
        totalTurns: 6,
        hasOlder: false,
      },
    }
    const rendered = renderReferences([{ snapshot: long }], 1200)
    // The source said there was nothing older; the budget then dropped the
    // oldest of what it sent, so now there IS something older to fetch.
    expect(rendered.text).toContain('"hasMore": true')
    expect(rendered.provenance[0]?.hasOlder).toBe(true)
    expect(rendered.provenance[0]?.startIndex).toBeGreaterThan(0)
  })

  it('distinguishes upstream loss from a window the caller has not moved', () => {
    const rendered = renderReferences([{ snapshot: { ...windowed(0, 3, 3), partial: true } }], 65_536)
    // `partial` is "nobody here can reach the rest"; `olderTurnsAvailable` is
    // "you have not asked yet". Conflating them would misreport both.
    expect(rendered.text).toContain('"partial": true')
    expect(rendered.text).toContain('"hasMore": false')
    expect(rendered.provenance[0]).toMatchObject({ partial: true, hasOlder: false })
  })

  it('keeps an unreadable reference in the block with its uri and reason', () => {
    const rendered = renderReferences([{ ref, unavailable: 'browser is closed' }], 65_536)
    expect(rendered.text).toContain(encodeReferenceUri(ref))
    expect(rendered.text).toContain('browser is closed')
    expect(rendered.text).toContain('"preview": null')
    expect(rendered.provenance[0]).toMatchObject({ error: 'browser is closed', retainedMessages: 0 })
  })
})
