import type { LocalAgent } from '../wire.ts'
import type { AgentSyncStatus, ReferenceAnythingRemoteFace } from './remote.ts'

type AgentSyncRemote = Pick<ReferenceAnythingRemoteFace, 'agentSyncStart' | 'agentSyncStatus' | 'agentSyncCancel'>

/** Local history jobs have their own lifecycle and never probe browser health. */
export function createAgentSyncController(options: {
  remote(): AgentSyncRemote | undefined
  publish(status: AgentSyncStatus): void
  refresh(): Promise<void>
  missingJobError(): string
}) {
  let status: AgentSyncStatus | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let polling: symbol | undefined
  let disposed = false
  let generation = 0
  const publish = (next: AgentSyncStatus) => {
    status = next
    if (!disposed) options.publish(next)
  }
  const stop = () => { if (timer) clearInterval(timer); timer = undefined }
  const fail = (error: unknown) => {
    stop()
    if (status) publish({ ...status, status: 'failed', error: error instanceof Error ? error.message : String(error) })
  }
  const poll = async () => {
    const remote = options.remote()
    if (!remote || !status?.jobId || status.status !== 'running' || polling || disposed) return
    const jobId = status.jobId
    const activeGeneration = generation
    const request = Symbol()
    polling = request
    try {
      const result = unwrap(await remote.agentSyncStatus({ jobId }))
      if (disposed || generation !== activeGeneration || options.remote() !== remote || status?.jobId !== jobId) return
      if (!result) { fail(options.missingJobError()); return }
      publish(result)
      if (result.status !== 'running') {
        stop()
        await options.refresh()
      }
    } catch (error) {
      // A transport failure says nothing about whether the host is still
      // importing. Keep the job cancellable and retry on the next tick.
      if (!disposed && generation === activeGeneration && options.remote() === remote && status?.jobId === jobId && status.status === 'running') {
        publish({ ...status, error: error instanceof Error ? error.message : String(error) })
      }
    } finally { if (polling === request) polling = undefined }
  }
  return {
    resume() {
      disposed = false
      if (status?.status !== 'running') return
      if (!status.jobId) { fail(options.missingJobError()); return }
      stop()
      timer = setInterval(() => { void poll() }, 1_000)
      void poll()
    },
    async start(agents: LocalAgent[], mode: 'incremental' | 'full'): Promise<void> {
      const remote = options.remote()
      if (!remote || disposed || agents.length === 0 || status?.status === 'running') return
      const activeGeneration = generation
      publish({ jobId: '', status: 'running', agents: [...agents], completed: 0, total: 0, imported: 0, skipped: 0, failed: 0 })
      try {
        const jobId = unwrap(await remote.agentSyncStart({ agents, mode }))
        if (disposed || generation !== activeGeneration || options.remote() !== remote) return
        publish({ ...status!, jobId })
        stop()
        timer = setInterval(() => { void poll() }, 1_000)
        await poll()
      } catch (error) { if (!disposed && generation === activeGeneration && options.remote() === remote) fail(error) }
    },
    async cancel(): Promise<void> {
      const remote = options.remote()
      if (!remote || disposed || !status?.jobId || status.status !== 'running') return
      const activeGeneration = generation
      const jobId = status.jobId
      try {
        unwrap(await remote.agentSyncCancel({ jobId }))
        if (disposed || generation !== activeGeneration || options.remote() !== remote) return
        await poll()
      } catch (error) {
        // Keep polling: a cancellation transport error does not stop the job.
        if (!disposed && generation === activeGeneration && options.remote() === remote && status?.jobId === jobId && status.status === 'running') publish({ ...status, error: error instanceof Error ? error.message : String(error) })
      }
    },
    dispose() { disposed = true; generation++; polling = undefined; stop() },
  }
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
