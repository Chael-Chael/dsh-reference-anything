import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatProvider, SettingsRecord } from './store/spec.ts'
import type { ReferenceUiMode } from './wire.ts'
import type { SyncMode } from './sync/index.ts'
import type {} from './sources/web-chat/index.ts'
import type {} from './sources/local-agent/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { switchReferenceUiMode as switchProfileReferenceUiMode } from './profile-mode.ts'

export class ReferenceAnythingRemote extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'referenceAnything') }

  /**
   * Discovery for the `@` menu's local-agent group.
   *
   * Resolved optionally rather than injected: `reference-anything-web` must
   * still load in a profile where the local-agent plugin is switched off, and an
   * absent service means an empty group, not a broken composer. Workspace
   * scoping takes the session's own cwd, so a Web server serving projects from
   * anywhere still scopes to the project the user is in.
   */
  async agentSearch(agent: Agent, input: { query: string; limit: number }, signal: AbortSignal) {
    const agents = this.ctx.get('referenceLocalAgents')
    if (agents === undefined) return []
    // A session with no cwd of its own is rare and has no workspace to scope
    // to; falling back to the process's directory is the same guess the
    // `ReferenceSource.list` seam makes, rather than an empty group.
    const rows = await agents.listForWorkspace(input.query, input.limit, agent.session.header.cwd ?? process.cwd(), signal)
    return rows.map(row => ({
      id: row.ref.id,
      label: row.label,
      provider: row.provider ?? '',
      ...row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt },
    }))
  }

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
  updateStatus(signal: AbortSignal) { return this.ctx.referenceChatHistory.updateStatus(signal) }
  checkUpdate(signal: AbortSignal) { return this.ctx.referenceChatHistory.checkUpdate(signal) }
  installUpdate(signal: AbortSignal) { return this.ctx.referenceChatHistory.installUpdate(signal) }
  async switchReferenceUiMode(input: { mode: ReferenceUiMode }, signal: AbortSignal) {
    const settings = this.ctx.referenceChatHistory.getSettings()
    const previousMode = settings.referenceUiMode ?? 'plugin'
    const result = await switchProfileReferenceUiMode({ mode: input.mode, signal })
    try {
      await this.ctx.referenceChatHistory.updateSettings({ ...settings, referenceUiMode: input.mode })
    } catch (error) {
      await switchProfileReferenceUiMode({ mode: previousMode }).catch(() => undefined)
      throw error
    }
    return result
  }
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
