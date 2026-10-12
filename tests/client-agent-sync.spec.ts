import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentSyncController } from '../src/client/agent-sync.ts'
import type { AgentSyncStatus } from '../src/client/remote.ts'

function status(overrides: Partial<AgentSyncStatus> = {}): AgentSyncStatus {
  return { jobId: 'local-job', status: 'running', agents: ['codex'], completed: 1, total: 3, imported: 1, skipped: 0, failed: 0, ...overrides }
}

function setup() {
  vi.useFakeTimers()
  let current: AgentSyncStatus | undefined = status()
  const remote = {
    agentSyncStart: vi.fn(async () => ({ ok: true as const, value: 'local-job' })),
    agentSyncStatus: vi.fn(async () => ({ ok: true as const, value: current })),
    agentSyncCancel: vi.fn(async () => { current = status({ status: 'cancelled' }); return { ok: true as const, value: true } }),
  }
  const published: AgentSyncStatus[] = []
  const refresh = vi.fn(async () => {})
  const controller = createAgentSyncController({ remote: () => remote, publish: value => { published.push(value) }, refresh, missingJobError: () => 'Job missing; retry.' })
  return { remote, published, refresh, controller, setStatus: (value: AgentSyncStatus | undefined) => { current = value } }
}

afterEach(() => { vi.useRealTimers() })

describe('local agent sync lifecycle', () => {
  it('syncs only selected agents and refreshes the local views once after completion', async () => {
    const { remote, published, refresh, controller, setStatus } = setup()
    await controller.start(['codex', 'claude-code'], 'incremental')
    expect(remote.agentSyncStart).toHaveBeenCalledWith({ agents: ['codex', 'claude-code'], mode: 'incremental' })
    expect(published[0]).toMatchObject({ status: 'running', jobId: '', agents: ['codex', 'claude-code'] })
    expect(published.at(-1)).toEqual(status())
    expect(refresh).not.toHaveBeenCalled()

    setStatus(status({ status: 'complete', completed: 3, imported: 2, skipped: 1 }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(published.at(-1)).toMatchObject({ status: 'complete', imported: 2, skipped: 1 })
    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(remote.agentSyncStatus).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    controller.dispose()
  })

  it('prevents overlapping starts and starts no job for an empty selection', async () => {
    const { remote, controller } = setup()
    await controller.start([], 'incremental')
    expect(remote.agentSyncStart).not.toHaveBeenCalled()
    await controller.start(['codex'], 'full')
    await controller.start(['claude-code'], 'incremental')
    expect(remote.agentSyncStart).toHaveBeenCalledExactlyOnceWith({ agents: ['codex'], mode: 'full' })
    controller.dispose()
  })

  it('cancels only the local job, retains its counts, and refreshes the imported results', async () => {
    const { remote, published, refresh, controller } = setup()
    await controller.start(['codex'], 'incremental')
    await controller.cancel()
    expect(remote.agentSyncCancel).toHaveBeenCalledExactlyOnceWith({ jobId: 'local-job' })
    expect(published.at(-1)).toMatchObject({ status: 'cancelled', completed: 1, imported: 1 })
    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    controller.dispose()
  })

  it('shows partial failure details and refreshes successfully imported history', async () => {
    const { controller, published, refresh, setStatus } = setup()
    setStatus(status({ status: 'partial', completed: 3, failed: 1, error: 'Cannot parse one transcript' }))
    await controller.start(['codex'], 'full')
    expect(published.at(-1)).toMatchObject({ status: 'partial', failed: 1, error: 'Cannot parse one transcript' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    controller.dispose()
  })

  it('surfaces a missing job and allows a new sync instead of leaving controls disabled', async () => {
    const { controller, published, remote, setStatus } = setup()
    setStatus(undefined)
    await controller.start(['codex'], 'incremental')
    expect(published.at(-1)).toMatchObject({ status: 'failed', error: 'Job missing; retry.' })
    expect(vi.getTimerCount()).toBe(0)
    setStatus(status())
    await controller.start(['codex'], 'incremental')
    expect(remote.agentSyncStart).toHaveBeenCalledTimes(2)
    expect(published.at(-1)?.status).toBe('running')
    controller.dispose()
  })

  it('reports a rejected start and allows retry', async () => {
    const { controller, published, remote } = setup()
    remote.agentSyncStart.mockRejectedValueOnce(new Error('Host disconnected'))
    await controller.start(['codex'], 'incremental')
    expect(published.at(-1)).toMatchObject({ status: 'failed', error: 'Host disconnected' })
    expect(vi.getTimerCount()).toBe(0)
    await controller.start(['codex'], 'incremental')
    expect(published.at(-1)?.status).toBe('running')
    controller.dispose()
  })

  it('keeps a job running and cancellable through transient polling errors', async () => {
    const { controller, published, remote, setStatus, refresh } = setup()
    remote.agentSyncStatus.mockRejectedValueOnce(new Error('Read failed'))
    await controller.start(['codex'], 'incremental')
    expect(published.at(-1)).toMatchObject({ status: 'running', error: 'Read failed' })
    expect(vi.getTimerCount()).toBe(1)
    setStatus(status({ status: 'complete', completed: 3, imported: 3 }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(published.at(-1)).toMatchObject({ status: 'complete' })
    expect(published.at(-1)?.error).toBeUndefined()
    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    controller.dispose()
  })

  it('keeps polling after cancellation fails, then publishes the eventual result', async () => {
    const { controller, published, remote, setStatus, refresh } = setup()
    await controller.start(['codex'], 'incremental')
    remote.agentSyncCancel.mockRejectedValueOnce(new Error('Cancel failed'))
    await controller.cancel()
    expect(published.at(-1)).toMatchObject({ status: 'running', error: 'Cancel failed' })
    setStatus(status({ status: 'complete', completed: 3, imported: 3 }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(published.at(-1)).toMatchObject({ status: 'complete' })
    expect(refresh).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('ignores a pending result and clears timers after the client unmounts', async () => {
    const { controller, published, remote, refresh } = setup()
    let finish!: (value: { ok: true; value: AgentSyncStatus }) => void
    remote.agentSyncStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const starting = controller.start(['codex'], 'incremental')
    await Promise.resolve()
    expect(remote.agentSyncStatus).toHaveBeenCalledOnce()
    const before = published.length
    controller.dispose()
    finish({ ok: true, value: status({ status: 'complete' }) })
    await starting
    expect(published).toHaveLength(before)
    expect(refresh).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resumes the existing job when the remote effect remounts', async () => {
    const { controller, published, remote, setStatus, refresh } = setup()
    await controller.start(['codex'], 'incremental')
    controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
    controller.resume()
    await Promise.resolve()
    expect(remote.agentSyncStart).toHaveBeenCalledOnce()
    setStatus(status({ status: 'complete', completed: 3 }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(published.at(-1)?.status).toBe('complete')
    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    controller.dispose()
  })

  it('ignores results from the previous mount even when the remote object is reused', async () => {
    const { controller, published, remote, refresh } = setup()
    let finish!: (value: { ok: true; value: AgentSyncStatus }) => void
    remote.agentSyncStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const starting = controller.start(['codex'], 'incremental')
    await Promise.resolve()
    controller.dispose()
    controller.resume()
    await Promise.resolve()
    expect(remote.agentSyncStatus).toHaveBeenCalledTimes(2)
    finish({ ok: true, value: status({ status: 'complete' }) })
    await starting
    expect(published.at(-1)?.status).toBe('running')
    expect(refresh).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    controller.dispose()
  })
})
