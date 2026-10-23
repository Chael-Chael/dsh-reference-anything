import { afterEach, expect, it, vi } from 'vitest'
import { AgentScanCache } from '../src/agent-scan-cache.ts'
const snapshot = { sessions: [], warnings: [] }
it('clearing during an old scan does not let its late result replace a fresh scan', async () => {
  const cache = new AgentScanCache(), owner = {}, signal = new AbortController().signal
  let finish!: (value: typeof snapshot) => void
  const old = cache.read(owner, '', 'codex', () => new Promise(resolve => { finish = resolve }), signal)
  await Promise.resolve()
  cache.clear()
  const fresh = { sessions: [], warnings: [{ format: 'codex', target: 'new', error: 'new issue' }] }
  const scan = vi.fn(async () => fresh)
  const refreshed = cache.read(owner, '', 'codex', scan, signal)
  finish(snapshot)
  await old
  expect(await refreshed).toEqual(fresh)
  expect(await cache.read(owner, '', 'codex', scan, signal)).toEqual(fresh)
  expect(scan).toHaveBeenCalledOnce()
})
afterEach(() => vi.useRealTimers())
it('shares concurrent reads, caches briefly and refreshes after expiry', async () => {
  vi.useFakeTimers()
  const cache = new AgentScanCache(), owner = {}, signal = new AbortController().signal
  const scan = vi.fn(async () => snapshot)
  await Promise.all([cache.read(owner, 'p', 'claude', scan, signal), cache.read(owner, 'p', 'claude', scan, signal)])
  await cache.read(owner, 'p', 'claude', scan, signal)
  expect(scan).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(2001)
  await cache.read(owner, 'p', 'claude', scan, signal)
  expect(scan).toHaveBeenCalledTimes(2)
  await cache.read(owner, 'changed-settings', 'claude', scan, signal)
  await cache.read({}, 'changed-settings', 'claude', scan, signal)
  expect(scan).toHaveBeenCalledTimes(4)
})
it('cancels a waiter without poisoning the shared scan and retries failures', async () => {
  const cache = new AgentScanCache(), owner = {}, controller = new AbortController()
  let finish!: (value: typeof snapshot) => void
  const scan = vi.fn(() => new Promise<typeof snapshot>(resolve => { finish = resolve }))
  const first = cache.read(owner, 'p', 'claude', scan, controller.signal)
  const second = cache.read(owner, 'p', 'claude', scan, new AbortController().signal)
  await Promise.resolve()
  controller.abort(new Error('cancelled'))
  await expect(first).rejects.toThrow('cancelled')
  finish(snapshot)
  await expect(second).resolves.toEqual(snapshot)
  expect(scan).toHaveBeenCalledTimes(1)
  const fail = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot)
  await expect(cache.read(owner, 'p', 'codex', fail, new AbortController().signal)).rejects.toThrow('offline')
  await expect(cache.read(owner, 'p', 'codex', fail, new AbortController().signal)).resolves.toEqual(snapshot)
})
