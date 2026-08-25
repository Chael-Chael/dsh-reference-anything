import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConversationAttachment, ConversationItem, ReferenceSnapshot, ReferenceSource, ReferenceSummary, ReferenceWindow } from '../../types.ts'
import type { ChatProvider, SettingsRecord } from '../../store/spec.ts'
import { providerSchema, referenceAnythingDomainSpec, settingsRecordSchema } from '../../store/spec.ts'
import { ConversationStore, type MatchedVia } from '../../store/store.ts'
import { ConversationSyncManager } from '../../sync/index.ts'
import { OpenCliError, OpenCliRunner, discoverOpenCli, installOpenCli as installOpenCliPackage, type OpenCliDiscovery } from '../../opencli.ts'
import { PACKAGE_NAME, PackageUpdateManager, type PackageUpdateResult, type PackageUpdateStatus } from '../../update.ts'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { ProviderTurnRow } from '../../store/store.ts'
import { ReferenceAnythingError } from '../../errors.ts'
import { parseProviderQuery } from '../../search.ts'
import { validateDownloadDirectory } from '../../download-directory.ts'
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
const PROVIDERS: ChatProvider[] = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi']

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
  /** Mirrored browser chats are outside the task's workspace: read only what the user named. */
  readonly requiresGrant = true
  private storeValue?: ConversationStore
  private syncValue?: ConversationSyncManager
  private autoSyncInterval?: ReturnType<typeof setInterval>
  private autoSyncCatchUp?: ReturnType<typeof setTimeout>
  private settingsUpdateQueue: Promise<void> = Promise.resolve()
  private validateDownloadDirectoryValue = validateDownloadDirectory
  private readonly packageUpdates = new PackageUpdateManager({
    afterInstall: async (profileDir, _version, signal) => {
      await this.installAdapterFrom(pathToFileURL(join(profileDir, 'node_modules', PACKAGE_NAME, 'opencli-plugin')).href, signal)
    },
  })
  private readonly liveAttachments = new Map<string, { attachment: ConversationAttachment & { locator?: string }; expiresAt: number }>()

  constructor(ctx: Context, private readonly config: Config = {}) { super(ctx, 'referenceChatHistory') }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(referenceAnythingDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'reference-web-chat.domainClose')
    this.storeValue = new ConversationStore(domain)
    // The schema default also applies to installations created before modes
    // existed. Enforce that default immediately so legacy mirrored bodies do
    // not survive silently under a metadata-only setting.
    if (this.store.settings.historyMode === 'metadata-only') {
      await this.store.setSettings(this.store.settings)
      await this.store.clearMirrorContent()
    }
    if (this.store.settings.syncHistoryDays !== null) {
      await this.store.removeOlderThan(this.store.settings.syncHistoryDays)
    }
    this.syncValue = new ConversationSyncManager(this.storeValue, () => new OpenCliRunner({
      executable: this.store.settings.opencliPath, profile: this.store.settings.profile,
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes,
    }), this.ctx.logger)
    await this.store.collectExpired()
    const updateAbort = new AbortController()
    this.ctx.effect(() => () => { updateAbort.abort() }, 'reference-web-chat.updateCheckCleanup')
    void this.packageUpdates.check(updateAbort.signal).then(status => {
      if (status.updateAvailable) {
        this.ctx.logger.info(`reference anything update available: ${status.currentVersion} -> ${status.latestVersion}`)
      }
    })
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

  async read(ref: { source: string; id: string }, window: ReferenceWindow, signal?: AbortSignal): Promise<ReferenceSnapshot> {
    if (ref.source !== this.id) throw new Error(`web-chat cannot read source ${ref.source}`)
    if (this.store.settings.historyMode === 'metadata-only') return this.readRemote(ref.id, window, signal)
    return this.store.read(ref.id, window)
  }

  /** Resolve an attachment locator captured by a recent metadata-only read. Never persisted. */
  liveAttachment(conversationKey: string, attachmentId: string) {
    const key = `${conversationKey}\0${attachmentId}`
    const hit = this.liveAttachments.get(key)
    if (!hit || hit.expiresAt <= Date.now()) { this.liveAttachments.delete(key); return undefined }
    return hit.attachment
  }

  private async readRemote(conversationKey: string, window: ReferenceWindow, signal?: AbortSignal): Promise<ReferenceSnapshot> {
    const conversation = this.store.conversations.get(conversationKey)
    if (!conversation || conversation.remoteMissing) {
      throw new ReferenceAnythingError(
        'conversation is missing from the local active-account index; ask the user to sync its provider and reselect it from the refreshed @ list, then retry',
        'REFERENCE_NOT_FOUND',
      )
    }
    let end: number | undefined = window.before
    if (window.cursor !== undefined) end = decodeLiveCursor(window.cursor, conversationKey)
    let rows: ProviderTurnRow[]
    try {
      rows = await this.runner().detail(conversation.provider, conversation.externalId, signal, conversation.accountScope)
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (error instanceof OpenCliError && error.code === 'PROVIDER_ACCOUNT_MISMATCH') {
        throw new ReferenceAnythingError(
          `conversation belongs to a different logged-in ${conversation.provider} account; ask the user to sync ${conversation.provider} and reselect it from the refreshed @ list, then retry`,
          'REFERENCE_ACCOUNT_MISMATCH',
          { cause: error },
        )
      }
      throw new ReferenceAnythingError(
        `could not fetch the conversation from ${conversation.provider}; ask the user to confirm the browser connection and login, sync ${conversation.provider}, and then retry`,
        'REFERENCE_READ_FAILED',
        { cause: error },
      )
    }
    const turns = projectRemoteTurns(rows)
    const boundedEnd = Math.max(0, Math.min(end ?? turns.length, turns.length))
    const start = Math.max(0, boundedEnd - Math.max(1, Math.trunc(window.limit)))
    const expiresAt = Date.now() + 60 * 60_000
    for (const turn of turns.slice(start, boundedEnd)) for (const attachment of turn.attachments ?? []) {
      this.liveAttachments.set(`${conversationKey}\0${attachment.attachmentId}`, { attachment, expiresAt })
    }
    const nextCursor = start > 0 ? encodeLiveCursor(conversationKey, start) : undefined
    return {
      ref: { source: this.id, id: conversationKey }, label: conversation.title, origin: conversation.url,
      updatedAt: timestamp(conversation.updatedAt), provider: conversation.provider,
      partial: conversation.partial || rows.some(row => row.partial), capturedAt: Date.now(),
      body: {
        kind: 'conversation', items: turns.slice(start, boundedEnd), startIndex: start,
        totalTurns: turns.length, hasOlder: start > 0, ...(nextCursor ? { nextCursor } : {}),
      },
    }
  }

  async search(query: string, provider: ChatProvider | undefined, limit: number, signal?: AbortSignal): Promise<ConversationSearchResult[]> {
    signal?.throwIfAborted()
    const parsed = parseProviderQuery(query)
    return this.store
      .list(parsed.query, provider ?? parsed.provider, Math.max(1, Math.min(100, limit)))
      .map(({ key, row, via, snippet }) => ({
        uriId: key, provider: row.provider, title: row.title, url: row.url, updatedAt: row.updatedAt,
        turnCount: row.messageCount, partial: row.partial, syncedAt: row.syncedAt,
        matchedVia: via, ...(snippet ? { snippet } : {}),
      }))
  }

  stats() { return this.store.stats(PROVIDERS) }
  storageStats() { return this.store.storageStats() }

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

  async removeProvider(provider: ChatProvider): Promise<number> {
    if (this.sync.isRunning()) throw new ReferenceAnythingError('cannot clear provider data while a sync is in progress', 'REFERENCE_SYNC_IN_PROGRESS')
    return this.store.removeProvider(provider)
  }

  async removeRemoteMissing(): Promise<number> {
    if (this.sync.isRunning()) throw new ReferenceAnythingError('cannot clear remote-missing data while a sync is in progress', 'REFERENCE_SYNC_IN_PROGRESS')
    return this.store.removeRemoteMissing()
  }

  async removeOldAccounts(): Promise<number> {
    if (this.sync.isRunning()) throw new ReferenceAnythingError('cannot clear old-account data while a sync is in progress', 'REFERENCE_SYNC_IN_PROGRESS')
    return this.store.removeOldAccounts()
  }

  /** Durable per-provider sync status, independent of any single in-flight job. */
  syncStates() { return this.store.syncStateSummary() }

  getSettings(): SettingsRecord { return this.store.settings }
  updateStatus(signal?: AbortSignal): Promise<PackageUpdateStatus> { return this.packageUpdates.status(signal) }
  checkUpdate(signal?: AbortSignal): Promise<PackageUpdateStatus> { return this.packageUpdates.check(signal) }
  async installUpdate(signal?: AbortSignal): Promise<PackageUpdateResult> {
    if (this.sync.isRunning()) throw new ReferenceAnythingError('wait for the current conversation sync to finish before updating', 'REFERENCE_SYNC_IN_PROGRESS')
    return this.packageUpdates.update(signal)
  }
  async restartDaemon(signal?: AbortSignal): Promise<boolean> { await this.runner().restartDaemon(signal); return true }
  async discoverOpenCli(signal?: AbortSignal): Promise<OpenCliDiscovery> {
    return discoverOpenCli(this.store.settings.opencliPath, signal)
  }
  async installOpenCli(signal?: AbortSignal): Promise<OpenCliDiscovery> {
    const discovery = await installOpenCliPackage(signal)
    if (this.store.settings.opencliPath !== discovery.executable) {
      await this.store.setSettings({ ...this.store.settings, opencliPath: discovery.executable })
    }
    return discovery
  }
  updateSettings(value: unknown): Promise<SettingsRecord> {
    const submittedAgainst = this.store.settings
    const pending = (this.settingsUpdateQueue ?? Promise.resolve()).then(() => this.applySettings(value, submittedAgainst))
    // Keep the serialization tail fulfilled so one rejected mutation does not
    // prevent a later, valid settings request from running.
    this.settingsUpdateQueue = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async applySettings(value: unknown, submittedAgainst: SettingsRecord): Promise<SettingsRecord> {
    const submitted = settingsRecordSchema.parse(value)
    const directoryChanged = !isDeepStrictEqual(
      submitted.cloudDriveDownloadDirectory,
      submittedAgainst.cloudDriveDownloadDirectory,
    )
    let validatedDirectory = submitted.cloudDriveDownloadDirectory
    if (directoryChanged) {
      const validateDirectory = this.validateDownloadDirectoryValue ?? validateDownloadDirectory
      validatedDirectory = await validateDirectory(validatedDirectory)
    }

    // Validation can be slow (especially for a network drive). Merge against a
    // fresh value so direct writers such as installOpenCli are not overwritten
    // by the snapshot captured before that await.
    const current = this.store.settings
    let settings = mergeSettingsUpdate(submittedAgainst, current, submitted)
    if (directoryChanged) settings = { ...settings, cloudDriveDownloadDirectory: validatedDirectory }
    const enteringMetadataOnly = settings.historyMode === 'metadata-only' && current.historyMode !== 'metadata-only'
    const historyRangeChanged = settings.syncHistoryDays !== current.syncHistoryDays
    await this.store.setSettings(settings)
    if (enteringMetadataOnly) await this.store.clearMirrorContent()
    if (historyRangeChanged && settings.syncHistoryDays !== null) await this.store.removeOlderThan(settings.syncHistoryDays)
    this.armAutoSync()
    return settings
  }

  health(signal?: AbortSignal) {
    const settings = this.store.settings
    return new OpenCliRunner({ executable: settings.opencliPath, profile: settings.profile,
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes }).health(signal)
  }

  quickHealth(signal?: AbortSignal) {
    const settings = this.store.settings
    return new OpenCliRunner({ executable: settings.opencliPath, profile: settings.profile,
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes }).quickHealth(signal)
  }

  profiles(signal?: AbortSignal) {
    const settings = this.store.settings
    return new OpenCliRunner({ executable: settings.opencliPath, profile: '',
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes }).profiles(signal)
  }

  private runner(): OpenCliRunner {
    const settings = this.store.settings
    return new OpenCliRunner({ executable: settings.opencliPath, profile: settings.profile,
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes })
  }

  async installAdapter(signal?: AbortSignal): Promise<boolean> {
    await this.installAdapterFrom(new URL('../../../opencli-plugin/', import.meta.url).href, signal)
    return true
  }

  private async installAdapterFrom(pluginUrl: string, signal?: AbortSignal): Promise<void> {
    const settings = this.store.settings
    const runner = new OpenCliRunner({ executable: settings.opencliPath, profile: settings.profile,
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes })
    await runner.installPlugin(pluginUrl, signal)
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
    if (!settings.autoSync && !settings.syncOnStartup) return
    const period = settings.autoSyncMinutes * 60_000

    const tick = (): void => {
      if (this.sync.isRunning()) {
        this.ctx.logger.info('reference sync: skipping the auto-sync tick, a sync is still running')
        return
      }
      const providers = this.sync.eligibleProviders(settings.enabledProviders)
      if (providers.length === 0) {
        this.ctx.logger.info('reference sync: no provider is eligible for auto-sync right now')
        return
      }
      this.ctx.logger.info(`reference sync: auto-syncing ${providers.join(', ')}`)
      this.sync.start(providers, 'incremental', {
        // The tick's own gate is `isRunning`, so a job that never finishes
        // would silently cancel every later tick.
        deadlineMs: period * 2,
      })
    }

    // Jitter keeps every provider — and every dsh instance sharing a default
    // interval — off the same instant.
    if (settings.autoSync) {
      this.autoSyncInterval = setInterval(tick, jitter(period))
      this.autoSyncInterval.unref?.()
    }
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

/** Apply only fields changed by this full-record request since its submission snapshot. */
function mergeSettingsUpdate(
  submittedAgainst: SettingsRecord,
  current: SettingsRecord,
  submitted: SettingsRecord,
): SettingsRecord {
  const merged: SettingsRecord = { ...current }
  const keys = new Set([...Object.keys(submittedAgainst), ...Object.keys(submitted)] as Array<keyof SettingsRecord>)
  for (const key of keys) {
    if (!isDeepStrictEqual(submitted[key], submittedAgainst[key])) {
      Object.assign(merged, { [key]: submitted[key] })
    }
  }
  return settingsRecordSchema.parse(merged)
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

function projectRemoteTurns(rows: readonly ProviderTurnRow[]): ConversationItem[] {
  return rows.filter(row => row.activeBranch !== false).sort((a, b) => a.ordinal - b.ordinal).flatMap(row => {
    const attachments = parseLiveAttachments(row.attachmentsJson)
    const text = String(row.text || '')
    if (!text.trim() && attachments.length === 0) return []
    return [{ role: row.role, text, ...(attachments.length ? { attachments } : {}) }]
  })
}

function parseLiveAttachments(raw: string): Array<ConversationAttachment & { locator?: string }> {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((value, index) => {
      const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      const name = String(row.name ?? 'attachment')
      const mimeType = String(row.mimeType ?? '')
      const locator = typeof row.locator === 'string' && row.locator ? row.locator : undefined
      const status = row.status === 'available' || row.status === 'expired' ? row.status : 'unavailable'
      return {
        attachmentId: String(row.attachmentId ?? row.id ?? index),
        kind: row.kind === 'image' || row.type === 'image' || mimeType.startsWith('image/') ? 'image' as const : 'file' as const,
        name, mimeType, size: Math.max(0, Number(row.size ?? 0) || 0), status,
        ...(locator ? { locator } : {}),
      }
    })
  } catch { return [] }
}

function encodeLiveCursor(ref: string, nextOrdinal: number): string {
  return Buffer.from(JSON.stringify({ v: 2, ref, nextOrdinal })).toString('base64url')
}

function decodeLiveCursor(value: string, expectedRef: string): number {
  try {
    const row = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (row.v !== 2 || row.ref !== expectedRef || !Number.isInteger(row.nextOrdinal) || Number(row.nextOrdinal) < 0) throw new Error()
    return Number(row.nextOrdinal)
  } catch {
    throw new ReferenceAnythingError('live reference cursor is malformed or belongs to another conversation', 'REFERENCE_INVALID_CURSOR')
  }
}
