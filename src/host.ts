import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatProvider, SettingsRecord } from './store/spec.ts'
import type { SyncMode } from './sync/index.ts'
import type {} from './sources/web-chat/index.ts'

export class ReferenceAnythingRemote extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'referenceAnything') }

  search(input: { query: string; provider?: ChatProvider; limit: number }, signal: AbortSignal) {
    signal.throwIfAborted()
    return this.ctx.referenceChatHistory.search(input.query, input.provider, input.limit)
  }
  health(signal: AbortSignal) { return this.ctx.referenceChatHistory.health(signal) }
  profiles(signal: AbortSignal) { return this.ctx.referenceChatHistory.profiles(signal) }
  installAdapter(signal: AbortSignal) { return this.ctx.referenceChatHistory.installAdapter(signal) }
  stats() { return this.ctx.referenceChatHistory.stats() }
  syncStart(input: { providers: ChatProvider[]; mode: SyncMode }): string {
    return this.ctx.referenceChatHistory.sync.start(input.providers, input.mode)
  }
  syncStatus(input: { jobId: string }) { return this.ctx.referenceChatHistory.sync.status(input.jobId) }
  syncCancel(input: { jobId: string }): boolean { return this.ctx.referenceChatHistory.sync.cancel(input.jobId) }
  settingsGet(): SettingsRecord { return this.ctx.referenceChatHistory.getSettings() }
  settingsUpdate(settings: SettingsRecord) { return this.ctx.referenceChatHistory.updateSettings(settings) }
}
