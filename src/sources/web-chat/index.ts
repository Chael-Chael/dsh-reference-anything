import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ReferenceSnapshot, ReferenceSource, ReferenceSummary, ReferenceWindow } from '../../types.ts'
import type { ChatProvider, SettingsRecord } from '../../store/spec.ts'
import { providerSchema, referenceAnythingDomainSpec, settingsRecordSchema } from '../../store/spec.ts'
import { ConversationStore } from '../../store/store.ts'
import { ConversationSyncManager } from '../../sync/index.ts'
import { OpenCliRunner } from '../../opencli.ts'
import type {} from '../../index.ts'

export const name = 'reference-web-chat'
export const inject = ['references', 'storageDomain']

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

export interface ConversationSearchResult {
  uriId: string
  provider: ChatProvider
  title: string
  url: string
  updatedAt: string
  turnCount: number
  partial: boolean
  syncedAt: string
}
const PROVIDERS: ChatProvider[] = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok']

export default class WebChatHistoryService extends Service implements ReferenceSource {
  static inject = inject
  static Config = Config
  readonly id = 'web-chat'
  private storeValue?: ConversationStore
  private syncValue?: ConversationSyncManager
  private autoSyncTimer?: ReturnType<typeof setInterval>
  private autoSyncJob = ''

  constructor(ctx: Context, private readonly config: Config = {}) { super(ctx, 'referenceChatHistory') }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(referenceAnythingDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'reference-web-chat.domainClose')
    this.storeValue = new ConversationStore(domain)
    this.syncValue = new ConversationSyncManager(this.storeValue, () => new OpenCliRunner({
      executable: this.store.settings.opencliPath, profile: this.store.settings.profile,
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes,
    }))
    this.ctx.references.registerSource(this)
    this.scheduleAutoSync()
    this.ctx.effect(() => () => { if (this.autoSyncTimer) clearInterval(this.autoSyncTimer) }, 'reference-web-chat.autoSyncCleanup')
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
    return this.store.list(parsed.query, parsed.provider, limit).map(([id, row]) => ({
      ref: { source: this.id, id }, label: row.title, origin: row.url,
      updatedAt: timestamp(row.updatedAt), provider: row.provider,
      messageCount: row.messageCount, partial: row.partial, syncedAt: timestamp(row.syncedAt),
    }))
  }

  async read(ref: { source: string; id: string }, window: ReferenceWindow): Promise<ReferenceSnapshot> {
    if (ref.source !== this.id) throw new Error(`web-chat cannot read source ${ref.source}`)
    return this.store.read(ref.id, window)
  }

  search(query: string, provider: ChatProvider | undefined, limit: number): ConversationSearchResult[] {
    return this.store.list(query, provider, Math.max(1, Math.min(100, limit))).map(([uriId, row]) => ({
      uriId, provider: row.provider, title: row.title, url: row.url, updatedAt: row.updatedAt,
      turnCount: row.messageCount, partial: row.partial, syncedAt: row.syncedAt,
    }))
  }

  stats() { return this.store.stats(PROVIDERS) }

  getSettings(): SettingsRecord { return this.store.settings }
  async updateSettings(value: unknown): Promise<SettingsRecord> {
    const settings = settingsRecordSchema.parse(value)
    await this.store.setSettings(settings)
    this.scheduleAutoSync()
    return settings
  }

  health(signal?: AbortSignal) {
    const settings = this.store.settings
    return new OpenCliRunner({ executable: settings.opencliPath, profile: settings.profile,
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes }).health(signal)
  }

  profiles(signal?: AbortSignal) {
    const settings = this.store.settings
    return new OpenCliRunner({ executable: settings.opencliPath, profile: '',
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes }).profiles(signal)
  }

  async installAdapter(signal?: AbortSignal): Promise<boolean> {
    const settings = this.store.settings
    const runner = new OpenCliRunner({ executable: settings.opencliPath, profile: settings.profile,
      timeoutMs: this.config.timeoutMs, maxStdoutBytes: this.config.maxStdoutBytes })
    await runner.installPlugin(new URL('../../../opencli-plugin/', import.meta.url).href, signal)
    return true
  }


  private scheduleAutoSync(): void {
    if (this.autoSyncTimer) clearInterval(this.autoSyncTimer)
    this.autoSyncTimer = undefined
    const settings = this.store.settings
    if (!settings.autoSync) return
    this.autoSyncTimer = setInterval(() => {
      if (this.autoSyncJob && this.sync.status(this.autoSyncJob)?.status === 'running') return
      this.autoSyncJob = this.sync.start(PROVIDERS, 'incremental')
    }, settings.autoSyncMinutes * 60_000)
    this.autoSyncTimer.unref?.()
  }
}

export function parseProviderQuery(value: string): { provider?: ChatProvider; query: string } {
  const match = value.trim().match(/^@?(chatgpt|claude|gemini|deepseek|grok)(?:\s+|$)(.*)$/i)
  if (!match) return { query: value.trim() }
  const parsed = providerSchema.safeParse(match[1]?.toLowerCase())
  return parsed.success ? { provider: parsed.data, query: (match[2] || '').trim() } : { query: value.trim() }
}

function timestamp(value: string): number | undefined {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && value.trim()) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}
