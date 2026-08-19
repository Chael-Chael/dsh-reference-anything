import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAutoDismissNotice, NOTICE_DURATION_MS } from '../src/client/notice.ts'

afterEach(() => { vi.useRealTimers() })

describe('transient settings notices', () => {
  it('automatically disappears after five seconds while retaining other state', () => {
    vi.useFakeTimers()
    let state: { notice?: string; value: number } = { value: 1 }
    const notices = createAutoDismissNotice(() => state, value => { state = value })

    notices.show('Update available', { value: 2 })
    expect(state).toEqual({ notice: 'Update available', value: 2 })
    vi.advanceTimersByTime(NOTICE_DURATION_MS - 1)
    expect(state.notice).toBe('Update available')
    vi.advanceTimersByTime(1)
    expect(state).toEqual({ notice: undefined, value: 2 })
  })

  it('restarts the timeout when another notice replaces it', () => {
    vi.useFakeTimers()
    let state: { notice?: string } = {}
    const notices = createAutoDismissNotice(() => state, value => { state = value })

    notices.show('First')
    vi.advanceTimersByTime(NOTICE_DURATION_MS - 1)
    notices.show('Second')
    vi.advanceTimersByTime(1)
    expect(state.notice).toBe('Second')
    vi.advanceTimersByTime(NOTICE_DURATION_MS - 1)
    expect(state.notice).toBeUndefined()
  })

  it('does not clear a newer notice published by another owner', () => {
    vi.useFakeTimers()
    let state: { notice?: string } = {}
    const notices = createAutoDismissNotice(() => state, value => { state = value })

    notices.show('Owned')
    state = { notice: 'External' }
    vi.advanceTimersByTime(NOTICE_DURATION_MS)
    expect(state.notice).toBe('External')
  })
})
