import { randomUUID } from 'node:crypto'
import { ReferenceAnythingError } from '../../errors.ts'
import type { TranscriptDescriptor } from './scan.ts'
import type { AgentKind } from './types.ts'

export interface AgentSyncStatus {
  jobId: string
  status: 'running' | 'complete' | 'partial' | 'cancelled' | 'failed'
  agents: AgentKind[]
  completed: number
  total: number
  imported: number
  skipped: number
  failed: number
  error?: string
}

export interface AgentSyncOperations {
  enabled(): ReadonlySet<AgentKind>
  scan(agents: readonly AgentKind[], signal: AbortSignal): Promise<{ entries: readonly TranscriptDescriptor[]; partial: boolean; error?: string }>
  import(entry: TranscriptDescriptor, full: boolean, signal: AbortSignal): Promise<{ imported: boolean; partial: boolean }>
}

interface Job { status: AgentSyncStatus; controller: AbortController; done: Promise<void> }
const MAX_JOBS = 20

/** Serial jobs keep incremental fingerprints and atomic row replacements from racing. */
export class AgentHistorySyncManager {
  private readonly jobs = new Map<string, Job>()

  constructor(private readonly operations: AgentSyncOperations) {}

  start(agents: AgentKind[], mode: 'incremental' | 'full'): string {
    if (this.isRunning()) throw new ReferenceAnythingError('a local agent history sync is already running', 'REFERENCE_SYNC_IN_PROGRESS')
    const enabled = this.operations.enabled()
    const selected = [...new Set(agents)].filter(agent => enabled.has(agent))
    const jobId = randomUUID()
    const job: Job = {
      status: { jobId, status: 'running', agents: selected, completed: 0, total: 0, imported: 0, skipped: 0, failed: 0 },
      controller: new AbortController(), done: Promise.resolve(),
    }
    this.jobs.set(jobId, job)
    while (this.jobs.size > MAX_JOBS) {
      const oldest = this.jobs.keys().next().value
      if (oldest === undefined) break
      this.jobs.delete(oldest)
    }
    job.done = this.run(job, mode)
    return jobId
  }

  status(jobId: string): AgentSyncStatus | undefined {
    const status = this.jobs.get(jobId)?.status
    return status === undefined ? undefined : { ...status, agents: [...status.agents] }
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (job === undefined || job.status.status !== 'running') return false
    job.controller.abort(new Error('local agent history sync cancelled'))
    return true
  }

  isRunning(): boolean { return [...this.jobs.values()].some(job => job.status.status === 'running') }

  async dispose(): Promise<void> {
    const jobs = [...this.jobs.values()]
    for (const job of jobs) if (job.status.status === 'running') job.controller.abort(new Error('local agent history service stopped'))
    await Promise.all(jobs.map(job => job.done))
  }

  private async run(job: Job, mode: 'incremental' | 'full'): Promise<void> {
    const status = job.status
    const signal = job.controller.signal
    const failures: string[] = []
    let partial = false
    try {
      const scan = await this.operations.scan(status.agents, signal)
      partial = scan.partial
      if (scan.error) failures.push(scan.error)
      status.total = scan.entries.length
      for (const entry of scan.entries) {
        signal.throwIfAborted()
        // Settings may change while a long import is running.
        if (!this.operations.enabled().has(entry.kind)) { status.skipped++; status.completed++; continue }
        try {
          const result = await this.operations.import(entry, mode === 'full', signal)
          if (result.imported) status.imported++
          else status.skipped++
          partial ||= result.partial
        } catch (error) {
          if (signal.aborted) throw error
          status.failed++
          if (failures.length < 3) failures.push(`${entry.kind}:${entry.relPath}: ${error instanceof Error ? error.message : String(error)}`)
        }
        status.completed++
      }
      signal.throwIfAborted()
      status.status = status.failed === 0 ? partial ? 'partial' : 'complete'
        : status.imported + status.skipped > 0 ? 'partial' : 'failed'
      if (partial && failures.length === 0) failures.push('Some history could only be imported partially because the source or import budget is incomplete.')
      if (failures.length > 0) status.error = failures.join('; ')
    } catch (error) {
      status.status = signal.aborted ? 'cancelled' : 'failed'
      if (!signal.aborted) status.error = error instanceof Error ? error.message : String(error)
    }
  }
}
