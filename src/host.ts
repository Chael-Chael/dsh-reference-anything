import { AgentScanCache } from './agent-scan-cache.ts'
import { localConversationRoots } from './local-conversation-reader.ts'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatProvider, SettingsRecord } from './store/spec.ts'
import type { SyncMode } from './sync/index.ts'
import type {} from './sources/web-chat/index.ts'
import type {} from './sources/local-agent/index.ts'
import type {} from './sources/cloud-drive/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from './openlist/index.ts'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { validateDownloadDirectory } from './download-directory.ts'
import { resolveLocalPlugins } from './local-plugins.ts'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { discoverySchema, scanFormat, agentKind } from './chat-import-discovery.ts'
import { ALL_LOCAL_AGENTS, LOCAL_AGENT_LABEL, type LocalAgent } from './wire.ts'
import { expandRoot } from './sources/local-agent/registry.ts'
import { homedir } from 'node:os'
import { inWorkspace } from './sources/local-agent/path.ts'
import type { AgentCandidate } from './client/remote.ts'
import { chatImportCompatibility, upgradeChatImport } from './chat-import-compatibility.ts'

const importedItemSchema = z.object({
  status: z.string(), sessionId: z.string().min(1).optional(),
  error: z.string().optional(), reason: z.string().optional(), skipReason: z.string().optional(),
})
const chatImportResultSchema = z.discriminatedUnion('mode', [
  importedItemSchema.extend({ mode: z.literal('single') }),
  z.object({ mode: z.literal('batch'), results: z.array(importedItemSchema) }),
])

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatImport: {
      readConversation?(input: { format: string; path: string; sessionId?: string; limit?: number; before?: number; revision?: string; detail?: 'summary' | 'full' }, signal?: AbortSignal): Promise<unknown>
      discoveryRoots?(): Record<string, string | string[] | null>
      scanDiscover(input: { format?: string; path?: string; query?: string }, signal?: AbortSignal): Promise<unknown>
      importPath(input: { format: string; path: string; sessionIds?: string[] }, signal?: AbortSignal): Promise<unknown>
      resumeSummary(input: { format: 'claude' | 'codex'; path: string }, signal?: AbortSignal): Promise<unknown>
    }
  }
}

export class ReferenceAnythingRemote extends TypertRemoteService {
  async chatImportStatus() { return chatImportCompatibility(this.ctx) }
  async chatImportUpgradeInstall(signal: AbortSignal) {
    await upgradeChatImport(this.ctx, signal)
    return this.chatImportStatus()
  }
  private readonly agentScans = new AgentScanCache()
  private readonly scannedTargets = new Map<string, { owner: string; policy: string; format: string; path: string; sessionIds: string[] }>()
  constructor(ctx: Context) { super(ctx, 'referenceAnything') }

  async agentResume(_agent: Agent, input: { id: string }, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    this.assertScannedSelection(_agent, input.id)
    const importer = this.ctx.get('chatImport')
    if (typeof importer?.resumeSummary !== 'function') throw new Error('Chat Import API unavailable. Open Reference Anything settings → Local Agent conversations to check compatibility and upgrade, then restart DSH.')
    const agents = this.ctx.get('referenceLocalAgents')
    if (!agents) throw new Error('Local agent conversations are unavailable.')
    const { format, path } = await agents.importTarget(input.id)
    if (format !== 'claude' && format !== 'codex') throw new Error('Chat Import Resume supports Claude Code and Codex only.')
    signal.throwIfAborted()
    const result = await importer.resumeSummary({ format, path }, signal)
    return z.object({ summary: z.string().min(1) }).parse(result).summary
  }

  async agentImport(_agent: Agent, input: { id: string }, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const importer = this.ctx.get('chatImport')
    if (typeof importer?.importPath !== 'function') throw new Error('Chat Import API unavailable. Open Reference Anything settings → Local Agent conversations to check compatibility and upgrade, then restart DSH.')
    const agents = this.ctx.get('referenceLocalAgents')
    if (!agents) throw new Error('Local agent conversations are unavailable.')
    const scanned = input.id.startsWith('scan:') || input.id.includes(':chat-import:')
      ? this.scannedTargets.get(`${_agent.session.header.id}:${input.id}`) : undefined
    this.assertScannedSelection(_agent, input.id)
    const target = scanned ? { format: scanned.format, path: scanned.path, sessionIds: scanned.sessionIds } : await agents.importTarget(input.id)
    signal.throwIfAborted()
    const result = await importer.importPath(target, signal)
    const parsed = chatImportResultSchema.parse(result)
    const items = parsed.mode === 'single' ? [parsed] : parsed.results
    if (items.length !== 1) throw new Error('Expected exactly one imported conversation; no conversation was opened.')
    const item = items[0]!
    if (!['imported', 'replaced', 'already-imported', 'appended'].includes(item.status) || !item.sessionId) {
      throw new Error(`Conversation was not imported (${item.status}): ${item.error ?? item.reason ?? item.skipReason ?? ''}`)
    }
    return item.sessionId
  }

  /**
   * Discovery for the `@` menu's local-agent group.
   *
   * Resolved optionally rather than injected: `reference-anything-web` must
   * still load in a profile where the local-agent plugin is switched off, and an
   * absent service means an empty group, not a broken composer. Workspace
   * scoping takes the session's own cwd, so a Web server serving projects from
   * anywhere still scopes to the project the user is in.
   */
  async agentSearch(agent: Agent, input: { query: string; limit: number; kind?: LocalAgent }, signal: AbortSignal) {
    const agents = this.ctx.get('referenceLocalAgents')
    if (agents === undefined) return []
    const importer = this.ctx.get('chatImport')
    {
      const settings = this.ctx.referenceChatHistory.getSettings()
      agents.setAgentDirectories(settings.agentDirectories ?? {})
      const policy = agents.discoveryPolicy()
      const requests: Array<{ format: string; path?: string }> = policy.roots.map(root => ({ format: scanFormat(root.kind), path: root.path }))
      {
        for (const kind of ALL_LOCAL_AGENTS) {
          if (!(settings.enabledAgents ?? ALL_LOCAL_AGENTS).includes(kind)) continue
          const format = scanFormat(kind)
          requests.push({ format })
          const custom = expandRoot(settings.agentDirectories?.[kind] ?? '', homedir())
          if (custom) requests.push({ format, path: custom })
        }
      }
      const candidates: AgentCandidate[] = []
      const discovered: z.infer<typeof discoverySchema>['sessions'] = []
      const warnings: AgentCandidate[] = []
      const seen = new Set<string>()
      const owner = agent.session.header.id
      // Scope before scanning and deduplicate explicit roots repeated by settings.
      const scannedRequests = new Set<string>()
      const matchingRequests = new Set<string>()
      for (const request of requests) {
        const kind = agentKind(request.format) as LocalAgent
        if ((input.kind && kind !== input.kind) || !(settings.enabledAgents ?? ALL_LOCAL_AGENTS).includes(kind)) continue
        const requestKey = JSON.stringify([request.format, request.path ?? null])
        if (scannedRequests.has(requestKey)) continue
        scannedRequests.add(requestKey)
        signal.throwIfAborted()
        try {
          const result = await agents.scanner.scanDiscover(request, signal)
          for (const warning of result.warnings) warnings.push({ id: `warning:${warnings.length}`, kind: 'scan-warning', label: warning.format, provider: '', warning: `${warning.target}: ${warning.error}` })
          for (const row of result.sessions) {
            const query = input.query.trim().toLowerCase()
            if (query && ![row.title, row.project, row.sourcePath].some(value => value?.toLowerCase().includes(query))) continue
            const key = JSON.stringify([row.format, row.sourcePath, row.sessionId])
            if ((input.kind && agentKind(row.format) !== input.kind) || seen.has(key) || (policy.scope === 'workspace' && !inWorkspace(row.cwd ?? '', agent.session.header.cwd ?? process.cwd()))) continue
            seen.add(key)
            matchingRequests.add(requestKey)
            discovered.push({ ...row })
          }
        } catch (error) {
          signal.throwIfAborted()
          warnings.push({ id: `warning:${warnings.length}`, kind: 'scan-warning', label: request.format, provider: '', warning: error instanceof Error ? error.message : String(error) })
        }
      }
      if (importer?.scanDiscover) {
        const statuses = new Map<string, z.infer<typeof discoverySchema>['sessions'][number]['importStatus']>()
        // Import status is only needed for matched references; avoid competing corpus scans on every keystroke.
        await Promise.all([...matchingRequests].map(async key => {
          const [format, path] = JSON.parse(key) as [string, string | null]
          try {
            const result = await this.agentScans.read(importer, '', key,
              () => importer.scanDiscover({ format, ...(path ? { path } : {}) }, AbortSignal.timeout(2_000)), AbortSignal.any([signal, AbortSignal.timeout(2_000)]))
            for (const row of result.sessions) statuses.set(JSON.stringify([row.format, row.sourcePath, row.sessionId]), row.importStatus)
          } catch { signal.throwIfAborted() }
        }))
        for (const row of discovered) row.importStatus = statuses.get(JSON.stringify([row.format, row.sourcePath, row.sessionId]))
      }
      discovered.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
      for (const row of discovered) {
        signal.throwIfAborted()
        if (candidates.length >= input.limit) break
        if (!await agents.conversationAvailability.visible({ format: row.format, path: row.sourcePath, sessionId: row.sessionId })) continue
        const kind = agentKind(row.format)
        const referenceId = await agents.referenceForDiscovered(kind, row.sourcePath, row.sessionId)
        if (!referenceId && settings.picker?.agents.showImport === false) continue
        const id = referenceId ?? `scan:${randomUUID()}`
        if (!referenceId || referenceId.includes(':chat-import:')) {
          this.scannedTargets.set(`${owner}:${id}`, { owner, policy: JSON.stringify(settings), format: row.format, path: row.sourcePath, sessionIds: [row.sessionId] })
          if (this.scannedTargets.size > 2000) this.scannedTargets.delete(this.scannedTargets.keys().next().value!)
        }
        candidates.push({ id, kind, label: row.title || row.sessionId, provider: LOCAL_AGENT_LABEL[kind as LocalAgent] ?? row.format,
          ...(referenceId ? { referenceId } : { importOnly: true }), importStatus: row.importStatus,
          ...(row.lastActiveAt == null ? {} : { updatedAt: row.lastActiveAt }) })
      }
      return [...warnings, ...candidates]
    }
  }

  async agentStats(signal: AbortSignal) {
    signal.throwIfAborted()
    const agents = this.ctx.get('referenceLocalAgents')
    if (agents === undefined) return []
    const settings = this.ctx.referenceChatHistory.getSettings()
    agents.setAgentDirectories(settings.agentDirectories ?? {})
    const rows: import('./client/remote.ts').AgentStats[] = []
    for (const kind of ALL_LOCAL_AGENTS) {
      const format = scanFormat(kind)
      signal.throwIfAborted()
      const sessions = new Set<string>()
      const errors: string[] = []
      const custom = expandRoot(settings.agentDirectories?.[kind] ?? '', homedir())
      for (const path of custom ? [undefined, custom] : [undefined]) {
        try {
          const result = discoverySchema.parse(await agents.scanner.scanDiscover({ format, ...(path ? { path } : {}) }, signal))
          for (const row of result.sessions) {
            if (await agents.conversationAvailability.visible({ format: row.format, path: row.sourcePath, sessionId: row.sessionId })) sessions.add(JSON.stringify([row.sourcePath, row.sessionId]))
          }
          errors.push(...result.warnings.map(warning => `${warning.target}: ${warning.error}`))
        } catch (error) {
          signal.throwIfAborted()
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
      rows.push({ agent: kind, conversations: sessions.size, ...(errors.length ? { error: errors.join('\n') } : {}) })
    }
    const roots = localConversationRoots()
    return rows.map(row => {
      const root = roots?.[scanFormat(row.agent)]
      const custom = settings.agentDirectories?.[row.agent]
      const paths = [...new Set([...(Array.isArray(root) ? root : root ? [root] : []), ...(custom ? [custom] : [])])]
      return { ...row, ...(roots ? { paths } : {}), readable: true }
    })
  }

  private assertScannedSelection(agent: Agent, id: string): void {
    if (!id.startsWith('scan:') && !id.includes(':chat-import:')) return
    const selected = this.scannedTargets.get(`${agent.session.header.id}:${id}`)
    if (!selected || selected.owner !== agent.session.header.id || selected.policy !== JSON.stringify(this.ctx.referenceChatHistory.getSettings())) {
      throw new Error('Conversation selection expired. Search and select it again.')
    }
  }

  /**
   * Discovery for the `@` menu's cloud-drive group.
   *
   * Optional for the same reason as `agentSearch` above. It takes no session:
   * a drive is not scoped to a workspace, so there is nothing a cwd could
   * narrow. `list` already refuses to name a download URL, so what comes back
   * here is a label and a display path.
   */
  async driveSearch(input: { query: string; limit: number }, signal: AbortSignal) {
    const drives = this.ctx.get('referenceCloudDrive')
    if (drives === undefined) return []
    const rows = await drives.pickerList(input.query, input.limit, signal)
    return rows.map(row => ({
      id: row.ref.id,
      label: row.label,
      provider: row.provider ?? '',
      ...row.origin === undefined ? {} : { origin: row.origin },
      ...row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt },
      ...row.isDirectory === true ? { isDirectory: true } : {},
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
  stats() { return this.ctx.referenceChatHistory.stats() }
  async syncStart(input: { providers: ChatProvider[]; mode: SyncMode }): Promise<string> {
    await this.ctx.referenceChatHistory.ensureBrowser()
    return this.ctx.referenceChatHistory.sync.start(input.providers, input.mode)
  }
  syncStatus(input: { jobId: string }) { return this.ctx.referenceChatHistory.sync.status(input.jobId) }
  syncCancel(input: { jobId: string }): boolean { return this.ctx.referenceChatHistory.sync.cancel(input.jobId) }
  settingsGet(): SettingsRecord { return this.ctx.referenceChatHistory.getSettings() }
  async settingsUpdate(settings: SettingsRecord) {
    const value = await this.ctx.referenceChatHistory.updateSettings(settings)
    this.ctx.get('referenceLocalAgents')?.setAgentDirectories(value.agentDirectories ?? {})
    return value
  }
  async openDownloadDirectory(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const configured = this.ctx.referenceChatHistory.getSettings().cloudDriveDownloadDirectory
    const path = configured || tmpdir()
    await validateDownloadDirectory(path)
    const child = process.platform === 'win32'
      ? spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' })
      : process.platform === 'darwin'
        ? spawn('open', [path], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [path], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  }
  browse(input: { query: string; provider?: ChatProvider; limit: number; offset: number }, signal: AbortSignal) {
    signal.throwIfAborted()
    return this.ctx.referenceChatHistory.browse(input.query, input.provider, input.limit, input.offset)
  }
  deleteConversation(input: { uriId: string }, signal: AbortSignal) {
    signal.throwIfAborted()
    return this.ctx.referenceChatHistory.remove(input.uriId)
  }
  storageStats() { return { ...this.ctx.referenceChatHistory.storageStats(), systemTempDirectory: tmpdir() } }
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
  openListStatus(signal: AbortSignal) { return this.ctx.openListManager.status(signal) }
  openListInstall(signal: AbortSignal) { return this.ctx.openListManager.install(signal) }
  openListUpgrade(input: { rollback?: boolean }, signal: AbortSignal) { return this.ctx.openListManager.upgrade(input, signal) }
  openListConnectExternal(input: { endpoint: string, username?: string, password?: string, token?: string }, signal: AbortSignal) { return this.ctx.openListManager.connectExternal(input, signal) }
  openListDisconnect(signal: AbortSignal) { return this.ctx.openListManager.disconnect(signal) }
  openListDrivers(signal: AbortSignal) { return this.ctx.openListManager.drivers(signal) }
  openListMounts(signal: AbortSignal) { return this.ctx.openListManager.mounts(signal) }
  openListCreateMount(input: { id?: string, mountPath: string, driver: string, addition: Record<string, unknown>, order?: number, remark?: string }, signal: AbortSignal) { return this.ctx.openListManager.createMount(input, signal) }
  async openListDisableMount(input: { id: string, disabled?: boolean }, signal: AbortSignal): Promise<boolean> { await this.ctx.openListManager.disableMount(input.id, input.disabled ?? true, signal); return true }
  async openListRemoveMount(input: { id: string }, signal: AbortSignal): Promise<boolean> { await this.ctx.openListManager.removeMount(input.id, signal); return true }
  openListReindex(input: { id: string }, signal: AbortSignal) { return this.ctx.openListManager.reindexMount(input.id, signal) }
  localPlugins(signal: AbortSignal) {
    signal.throwIfAborted()
    return resolveLocalPlugins(this.ctx)
  }
}
