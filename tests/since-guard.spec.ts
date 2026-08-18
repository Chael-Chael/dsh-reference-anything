import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JS adapter module, shipped to OpenCLI rather than compiled here.
import { createSinceGuard } from '../opencli-plugin/since-guard.js'

type Guard = (page: Array<{ updatedAt: string }>) => boolean
const page = (...stamps: string[]) => stamps.map(updatedAt => ({ updatedAt }))

describe('incremental listing guard', () => {
  it('stops once a whole page predates the cutoff', () => {
    const stop = createSinceGuard('2026-08-17T00:00:00.000Z') as Guard
    expect(stop(page('2026-08-18T00:00:00.000Z', '2026-08-17T12:00:00.000Z'))).toBe(false)
    expect(stop(page('2026-08-16T00:00:00.000Z', '2026-08-15T00:00:00.000Z'))).toBe(true)
  })

  it('never stops on a page that still straddles the cutoff', () => {
    const stop = createSinceGuard('2026-08-17T00:00:00.000Z') as Guard
    expect(stop(page('2026-08-16T00:00:00.000Z', '2026-08-18T00:00:00.000Z'))).toBe(false)
  })

  it('refuses to stop once the listing has proved it is not newest-first', () => {
    const stop = createSinceGuard('2026-08-17T00:00:00.000Z') as Guard
    // An older row followed by a newer one: this provider does not page in
    // update order, so no later page can be trusted to be the tail.
    expect(stop(page('2026-08-10T00:00:00.000Z', '2026-08-20T00:00:00.000Z'))).toBe(false)
    expect(stop(page('2026-08-01T00:00:00.000Z'))).toBe(false)
  })

  it('walks the whole history when timestamps are missing or no cutoff was given', () => {
    const unusable = createSinceGuard('2026-08-17T00:00:00.000Z') as Guard
    expect(unusable(page('', ''))).toBe(false)

    const disabled = createSinceGuard('') as Guard
    expect(disabled(page('2026-01-01T00:00:00.000Z'))).toBe(false)
  })

  it('does not stop on an empty page, which says nothing about ordering', () => {
    const stop = createSinceGuard('2026-08-17T00:00:00.000Z') as Guard
    expect(stop([])).toBe(false)
  })
})
