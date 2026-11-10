/** Remote for the Web-chat source: mirror search, synchronization, and storage management. */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { REMOTE_SERVICE_KEYS } from '../../contract.ts'
import type { ChatProvider } from '../../store/spec.ts'
import type { SyncMode } from '../../sync/index.ts'
import type {} from './index.ts'

export class WebChatRemote extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, REMOTE_SERVICE_KEYS.webChat) }

  search(input: { query: string; provider?: ChatProvider; limit: number }, signal: AbortSignal) {
    signal.throwIfAborted()
    return this.ctx.referenceChatHistory.search(input.query, input.provider, input.limit, signal)
  }
  health(signal: AbortSignal) { return this.ctx.referenceChatHistory.health(signal) }
  quickHealth(signal: AbortSignal) { return this.ctx.referenceChatHistory.quickHealth(signal) }
  profiles(signal: AbortSignal) { return this.ctx.referenceChatHistory.profiles(signal) }
  discoverOpenCli(signal: AbortSignal) { return this.ctx.referenceChatHistory.discoverOpenCli(signal) }
  installOpenCli(signal: AbortSignal) { return this.ctx.referenceChatHistory.installOpenCli(signal) }
  installAdapter(signal: AbortSignal) { return this.ctx.referenceChatHistory.installAdapter(signal) }
  restartDaemon(signal: AbortSignal) { return this.ctx.referenceChatHistory.restartDaemon(signal) }
  stats() { return this.ctx.referenceChatHistory.stats() }
  async syncStart(input: { providers: ChatProvider[]; mode: SyncMode }): Promise<string> {
    await this.ctx.referenceChatHistory.ensureBrowser()
    return this.ctx.referenceChatHistory.sync.start(input.providers, input.mode)
  }
  syncStatus(input: { jobId: string }) { return this.ctx.referenceChatHistory.sync.status(input.jobId) }
  syncCancel(input: { jobId: string }): boolean { return this.ctx.referenceChatHistory.sync.cancel(input.jobId) }
  browse(input: { query: string; provider?: ChatProvider; limit: number; offset: number }, signal: AbortSignal) {
    signal.throwIfAborted()
    return this.ctx.referenceChatHistory.browse(input.query, input.provider, input.limit, input.offset)
  }
  deleteConversation(input: { uriId: string }, signal: AbortSignal) {
    signal.throwIfAborted()
    return this.ctx.referenceChatHistory.remove(input.uriId)
  }
  storageStats() { return this.ctx.referenceChatHistory.storageStats() }
  clearProvider(input: { provider: ChatProvider }, signal: AbortSignal) {
    signal.throwIfAborted(); return this.ctx.referenceChatHistory.removeProvider(input.provider)
  }
  clearRemoteMissing(signal: AbortSignal) {
    signal.throwIfAborted(); return this.ctx.referenceChatHistory.removeRemoteMissing()
  }
  clearOldAccounts(signal: AbortSignal) {
    signal.throwIfAborted(); return this.ctx.referenceChatHistory.removeOldAccounts()
  }
  syncStates() { return this.ctx.referenceChatHistory.syncStates() }
}
