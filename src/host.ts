import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatProvider, SettingsRecord } from './store/spec.ts'
import type { SyncMode } from './sync/index.ts'
import type {} from './sources/web-chat/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { encodeSessionReferenceUri } from '@deepseek-ai/dsh-session-reference'
import { indexWorkspace } from './workspace.ts'

export class ReferenceAnythingRemote extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'referenceAnything') }

  workspaceSearch(agent: Agent, signal: AbortSignal) { return indexWorkspace(agent, signal) }
  async sessionSearch(agent: Agent, input: { query: string; limit: number }, signal: AbortSignal) {
    const rows = await this.ctx.sessionReferenceResolver.listCandidates(agent, input.query, input.limit, signal)
    return rows.map(row => ({ ...row, sessionId: encodeSessionReferenceUri(row.sessionId) }))
  }

  search(input: { query: string; provider?: ChatProvider; limit: number }, signal: AbortSignal) {
    signal.throwIfAborted()
    return this.ctx.referenceChatHistory.search(input.query, input.provider, input.limit, signal)
  }
  health(signal: AbortSignal) { return this.ctx.referenceChatHistory.health(signal) }
  profiles(signal: AbortSignal) { return this.ctx.referenceChatHistory.profiles(signal) }
  discoverOpenCli(signal: AbortSignal) { return this.ctx.referenceChatHistory.discoverOpenCli(signal) }
  installOpenCli(signal: AbortSignal) { return this.ctx.referenceChatHistory.installOpenCli(signal) }
  installAdapter(signal: AbortSignal) { return this.ctx.referenceChatHistory.installAdapter(signal) }
  restartDaemon(signal: AbortSignal) { return this.ctx.referenceChatHistory.restartDaemon(signal) }
  updateStatus(signal: AbortSignal) { return this.ctx.referenceChatHistory.updateStatus(signal) }
  checkUpdate(signal: AbortSignal) { return this.ctx.referenceChatHistory.checkUpdate(signal) }
  installUpdate(signal: AbortSignal) { return this.ctx.referenceChatHistory.installUpdate(signal) }
  stats() { return this.ctx.referenceChatHistory.stats() }
  syncStart(input: { providers: ChatProvider[]; mode: SyncMode }): string {
    return this.ctx.referenceChatHistory.sync.start(input.providers, input.mode)
  }
  syncStatus(input: { jobId: string }) { return this.ctx.referenceChatHistory.sync.status(input.jobId) }
  syncCancel(input: { jobId: string }): boolean { return this.ctx.referenceChatHistory.sync.cancel(input.jobId) }
  settingsGet(): SettingsRecord { return this.ctx.referenceChatHistory.getSettings() }
  settingsUpdate(settings: SettingsRecord) { return this.ctx.referenceChatHistory.updateSettings(settings) }
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
  clearOlder(input: { days: number }, signal: AbortSignal) {
    signal.throwIfAborted(); return this.ctx.referenceChatHistory.removeOlderThan(input.days)
  }
  clearRemoteMissing(signal: AbortSignal) {
    signal.throwIfAborted(); return this.ctx.referenceChatHistory.removeRemoteMissing()
  }
  clearOldAccounts(signal: AbortSignal) {
    signal.throwIfAborted(); return this.ctx.referenceChatHistory.removeOldAccounts()
  }
  syncStates() { return this.ctx.referenceChatHistory.syncStates() }
}
