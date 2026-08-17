import { randomUUID } from 'node:crypto'
import type { ChatProvider } from '../store/spec.ts'
import type { ProviderConversationRow } from '../store/store.ts'
import { ConversationStore } from '../store/store.ts'
import { OpenCliError, OpenCliRunner } from '../opencli.ts'

export type SyncMode = 'incremental' | 'full'
export interface SyncJobStatus {
  jobId: string
  status: 'running' | 'complete' | 'cancelled' | 'failed'
  providers: readonly ChatProvider[]
  provider?: ChatProvider
  completed: number
  total: number
  error?: string
}

interface SyncJob extends SyncJobStatus { controller: AbortController }

export class ConversationSyncManager {
  private readonly jobs = new Map<string, SyncJob>()

  constructor(readonly store: ConversationStore, readonly runnerFactory: () => OpenCliRunner) {}

  start(providers: readonly ChatProvider[], mode: SyncMode): string {
    if (providers.length === 0) throw new Error('at least one provider is required')
    const jobId = randomUUID()
    const job: SyncJob = { jobId, status: 'running', providers: [...new Set(providers)], completed: 0, total: 0, controller: new AbortController() }
    this.jobs.set(jobId, job)
    void this.run(job, mode)
    return jobId
  }

  status(jobId: string): SyncJobStatus | undefined {
    const job = this.jobs.get(jobId)
    if (!job) return undefined
    const { controller: _controller, ...status } = job
    return { ...status }
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'running') return false
    job.controller.abort(new Error('sync cancelled'))
    job.status = 'cancelled'
    return true
  }

  private async run(job: SyncJob, mode: SyncMode): Promise<void> {
    try {
      for (const provider of job.providers) {
        if (job.controller.signal.aborted) break
        job.provider = provider
        await this.syncProvider(job, provider, mode)
      }
      if (job.status === 'running') job.status = 'complete'
      await this.store.collectExpired()
    } catch (error) {
      if (job.controller.signal.aborted) job.status = 'cancelled'
      else { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error) }
    }
  }

  private async syncProvider(job: SyncJob, provider: ChatProvider, mode: SyncMode): Promise<void> {
    const runner = this.runnerFactory()
    const signal = job.controller.signal
    let accountScope = ''
    try {
      accountScope = await runner.whoami(provider, signal)
      await this.store.syncStates.delete(`${provider}:pending`)
      const rows = await retry(() => runner.history(provider, signal), signal)
      const seen = new Set(rows.map(row => row.id))
      job.total += rows.length
      await this.saveSyncState(provider, accountScope, 'running', job)
      const queue = rows.slice()
      const concurrency = Math.max(1, Math.min(8, this.store.settings.detailConcurrency))
      let workerError: unknown
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (queue.length && !signal.aborted && workerError === undefined) {
          const row = queue.shift() as ProviderConversationRow
          try {
            const key = ConversationStore.conversationKey(provider, accountScope, row.id)
            const needsDetail = this.store.needsDetail(key, row, mode === 'full')
            await this.store.putConversation(row, accountScope)
            if (needsDetail) {
              const detail = await retry(() => runner.detail(provider, row.id, signal), signal)
              await this.store.commitRevision(key, detail)
            }
            job.completed++
            await this.saveSyncState(provider, accountScope, 'running', job, row.cursor)
          } catch (error) {
            workerError = error
          }
        }
      }))
      if (workerError !== undefined) throw workerError
      if (signal.aborted) throw signal.reason
      await this.store.markRemoteMissing(provider, accountScope, seen)
      await this.saveSyncState(provider, accountScope, 'idle', job, rows.at(-1)?.cursor || '', true)
    } catch (error) {
      const status = signal.aborted ? 'cancelled' : 'failed'
      await this.saveSyncState(provider, accountScope, status, job, '', false, describe(error))
      throw error
    }
  }

  private async saveSyncState(
    provider: ChatProvider, accountScope: string, status: 'running' | 'idle' | 'cancelled' | 'failed', job: SyncJob,
    cursor = '', complete = false, error = '',
  ): Promise<void> {
    const now = new Date().toISOString()
    const key = `${provider}:${accountScope || 'pending'}`
    const prior = this.store.syncStates.get(key)
    await this.store.syncStates.put(key, {
      provider, profile: this.store.settings.profile, accountScope, cursor,
      status, lastSyncAt: now, lastCompleteScanAt: complete ? now : prior?.lastCompleteScanAt || '',
      error, completed: job.completed, total: job.total,
    })
  }
}

async function retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let delay = 500
  for (let attempt = 0; ; attempt++) {
    try { return await operation() } catch (error) {
      if (signal.aborted || attempt >= 4 || !isRetryable(error)) throw error
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
      delay = Math.min(delay * 2, 8_000)
    }
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof OpenCliError && (error.code === 'OPENCLI_FAILED' || error.code === 'PROVIDER_TIMEOUT')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { OpenCliRunner } from '../opencli.ts'
export type { ChatProvider } from '../store/spec.ts'
