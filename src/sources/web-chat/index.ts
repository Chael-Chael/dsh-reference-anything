import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ReferenceSnapshot, ReferenceSource, ReferenceSummary, ReferenceWindow } from '../../types.ts'
import type { ChatProvider, SettingsRecord } from '../../store/spec.ts'
import { providerSchema, referenceAnythingDomainSpec, settingsRecordSchema } from '../../store/spec.ts'
import { ConversationStore, type MatchedVia } from '../../store/store.ts'
import { ConversationSyncManager } from '../../sync/index.ts'
import { OpenCliRunner } from '../../opencli.ts'
import { ReferenceAnythingError } from '../../errors.ts'
import { parseProviderQuery } from '../../search.ts'
import type {} from '../../index.ts'

export { parseProviderQuery }

export const name = 'reference-web-chat'
export const inject = ['references', 'storageDomain']

/** Window a catch-up pass waits in after arming, so it misses the startup rush. */
const CATCH_UP_MIN_MS = 30_000
const CATCH_UP_MAX_MS = 90_000

export interface Config {
  timeoutMs?: number
  maxStdoutBytes?: number
}
export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1_000).default(60_000),
  maxStdoutBytes: z.number().step(1).min(65_536).default(32 * 1024 * 1024),
})

declare module '@deepseek-ai/cordis' {
  interface Context { referenceChatHistory: WebChatHistoryService }
}

/** The stored facts about one mirrored conversation, shared by both list surfaces. */
export interface ConversationRow {
  uriId: string
  provider: ChatProvider
  title: string
  url: string
  updatedAt: string
  turnCount: number
  partial: boolean
  syncedAt: string
}

/** One ranked hit from the mention/search surface. */
export interface ConversationSearchResult extends ConversationRow {
  /** How this row was found, so the mention menu can say why it matched. */
  matchedVia: MatchedVia
  /** Excerpt around a body hit. UI-only — never part of what the model reads. */
  snippet?: string
}

/** One row in the management list — unranked, but carrying whether the provider still lists it. */
export interface ManagedConversation extends ConversationRow {
  remoteMissing: boolean
}

export type { ProviderSyncState } from '../../store/store.ts'

export default class WebChatHistoryService extends Service implements ReferenceSource {
  static inject = inject
  static Config = Config
  readonly id = 'web-chat'
  private storeValue?: ConversationStore
  private syncValue?: ConversationSyncManager
  private autoSyncInterval?: ReturnType<typeof setInterval>
  private autoSyncCatchUp?: ReturnType<typeof setTimeout>

  constructor(ctx: Context, private readonly config: Config = {}) { super(ctx, 'referenceChatHistory') }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(referenceAnythingDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'reference-web-chat.domainClose')
    this.storeValue = new ConversationStore(domain)
    this.syncValue = new ConversationSyncManager(this.storeValue, () => new OpenCliRunner({
      executable: this.store.settings.opencliPath, profile: this.store.settings.profile,
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes,
    }), this.ctx.logger)
    this.ctx.references.registerSource(this)
    this.ctx.effect(() => () => { this.clearAutoSync() }, 'reference-web-chat.autoSyncCleanup')
    this.armAutoSync()
  }

  get store(): ConversationStore {
    if (!this.storeValue) throw new Error('Web chat history service is not initialized')
    return this.storeValue
  }
  get sync(): ConversationSyncManager {
    if (!this.syncValue) throw new Error('Web chat history service is not initialized')
    return this.syncValue
  }

  async available(): Promise<boolean> { return this.storeValue !== undefined }

  async list(query: string, limit: number): Promise<ReferenceSummary[]> {
    const parsed = parseProviderQuery(query)
    // No excerpt here: this surface feeds the model, and mirrored conversation
    // text may only reach it inside `reference_read`'s untrusted-data envelope.
    return this.store.list(parsed.query, parsed.provider, limit).map(({ key, row }) => ({
      ref: { source: this.id, id: key }, label: row.title, origin: row.url,
      updatedAt: timestamp(row.updatedAt), provider: row.provider,
      messageCount: row.messageCount, partial: row.partial, syncedAt: timestamp(row.syncedAt),
    }))
  }

  async read(ref: { source: string; id: string }, window: ReferenceWindow): Promise<ReferenceSnapshot> {
    if (ref.source !== this.id) throw new Error(`web-chat cannot read source ${ref.source}`)
    return this.store.read(ref.id, window)
  }

  search(query: string, provider: ChatProvider | undefined, limit: number): ConversationSearchResult[] {
    const parsed = parseProviderQuery(query)
    return this.store
      .list(parsed.query, provider ?? parsed.provider, Math.max(1, Math.min(100, limit)))
      .map(({ key, row, via, snippet }) => ({
        uriId: key, provider: row.provider, title: row.title, url: row.url, updatedAt: row.updatedAt,
        turnCount: row.messageCount, partial: row.partial, syncedAt: row.syncedAt,
        matchedVia: via, ...(snippet ? { snippet } : {}),
      }))
  }

  /** Paginated browse for the management list — unlike {@link search}, includes `remoteMissing` rows. */
  browse(
    query: string, provider: ChatProvider | undefined, limit: number, offset: number,
  ): { items: ManagedConversation[]; total: number } {
    const { items, total } = this.store.page(query, provider, Math.max(1, Math.min(100, limit)), Math.max(0, offset))
    return {
      total,
      items: items.map(([uriId, row]): ManagedConversation => ({
        uriId, provider: row.provider, title: row.title, url: row.url, updatedAt: row.updatedAt,
        turnCount: row.messageCount, partial: row.partial, syncedAt: row.syncedAt, remoteMissing: row.remoteMissing,
      })),
    }
  }

  /** Permanently delete a synced conversation; refused while a sync could resurrect it mid-delete. */
  async remove(uriId: string): Promise<boolean> {
    if (this.sync.isRunning()) {
      throw new ReferenceAnythingError('cannot delete a conversation while a sync is in progress', 'REFERENCE_SYNC_IN_PROGRESS')
    }
    return this.store.remove(uriId)
  }

  /** Durable per-provider sync status, independent of any single in-flight job. */
  syncStates() { return this.store.syncStateSummary() }

  getSettings(): SettingsRecord { return this.store.settings }
  async updateSettings(value: unknown): Promise<SettingsRecord> {
    const settings = settingsRecordSchema.parse(value)
    await this.store.setSettings(settings)
    this.armAutoSync()
    return settings
  }

  health(signal?: AbortSignal) {
    const settings = this.store.settings
    return new OpenCliRunner({ executable: settings.opencliPath, profile: settings.profile,
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes }).health(signal)
  }

  /**
   * (Re)arm the background sync timer from the current settings.
   *
   * Clears its own timers rather than swapping a `ctx.effect` disposer:
   * disposing is asynchronous, so re-arming through it left a window — one
   * that a couple of quick settings saves is enough to hit — where two
   * intervals were live at once.
   */
  private armAutoSync(): void {
    this.clearAutoSync()
    const settings = this.store.settings
    if (!settings.autoSync) return
    const period = settings.autoSyncMinutes * 60_000

    const tick = (): void => {
      if (this.sync.isRunning()) {
        this.ctx.logger.info('reference sync: skipping the auto-sync tick, a sync is still running')
        return
      }
      const providers = this.sync.eligibleProviders(providerSchema.options)
      if (providers.length === 0) {
        this.ctx.logger.info('reference sync: no provider is eligible for auto-sync right now')
        return
      }
      this.ctx.logger.info(`reference sync: auto-syncing ${providers.join(', ')}`)
      this.sync.start(providers, 'incremental', {
        // The tick's own gate is `isRunning`, so a job that never finishes
        // would silently cancel every later tick.
        deadlineMs: period * 2,
        incrementalListing: true,
      })
    }

    // Jitter keeps every provider — and every dsh instance sharing a default
    // interval — off the same instant.
    this.autoSyncInterval = setInterval(tick, jitter(period))
    this.autoSyncInterval.unref?.()
    const delay = this.catchUpDelay(period)
    if (delay !== undefined) {
      this.autoSyncCatchUp = setTimeout(tick, delay)
      this.autoSyncCatchUp.unref?.()
    }
  }

  /**
   * How long to wait before a catch-up pass, or undefined when the last one
   * is recent enough that the regular interval will do.
   *
   * A plain interval only ever fires a full period after arming, so enabling
   * background sync — or restarting dsh after a day off — used to mean the
   * mirror stayed stale for up to a day before anything happened.
   */
  private catchUpDelay(period: number): number | undefined {
    let newest = 0
    for (const [, row] of this.store.syncStates.entries()) {
      const at = Date.parse(row.lastSyncAt || '')
      if (!Number.isNaN(at) && at > newest) newest = at
    }
    const elapsed = Date.now() - newest
    if (newest > 0 && elapsed < period) return undefined
    // Not immediately: startup is already the busiest moment in the process,
    // and nothing here is urgent to the second.
    return CATCH_UP_MIN_MS + Math.random() * (CATCH_UP_MAX_MS - CATCH_UP_MIN_MS)
  }

  private clearAutoSync(): void {
    if (this.autoSyncInterval) { clearInterval(this.autoSyncInterval); this.autoSyncInterval = undefined }
    if (this.autoSyncCatchUp) { clearTimeout(this.autoSyncCatchUp); this.autoSyncCatchUp = undefined }
  }
}

/** Spread a period by ±10% so providers and instances do not all fire together. */
function jitter(period: number): number {
  return Math.round(period * (0.9 + Math.random() * 0.2))
}

function timestamp(value: string): number | undefined {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && value.trim()) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}
