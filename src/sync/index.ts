import { randomUUID } from 'node:crypto'
import type { ChatProvider, SyncStateRecord } from '../store/spec.ts'
import type { ProviderConversationRow } from '../store/store.ts'
import { ConversationStore } from '../store/store.ts'
import { OpenCliError, OpenCliRunner } from '../opencli.ts'

export type SyncMode = 'incremental' | 'full'
export interface SyncJobStatus {
  jobId: string
  /** `partial` means at least one provider succeeded and at least one did not. */
  status: 'running' | 'complete' | 'partial' | 'cancelled' | 'failed'
  providers: readonly ChatProvider[]
  provider?: ChatProvider
  completed: number
  total: number
  error?: string
}

/** Knobs the background scheduler needs and the RPC surface deliberately does not expose. */
export interface SyncStartOptions {
  /**
   * Abort the job once it has run this long. Auto-sync sets one because its
   * own gate is {@link ConversationSyncManager.isRunning} — a job that hangs
   * forever would otherwise silently stop every later tick.
   */
  deadlineMs?: number
  /**
   * Let each provider list only what changed since its last pass, when the
   * installed adapter supports it. Trades tombstoning for speed, so a full
   * enumeration is forced back on every {@link FULL_SCAN_INTERVAL_MS}.
   */
  incrementalListing?: boolean
}

/** The slice of cordis's logger this manager uses, kept structural so tests need no context. */
export interface SyncLogger {
  info(message: string): void
  warn(message: string): void
}

interface SyncJob extends SyncJobStatus {
  controller: AbortController
  /**
   * True from `start()` until `run()` has fully unwound. Distinct from
   * `status`, which flips to `cancelled` the moment a cancel is requested —
   * workers and their queued store writes are still draining at that point,
   * and the delete guard must keep refusing until they are done.
   */
  active: boolean
  completedAt?: number
}

/** How long a finished job stays visible to {@link ConversationSyncManager.status} before it is swept. */
const PRUNE_JOB_AFTER_MS = 10 * 60_000
/**
 * Minimum gap between durable progress writes. Under the JSON storage backend
 * every record write re-serializes and fsyncs the whole domain, so writing
 * once per conversation made progress reporting cost more than the sync.
 */
const PROGRESS_WRITE_INTERVAL_MS = 2_000
/** Least often revision GC runs; it walks every revision, and nothing expires in minutes. */
const COLLECT_INTERVAL_MS = 6 * 60 * 60_000
/** How stale a complete enumeration may get before incremental listing is refused. */
export const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60_000
/** Slack subtracted from the incremental listing watermark, covering clock skew and in-flight edits. */
const LISTING_OVERLAP_MS = 10 * 60_000
/** First backoff step after a provider-level failure; doubles per consecutive failure. */
const BACKOFF_BASE_MS = 30 * 60_000
const BACKOFF_MAX_MS = 24 * 60 * 60_000
/** Conversation-level failures tolerated before the provider itself is called failed. */
const MIN_TOLERATED_FAILURES = 10
const FAILURE_TOLERANCE_RATIO = 0.25

export class ConversationSyncManager {
  private readonly jobs = new Map<string, SyncJob>()
  private lastCollectAt = 0

  constructor(
    readonly store: ConversationStore,
    readonly runnerFactory: () => OpenCliRunner,
    private readonly logger?: SyncLogger,
  ) {}

  start(providers: readonly ChatProvider[], mode: SyncMode, options: SyncStartOptions = {}): string {
    if (providers.length === 0) throw new Error('at least one provider is required')
    this.pruneFinishedJobs()
    const jobId = randomUUID()
    const job: SyncJob = {
      jobId, status: 'running', providers: [...new Set(providers)],
      completed: 0, total: 0, active: true, controller: new AbortController(),
    }
    this.jobs.set(jobId, job)
    void this.run(job, mode, options)
    return jobId
  }

  status(jobId: string): SyncJobStatus | undefined {
    const job = this.jobs.get(jobId)
    if (!job) return undefined
    const { controller: _controller, completedAt: _completedAt, active: _active, ...status } = job
    return { ...status }
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || !job.active) return false
    job.controller.abort(new Error('sync cancelled'))
    return true
  }

  /**
   * Whether any job — manual or auto-sync-triggered — is still touching the
   * store. Stays true after a cancel until the workers have actually stopped,
   * so a delete cannot interleave with a revision commit that is still landing.
   */
  isRunning(): boolean {
    for (const job of this.jobs.values()) if (job.active) return true
    return false
  }

  /**
   * Providers auto-sync should attempt right now: ones that have completed a
   * scan under some account, minus any still inside a failure backoff window.
   * @returns the eligible providers, or an empty list when none are.
   */
  eligibleProviders(candidates: readonly ChatProvider[], now = Date.now()): ChatProvider[] {
    const proven = new Set<ChatProvider>()
    const blocked = new Map<ChatProvider, number>()
    for (const [, row] of this.store.syncStates.entries()) {
      if (row.lastCompleteScanAt) proven.add(row.provider)
      const until = Date.parse(row.nextEligibleAt || '')
      if (!Number.isNaN(until) && until > now) {
        blocked.set(row.provider, Math.max(blocked.get(row.provider) ?? 0, until))
      }
    }
    // Nothing has ever completed a scan: this is a first run (or a fresh
    // profile), and refusing every provider would mean auto-sync never
    // discovers which ones are usable.
    const pool = proven.size === 0 ? candidates : candidates.filter(provider => proven.has(provider))
    return pool.filter(provider => !blocked.has(provider))
  }

  private pruneFinishedJobs(): void {
    const cutoff = Date.now() - PRUNE_JOB_AFTER_MS
    for (const [jobId, job] of this.jobs) {
      if (job.completedAt !== undefined && job.completedAt < cutoff) this.jobs.delete(jobId)
    }
  }

  private async run(job: SyncJob, mode: SyncMode, options: SyncStartOptions): Promise<void> {
    const watchdog = options.deadlineMs === undefined ? undefined : setTimeout(() => {
      this.logger?.warn(`reference sync: job ${job.jobId} exceeded ${String(options.deadlineMs)}ms; aborting`)
      job.controller.abort(new Error('sync exceeded its deadline'))
    }, options.deadlineMs)
    const failures = new Map<ChatProvider, string>()
    let succeeded = 0
    try {
      for (const provider of job.providers) {
        if (job.controller.signal.aborted) break
        job.provider = provider
        const started = Date.now()
        try {
          await this.syncProvider(job, provider, mode, options)
          succeeded++
          this.logger?.info(`reference sync: ${provider} finished in ${String(Date.now() - started)}ms`)
        } catch (error) {
          // One provider must not decide the fate of the others: a single
          // logged-out account would otherwise permanently starve every
          // provider after it in this list.
          if (job.controller.signal.aborted) break
          failures.set(provider, describe(error))
          this.logger?.warn(`reference sync: ${provider} failed: ${describe(error)}`)
        }
      }
      job.status = job.controller.signal.aborted ? 'cancelled'
        : failures.size === 0 ? 'complete'
          : succeeded === 0 ? 'failed' : 'partial'
      if (failures.size > 0) {
        job.error = [...failures].map(([provider, message]) => `${provider}: ${message}`).join('; ')
      }
      if (job.status === 'complete') await this.collect()
    } catch (error) {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
      job.error = describe(error)
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog)
      job.active = false
      job.completedAt = Date.now()
    }
  }

  /** Revision GC, rate-limited: it walks every revision and nothing expires in minutes. */
  private async collect(): Promise<void> {
    const now = Date.now()
    if (now - this.lastCollectAt < COLLECT_INTERVAL_MS) return
    this.lastCollectAt = now
    try {
      await this.store.collectExpired(now)
    } catch (error) {
      // The mirror is already correct; failing to reclaim an expired revision
      // is not a reason to report a completed sync as failed.
      this.logger?.warn(`reference sync: revision cleanup failed: ${describe(error)}`)
    }
  }

  private async syncProvider(
    job: SyncJob, provider: ChatProvider, mode: SyncMode, options: SyncStartOptions,
  ): Promise<void> {
    const runner = this.runnerFactory()
    const signal = job.controller.signal
    let accountScope = ''
    let progress: ProgressWriter | undefined
    try {
      accountScope = await retry(() => runner.whoami(provider, signal), signal)
      await this.store.syncStates.delete(`${provider}:pending`)
      const since = options.incrementalListing === true ? this.listingSince(provider, accountScope) : ''
      const rows = await retry(() => runner.history(provider, signal, since), signal)
      const seen = new Set(rows.map(row => row.id))
      job.total += rows.length
      progress = this.progressWriter(provider, accountScope, job, rows.length)
      await progress.save('running')

      const tolerated = Math.max(MIN_TOLERATED_FAILURES, Math.floor(rows.length * FAILURE_TOLERANCE_RATIO))
      const failures: string[] = []
      let fatal: unknown
      let next = 0
      const concurrency = Math.max(1, Math.min(8, this.store.settings.detailConcurrency))
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < rows.length && !signal.aborted && fatal === undefined) {
          const row = rows[next++] as ProviderConversationRow
          try {
            await this.syncConversation(runner, provider, accountScope, row, mode === 'full', signal)
            progress?.advance()
            await progress?.tick()
          } catch (error) {
            if (signal.aborted) return
            // A broken account or adapter is not going to fix itself on the
            // next row, so it stops the provider outright. One conversation
            // the provider cannot render is just one conversation.
            if (isFatal(error)) { fatal = error; return }
            failures.push(`${row.id}: ${describe(error)}`)
            if (failures.length > tolerated) {
              fatal = new Error(`${String(failures.length)} conversations failed; ${summarize(failures)}`)
              return
            }
          }
        }
      }))
      if (fatal !== undefined) throw fatal
      if (signal.aborted) throw signal.reason

      // Retiring rows the provider no longer lists needs the complete set of
      // its ids. An incremental listing does not have one, and neither does a
      // pass that could not read every conversation.
      const enumerated = since === '' && failures.length === 0
      if (enumerated) await this.store.markRemoteMissing(provider, accountScope, seen)
      await progress.save('idle', {
        cursor: rows.at(-1)?.cursor ?? '',
        complete: enumerated,
        ...(failures.length > 0 ? { error: `${String(failures.length)} conversations failed; ${summarize(failures)}` } : {}),
      })
    } catch (error) {
      const cancelled = signal.aborted
      await this.saveSyncState(
        provider, accountScope, cancelled ? 'cancelled' : 'failed',
        { completed: progress?.completed ?? 0, total: progress?.total ?? 0 },
        { error: describe(error), ...(cancelled ? {} : { failure: true }) },
      )
      throw error
    }
  }

  /**
   * Mirror one conversation.
   *
   * The provider's `updatedAt` is the only pre-fetch change signal there is
   * ({@link ConversationStore.needsDetail}), so it may only be persisted once
   * the transcript it describes has actually landed. Writing it first — as
   * this used to — left a conversation whose detail fetch failed looking
   * up-to-date forever, pinned to a stale revision until someone ran a full
   * rescan by hand.
   */
  private async syncConversation(
    runner: OpenCliRunner, provider: ChatProvider, accountScope: string,
    row: ProviderConversationRow, full: boolean, signal: AbortSignal,
  ): Promise<void> {
    const key = ConversationStore.conversationKey(provider, accountScope, row.id)
    const known = this.store.conversations.get(key)
    if (!this.store.needsDetail(key, row, full)) {
      // Metadata refresh only, and `putConversation` skips the write entirely
      // when nothing actually differs.
      await this.store.putConversation(row, accountScope)
      return
    }
    // A conversation with no row yet has no watermark to corrupt, and
    // `commitRevision` needs the row to exist.
    if (!known) await this.store.putConversation(row, accountScope)
    const detail = await retry(() => runner.detail(provider, row.id, signal), signal)
    await this.store.commitRevision(key, detail, row)
  }

  /**
   * Watermark for an incremental listing, or `''` to demand a full one.
   * @returns an ISO instant the adapter may page back to, exclusive of slack.
   */
  private listingSince(provider: ChatProvider, accountScope: string): string {
    const state = this.store.syncStates.get(`${provider}:${accountScope}`)
    const lastComplete = Date.parse(state?.lastCompleteScanAt ?? '')
    const lastSync = Date.parse(state?.lastSyncAt ?? '')
    if (Number.isNaN(lastComplete) || Number.isNaN(lastSync)) return ''
    if (Date.now() - lastComplete >= FULL_SCAN_INTERVAL_MS) return ''
    return new Date(lastSync - LISTING_OVERLAP_MS).toISOString()
  }

  private progressWriter(
    provider: ChatProvider, accountScope: string, job: SyncJob, total: number,
  ): ProgressWriter {
    let completed = 0
    let lastWriteAt = 0
    const save = async (status: SyncStateRecord['status'], patch: SyncStatePatch = {}): Promise<void> => {
      // Stamped before the await so two workers cannot both pass `tick`'s gate.
      lastWriteAt = Date.now()
      await this.saveSyncState(provider, accountScope, status, { completed, total }, patch)
    }
    return {
      get completed() { return completed },
      get total() { return total },
      advance(): void { completed++; job.completed++ },
      save,
      async tick(): Promise<void> {
        if (Date.now() - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS) return
        await save('running')
      },
    }
  }

  private async saveSyncState(
    provider: ChatProvider, accountScope: string, status: SyncStateRecord['status'],
    counts: { completed: number; total: number }, patch: SyncStatePatch = {},
  ): Promise<void> {
    const now = Date.now()
    const stamp = new Date(now).toISOString()
    const key = `${provider}:${accountScope || 'pending'}`
    const prior = this.store.syncStates.get(key)
    const consecutiveFailures = patch.failure === true ? (prior?.consecutiveFailures ?? 0) + 1
      : status === 'idle' ? 0 : prior?.consecutiveFailures ?? 0
    await this.store.syncStates.put(key, {
      provider, profile: this.store.settings.profile, accountScope,
      // `put` replaces the whole record, so a failed attempt would otherwise
      // erase the watermark a successful one left behind.
      cursor: patch.cursor ?? prior?.cursor ?? '',
      status, lastSyncAt: stamp,
      lastCompleteScanAt: patch.complete === true ? stamp : prior?.lastCompleteScanAt || '',
      error: patch.error ?? '',
      completed: counts.completed, total: counts.total,
      consecutiveFailures,
      nextEligibleAt: patch.failure === true
        ? new Date(now + backoffMs(consecutiveFailures)).toISOString()
        : '',
    })
  }
}

interface ProgressWriter {
  readonly completed: number
  readonly total: number
  advance(): void
  save(status: SyncStateRecord['status'], patch?: SyncStatePatch): Promise<void>
  tick(): Promise<void>
}

interface SyncStatePatch {
  cursor?: string
  complete?: boolean
  error?: string
  /** Count this attempt as a provider-level failure and extend its backoff. */
  failure?: boolean
}

/** Backoff after `n` consecutive provider failures: 30m, 1h, 2h… capped at a day. */
export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1))
}

async function retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let delay = 500
  for (let attempt = 0; ; attempt++) {
    try { return await operation() } catch (error) {
      if (signal.aborted || attempt >= 4 || !isRetryable(error)) throw error
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const onAbort = (): void => { clearTimeout(timer); reject(signal.reason) }
        // Removed on the normal path too: one long job shares a single signal
        // across every provider and worker, so listeners left behind by
        // resolved sleeps accumulate for its whole lifetime.
        timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, delay)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      delay = Math.min(delay * 2, 8_000)
    }
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof OpenCliError && (error.code === 'OPENCLI_FAILED' || error.code === 'PROVIDER_TIMEOUT')
}

/** Failures that describe the provider or its adapter, not one conversation. */
function isFatal(error: unknown): boolean {
  return error instanceof OpenCliError && (error.code === 'OPENCLI_CONFIGURATION'
    || error.code === 'PROVIDER_NOT_LOGGED_IN' || error.code === 'EXTENSION_NOT_CONNECTED')
}

function summarize(failures: readonly string[]): string {
  const head = failures.slice(0, 3).join('; ')
  return failures.length > 3 ? `${head}; …` : head
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { OpenCliRunner } from '../opencli.ts'
export type { ChatProvider } from '../store/spec.ts'
