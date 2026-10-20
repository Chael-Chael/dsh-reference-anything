import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createElement } from 'react'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { DEFAULT_ENABLED_AGENTS, ALL_LOCAL_AGENTS, ALL_PROVIDERS, defaultPickerSettings, samePickerSettings, pickerSourceSchema, type ChatProvider, type LocalAgent, type PickerSettings, type SettingsRecord } from '../wire.ts'
import { REFERENCE_ANYTHING_REMOTE, type AgentCandidate, type DriveCandidate, type ReferenceAnythingRemoteFace, type SearchResult, type SyncStatus } from './remote.ts'
import { createCloudDriveSource, createCommandSource, createConversationSource, createFileSource, createLocalAgentSource, createPluginSource, createSearchDebounce, createSessionSource, createSkillSource, type RefreshablePickerSource } from './source.ts'
import { ConversationSettings, PAGE_SIZE, type SettingsSnapshot } from './components.tsx'
import {
  adoptMenuGroupTitleProjection, adoptMenuViewportTracking, adoptReferenceIconProjection, adoptSettingsIconProjection, adoptStyles,
} from './styles.ts'
import { createPickerMenuActionGuard, createPickerMenuUpdater } from './menu-update.ts'
import { adoptMenuOpening } from './menu-opening.ts'
import { en, REFERENCE_ANYTHING_NS, zh } from './locale.ts'
import { runSetupSequence, setupReady, type SetupStage } from './health.ts'
import { createAutoDismissNotice } from './notice.ts'
import { filterAgentCandidates, filterDriveCandidates } from './selection.ts'
import { createUpdateSource, SettingsReleaseIntro } from './update-menu.tsx'
import { pickDirectoryWithError } from './directory-picker.ts'
import { registerNativeReferenceText } from './native-reference-text.tsx'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    referenceCandidates: unknown
  }
}

// `ctx.remote.commands` is a separately injected Remote face. Declaring only
// `remote` lets the @ source register, but its candidate request can fail and
// the input-trigger menu then removes the Commands group as a failed source.
export const inject = [
  'inputTriggers', 'remote', 'remote.commands', 'remote.skills', 'remote.fileReferences', 'remote.sessionReferenceResolver',
  'slots', 'locale', 'sessions', 'uiWorkspace', 'sidebarRight', 'uiConversation',
]

export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => adoptMenuOpening(ctx.inputTriggers), 'reference-anything.client.menu-opening')
  ctx.effect(() => adoptSettingsIconProjection(), 'reference-anything.client.settings-icon-projection')
  ctx.effect(() => adoptMenuViewportTracking(), 'reference-anything.client.menu-viewport-tracking')
  ctx.effect(() => adoptReferenceIconProjection(), 'reference-anything.client.icon-projection')
  let remote: ReferenceAnythingRemoteFace | undefined
  const scope = createSnapshotStore<SettingsSnapshot>({
    settings: { opencliPath: 'opencli', profile: '', detailConcurrency: 8, autoSync: false, syncOnStartup: false, autoSyncMinutes: 60, historyMode: 'metadata-only', syncHistoryDays: null, enabledProviders: [...ALL_PROVIDERS], enabledAgents: [...DEFAULT_ENABLED_AGENTS], maxReadTurns: 10, inputRenderMode: 'pill', cloudDriveDownloadDirectory: '' }, loading: true,
  })
  let currentJob = ''
  let lastSyncFinishedAt: string | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let activeConversationSource: RefreshablePickerSource | undefined
  let activeAgentSource: RefreshablePickerSource | undefined
  let agentStatsGeneration = 0
  let activeDriveSource: RefreshablePickerSource | undefined
  let refreshGeneration = 0
  const t = ctx.locale.bind(REFERENCE_ANYTHING_NS)
  const notices = createAutoDismissNotice(() => scope.getSnapshot(), value => { scope.set(value) })
  let applySources: ((picker: PickerSettings | undefined) => void) | undefined
  ctx.effect(() => ctx.locale.register(REFERENCE_ANYTHING_NS, { zh, en }), 'reference-anything.client.dictionaries')
  ctx.effect(() => adoptMenuGroupTitleProjection(t, () => (scope.getSnapshot().settings.picker ?? defaultPickerSettings()).agents), 'reference-anything.client.menu-group-localization')

  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  const refreshOpenList = async (): Promise<void> => {
    if (!remote) return
    try {
      const status = unwrap(await remote.openListStatus())
      scope.set({ ...scope.getSnapshot(), openList: status })
      const [drivers, mounts] = status.mode === undefined ? [undefined, undefined] : await Promise.all([
        remote.openListDrivers().then(unwrap).catch(() => undefined), remote.openListMounts().then(unwrap).catch(() => undefined),
      ])
      const finalStatus = status.mode === undefined ? status : unwrap(await remote.openListStatus())
      const previousMounts = scope.getSnapshot().openListMounts
      scope.set({ ...scope.getSnapshot(), openList: finalStatus, openListDrivers: drivers, openListMounts: mounts })
      const before = previousMounts?.map(mount => `${mount.id}:${mount.name}:${mount.enabled}:${mount.status}`).join('|') ?? ''
      const after = mounts?.map(mount => `${mount.id}:${mount.name}:${mount.enabled}:${mount.status}`).join('|') ?? ''
      if (before !== after) void activeDriveSource?.refreshCachedMenu({ refetch: true })
    } catch (error) {
      scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined })
    }
  }
  const refreshChatImport = async (): Promise<void> => {
    if (!remote) return
    try { const chatImport = unwrap(await remote.chatImportStatus()); scope.set({ ...scope.getSnapshot(), chatImport, chatImportError: undefined }) }
    catch (error) { scope.set({ ...scope.getSnapshot(), chatImportError: message(error) }) }
  }
  const scanningAgents = new Map<LocalAgent, Promise<void>>()
  const rescanAgent = (kind: LocalAgent): Promise<void> => {
    const existing = scanningAgents.get(kind)
    if (existing) return existing
    const activeRemote = remote
    if (!activeRemote) return Promise.reject(new Error(t('menu.updateDisconnected')))
    ++agentStatsGeneration
    const current = scope.getSnapshot()
    const previous = current.agentStats?.find(row => row.agent === kind)
    scope.set({ ...current, agentStats: [...(current.agentStats ?? []).filter(row => row.agent !== kind), { agent: kind, conversations: 0, ...previous, scanning: true }] })
    const pending = (async () => {
      try {
        const rows = unwrap(await activeRemote.agentRescan({ kind }))
        if (remote !== activeRemote) return
        const state = scope.getSnapshot()
        scope.set({ ...state, agentStats: [...(state.agentStats ?? []).filter(row => row.agent !== kind), ...rows] })
        await activeAgentSource?.refreshCachedMenu({ refetch: true })
      } catch (error) {
        const state = scope.getSnapshot()
        scope.set({ ...state, agentStats: state.agentStats?.map(row => row.agent === kind ? { ...row, scanning: false, error: message(error) } : row) })
        throw error
      } finally { scanningAgents.delete(kind); ++agentStatsGeneration }
    })()
    scanningAgents.set(kind, pending)
    return pending
  }
  let backgroundScan: Promise<void> | undefined
  const refreshEnabledAgents = (): Promise<void> => backgroundScan ??= (async () => {
    for (const kind of scope.getSnapshot().settings.enabledAgents) {
      if (!remote) break
      if (!scope.getSnapshot().settings.enabledAgents.includes(kind)) continue
      try { await rescanAgent(kind) } catch { /* Keep each source's error visible and continue. */ }
    }
  })().finally(() => { backgroundScan = undefined })
  const refreshAgentStats = async (): Promise<void> => {
    if (!remote) return
    const generation = agentStatsGeneration
    try { const agentStats = unwrap(await remote.agentStats()); if (generation === agentStatsGeneration) scope.set({ ...scope.getSnapshot(), agentStats }) } catch { /* Optional local-agent source. */ }
    void refreshEnabledAgents()
  }
  /** Refresh settings and local mirror figures without starting OpenCLI. */
  const refreshLocal = async (): Promise<void> => {
    if (!remote) return
    const generation = ++refreshGeneration
    try {
      const [settings, storageResult] = await Promise.all([remote.settingsGet(), remote.storageStats()])
      let stats = scope.getSnapshot().stats
      let statsUnavailable = false
      try { stats = unwrap(await remote.stats()) } catch { statsUnavailable = true }
      if (generation !== refreshGeneration) return
      const currentSettings = unwrap(settings)
      applySources?.(currentSettings.picker)
      scope.set({ ...scope.getSnapshot(), settings: currentSettings, stats, storage: unwrap(storageResult),
        error: statsUnavailable && !stats ? 'Local conversation statistics are unavailable until the DSH host is restarted.' : undefined, loading: false })
      void activeConversationSource?.refreshCachedMenu()
      void refreshOpenList()
      void refreshAgentStats()
      void refreshChatImport()
    } catch (error) {
      if (generation === refreshGeneration) scope.set({ ...scope.getSnapshot(), error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }
  /** Run the explicit OpenCLI viability probes as well as refreshing local data. */
  const refresh = async (): Promise<void> => {
    if (!remote) return
    const generation = ++refreshGeneration
    scope.set({ ...scope.getSnapshot(), loading: true })
    try {
      const [settings, health, storageResult] = await Promise.all([remote.settingsGet(), remote.health(), remote.storageStats()])
      let profiles = scope.getSnapshot().profiles
      try { profiles = unwrap(await remote.profiles()) } catch { /* Profile discovery failure is represented by bridge health. */ }
      let stats = scope.getSnapshot().stats
      let statsUnavailable = false
      try { stats = unwrap(await remote.stats()) } catch { statsUnavailable = true }
      if (generation !== refreshGeneration) return
      const currentSettings = unwrap(settings)
      applySources?.(currentSettings.picker)
      scope.set({ ...scope.getSnapshot(), settings: currentSettings, health: unwrap(health), profiles, stats, storage: unwrap(storageResult),
        error: statsUnavailable && !stats ? 'Local conversation statistics are unavailable until the DSH host is restarted.' : undefined, loading: false })
      quickHealthError = undefined
      quickHealthCheckedAt = Date.now()
      fullHealthCheckedAt = quickHealthCheckedAt
      void activeConversationSource?.refreshCachedMenu()
      void refreshOpenList()
      void refreshAgentStats()
      void refreshChatImport()
    } catch (error) {
      if (generation === refreshGeneration) scope.set({ ...scope.getSnapshot(), error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }
  let quickHealthPending = false
  let quickHealthCheckedAt = 0
  let fullHealthCheckedAt = 0
  let quickHealthError: string | undefined
  const quickRefreshOnOpen = async (full = false): Promise<void> => {
    // Keep full-check update diagnostics from being overwritten by a quick probe.
    full ||= fullHealthCheckedAt > 0
    if (!remote || quickHealthPending || (full ? Date.now() - fullHealthCheckedAt < 300_000 : Date.now() - quickHealthCheckedAt < 30_000)) return
    const settings = scope.getSnapshot().settings
    if (!(settings.picker ?? defaultPickerSettings()).conversations.enabled) return
    quickHealthPending = true
    quickHealthError = undefined
    void activeConversationSource?.refreshCachedMenu()
    const activeRemote = remote
    try {
      const health = unwrap(await (full ? activeRemote.health(AbortSignal.timeout(15_000)) : activeRemote.quickHealth(AbortSignal.timeout(15_000))))
      if (remote !== activeRemote) return
      scope.set({ ...scope.getSnapshot(), health })
    } catch (error) {
      if (remote !== activeRemote) return
      quickHealthError = message(error)
      scope.set({ ...scope.getSnapshot(), error: quickHealthError })
    }
    finally {
      quickHealthPending = false
      quickHealthCheckedAt = Date.now()
      if (full) fullHealthCheckedAt = quickHealthCheckedAt
      void activeConversationSource?.refreshCachedMenu()
    }
  }
  /**
   * Re-read provider statistics only.
   *
   * Deliberately not `refresh()`: that also probes OpenCLI health, which
   * spawns several processes, and this runs on a timer while the panel is open.
   * A failure leaves the last known figures rather than replacing the panel
   * with an error — the next tick tries again.
   */
  // These defer rapid typing but deliberately retain no prior search rows.
  const conversationSearch = createSearchDebounce<SearchResult>()
  const agentSearch = createSearchDebounce<AgentCandidate>()
  const driveSearch = createSearchDebounce<DriveCandidate>()
  const refreshStats = async (): Promise<void> => {
    if (!remote) return
    try {
      const previous = scope.getSnapshot().stats
      const stats = unwrap(await remote.stats())
      const changed = !previous || stats.length !== previous.length || stats.some((row, index) => {
        const before = previous[index]
        return !before || row.provider !== before.provider || row.conversations !== before.conversations || row.lastSyncedAt !== before.lastSyncedAt
      })
      const storage = changed ? unwrap(await remote.storageStats()) : scope.getSnapshot().storage
      scope.set({ ...scope.getSnapshot(), stats, storage })
    } catch { /* keep showing the last known statistics */ }
  }
  const browse = async (query: string, provider: ChatProvider | undefined, offset: number): Promise<void> => {
    if (!remote) return
    try {
      const page = unwrap(await remote.browse({ query, ...(provider ? { provider } : {}), limit: PAGE_SIZE, offset }))
      scope.set({ ...scope.getSnapshot(), browse: { query, provider, offset, page }, error: undefined })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  const deleteConversation = async (uriId: string): Promise<void> => {
    if (!remote) return
    try {
      unwrap(await remote.deleteConversation({ uriId }))
      const current = scope.getSnapshot().browse
      await browse(current?.query ?? '', current?.provider, current?.offset ?? 0)
      await refreshStats()
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  const pollJob = async (): Promise<void> => {
    if (!remote || !currentJob) return
    try {
      const status = unwrap(await remote.syncStatus({ jobId: currentJob }))
      if (status) {
        scope.set({ ...scope.getSnapshot(), sync: status })
        void activeConversationSource?.refreshCachedMenu()
      }
      if (!status || status.status !== 'running') {
        if (status) lastSyncFinishedAt = new Date().toISOString()
        if (poll) clearInterval(poll)
        poll = undefined
        await refreshLocal()
        const current = scope.getSnapshot().browse
        if (current) await browse(current.query, current.provider, current.offset)
        await activeConversationSource?.refreshCachedMenu({ refetch: true })
      }
    } catch (error) {
      if (poll) clearInterval(poll); poll = undefined
      scope.set({ ...scope.getSnapshot(), error: message(error) })
    }
  }

  /** Read the Host's startup update check without delaying local settings. */
  const refreshUpdateStatus = async (): Promise<void> => {
    const activeRemote = remote
    if (!activeRemote) return
    try {
      const update = unwrap(await activeRemote.updateStatus())
      if (remote === activeRemote) {
        if (update.updateAvailable) notices.show(t('notice.updateAvailable', { version: update.latestVersion }), { update })
        else scope.set({ ...scope.getSnapshot(), update })
      }
    } catch { /* Update checks are advisory; the manual button can retry. */ }
  }

  ctx.effect(async () => {
    const dispose = await ctx.remote.$mount(REFERENCE_ANYTHING_REMOTE)
    remote = (ctx.reflect as unknown as { get(name: string): unknown }).get('remote.referenceAnything') as ReferenceAnythingRemoteFace | undefined
    if (!remote) throw new Error('referenceAnything Remote did not mount')
    await refreshLocal()
    void quickRefreshOnOpen()
    void refreshUpdateStatus()
    return () => { remote = undefined; if (poll) clearInterval(poll); void dispose() }
  }, 'reference-anything.client.remote')

  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const sessions = (ctx as unknown as { sessions: ISessions }).sessions
  const filePreview = { sessions, openResource: (address: string) => {
    (ctx as unknown as { sidebarRight: { openResource(address: string): void } }).sidebarRight.openResource(address)
  } }
  // Native Desktop drops/pastes keep this owner even when file candidates are hidden.
  const nativeReference = createFileSource(async () => [], t, undefined, filePreview)
  ctx.effect(() => inputTriggers.registerSource({
    trigger: '@', name: 'reference', candidates: async () => [], onPick: () => undefined,
    codec: nativeReference.codec, openReference: nativeReference.openReference,
  }), 'reference-anything.client.native-reference')
  registerNativeReferenceText(ctx, (sessionId, path) => {
    nativeReference.openReference!({ sessionId }, { ref: `@${path}`, appearance: 'file' })
  }, t)
  const referenceCandidates = <T,>(sessionId: SessionId, signal: AbortSignal, lookup: () => Promise<T>): Promise<T> => {
    if (sessions.binding(sessionId) === undefined) throw new Error(`reference candidates require a retained session "${sessionId}"`)
    return sessions.using(sessionId, { source: 'referenceCandidates', signal }, async reference => {
      signal.throwIfAborted()
      const state = reference.binding.session.getSnapshot()
      if (state.openState !== 'open') throw state.openError ?? new Error(`session "${sessionId}" is not open`)
      const result = await lookup()
      signal.throwIfAborted()
      return result
    })
  }
  const updateMenu = createPickerMenuUpdater(inputTriggers, sessions)
  const guardMenuActions = createPickerMenuActionGuard(inputTriggers, sessions)
  const installPackageUpdate = async () => {
    if (!remote) throw new Error(t('menu.updateDisconnected'))
    const result = unwrap(await remote.installUpdate())
    const update = unwrap(await remote.updateStatus())
    notices.show(t(result.restartRequired ? 'notice.updateInstalled' : 'notice.upToDate', { version: result.version }), { update, error: undefined })
    return result
  }
  ctx.effect(() => {
    const source = createUpdateSource(async () => {
      const activeRemote = remote
      if (!activeRemote) return undefined
      const previous = scope.getSnapshot().update
      const update = unwrap(await (previous && Date.now() - previous.checkedAt >= 3_600_000
        ? activeRemote.checkUpdate() : activeRemote.updateStatus()))
      if (remote !== activeRemote) return undefined
      scope.set({ ...scope.getSnapshot(), update })
      return update
    }, installPackageUpdate, updateMenu, t, ctx.locale)
    const unregister = inputTriggers.registerSource(source)
    return () => { unregister(); source.dispose() }
  }, 'reference-anything.client.update-menu')
  let sourceDisposers: Array<() => void> = []
  let appliedPicker: PickerSettings | undefined
  const registerSources = (picker: PickerSettings) => {
    const shortcuts: Record<string, Array<Exclude<keyof PickerSettings, 'displayMode'>>> = {}
    const sourceAliasTargets: Partial<Record<Exclude<keyof PickerSettings, 'displayMode'>, Record<string, string>>> = {}
    for (const key of pickerSourceSchema.options) {
      const sourceAliases = picker[key].sourceAliases ?? {}
      const defaultSourceAliases = key === 'conversations'
        ? Object.fromEntries(ALL_PROVIDERS.map(provider => [provider, [provider]]))
        : key === 'agents'
          ? Object.fromEntries(ALL_LOCAL_AGENTS.map(agent => [agent, [agent, ...({ 'claude-code': ['cc'], kimi: ['kimi-cli', 'kimi-code'], grokbuild: ['grok-build'], mimocode: ['mimo'] } as Partial<Record<string, string[]>>)[agent] ?? []]]))
          : key === 'drives'
            ? Object.fromEntries((scope.getSnapshot().openListMounts ?? []).map(mount => [mount.name, [mount.name]]))
            : {}
      const effectiveSourceAliases = Object.fromEntries(Object.entries({ ...defaultSourceAliases, ...sourceAliases })
        .map(([target, aliases]) => [target, [...new Set([...(defaultSourceAliases[target as keyof typeof defaultSourceAliases] ?? []), ...aliases])]]))
      sourceAliasTargets[key] = Object.fromEntries(Object.entries(effectiveSourceAliases).flatMap(([target, aliases]) => aliases.map(alias => [alias.trim().toLocaleLowerCase(), target])))
      const aliases = [
        ...(picker[key].shortcut
          ? picker[key].shortcut.split(',')
          : (picker[key].aliases ?? defaultPickerSettings()[key].aliases ?? [])),
        ...Object.values(effectiveSourceAliases).flat(),
      ]
      for (const alias of aliases) {
        const normalized = alias.trim().toLocaleLowerCase()
        if (!normalized) continue
        const scopes = shortcuts[normalized] ?? (shortcuts[normalized] = [])
        if (!scopes.includes(key)) scopes.push(key)
      }
    }
    const optionsFor = (key: Exclude<keyof PickerSettings, 'displayMode'>) => ({
      order: picker[key].order,
      sort: picker[key].sort,
      limit: picker[key].limit,
      maxCandidates: picker[key].maxCandidates,
      shortcut: undefined,
      shortcuts,
      ...(key === 'agents' || key === 'conversations' ? { sourceAliasTargets: sourceAliasTargets[key] } : {}),
      displayMode: picker.displayMode,
      updateMenu,
      guardMenuActions,
    })
    const source = createConversationSource((query, provider, signal, limit) =>
      conversationSearch.run(query, signal, async () => {
        // Re-read after the debounce: the Remote can unmount with its scope.
        if (!remote) return []
        void quickRefreshOnOpen(true)
        return unwrap(await remote.search({ query, ...(provider ? { provider } : {}), limit }, signal))
      }), t, optionsFor('conversations'), {
        health: () => scope.getSnapshot().health,
        healthCheck: () => ({ pending: quickHealthPending, error: quickHealthError }),
        sync: () => startSync(scope.getSnapshot().settings.enabledProviders, 'incremental'),
        status: () => scope.getSnapshot().sync,
        lastSyncedAt: () => lastSyncFinishedAt ?? scope.getSnapshot().stats
          ?.map(row => row.lastSyncedAt).filter(Boolean)
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0],
        lastSourceResult: () => {
          const snapshot = scope.getSnapshot()
          if (snapshot.sync) return undefined
          const enabled = snapshot.settings.enabledProviders
          const stats = new Map(snapshot.stats?.map(row => [row.provider, row]))
          return {
            success: enabled.filter(provider => {
              const row = stats.get(provider)
              return row !== undefined && row.status !== 'error' && Boolean(row.lastSyncedAt)
            }).length,
            total: enabled.length,
          }
        },
      })
    activeConversationSource = source
    const disposers: Array<() => void> = []
    if (picker.conversations.enabled) disposers.push(inputTriggers.registerSource(source))
    if (picker.commands.enabled) disposers.push(inputTriggers.registerSource(createCommandSource(async (sessionId, signal) => { signal.throwIfAborted(); return unwrap(await ctx.remote.commands.list(sessionId)) }, t, optionsFor('commands'))))
    if (picker.skills.enabled) disposers.push(inputTriggers.registerSource(createSkillSource(async (sessionId, signal) => {
        const result = await ctx.remote.skills.list({ sessionId }, signal)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value.skills
      }, t, optionsFor('skills'))))
    if (picker.files.enabled) disposers.push(inputTriggers.registerSource(createFileSource(async (sessionId, query, signal) => {
      const result = await referenceCandidates(sessionId, signal, () => ctx.remote.fileReferences.list(sessionId, query, signal))
      return result.ok ? result.value : []
    }, t, optionsFor('files'), filePreview)))
    if (picker.sessions.enabled) disposers.push(inputTriggers.registerSource(createSessionSource(async (sessionId, query, signal) => {
      const result = await referenceCandidates(sessionId, signal, () => ctx.remote.sessionReferenceResolver.candidates(sessionId, query, signal))
      return result.ok ? result.value : []
    }, t, optionsFor('sessions'), sessions)))
    activeAgentSource = undefined
    if (picker.agents.enabled) {
      const source = createLocalAgentSource((sessionId, query, signal, limit, kind) =>
      agentSearch.run(query, signal, async () => {
        // Re-read after the debounce, as the conversation source does above.
        if (!remote) return []
        const rows = filterAgentCandidates(
          unwrap(await remote.agentSearch(sessionId, { query, limit: 100, ...(kind ? { kind } : {}) }, signal)),
          scope.getSnapshot().settings.enabledAgents,
        )
        return [...rows.filter(row => row.warning !== undefined), ...rows.filter(row => row.warning === undefined).slice(0, limit)]
      }), t, optionsFor('agents'), async (sessionId, id) => {
        if (!remote?.agentImport) throw new Error(t('agent.importUnavailable'))
        const importedId = unwrap(await remote.agentImport(sessionId, { id }))
        ctx.uiWorkspace.openSession(importedId as SessionId)
      }, async (sessionId, id, span) => {
        if (!remote?.agentResume) throw new Error(t('agent.importUnavailable'))
        const summary = unwrap(await remote.agentResume(sessionId, { id }))
        const sessions = ctx.sessions as unknown as ISessions
        const actx = sessions.scope(sessionId)
        if (!actx || actx.bail(actx, 'slash/input-insert-text', { text: summary, span }) !== true) {
          throw new Error(t('agent.draftChanged'))
        }
      }, picker.agents, {
        status: async () => remote ? unwrap(await remote.chatImportStatus()) : undefined,
        upgrade: async () => {
          if (!remote) throw new Error(t('menu.updateDisconnected'))
          const chatImport = unwrap(await remote.chatImportUpgradeInstall())
          scope.set({ ...scope.getSnapshot(), chatImport, chatImportError: undefined })
          notices.show(t(`chatImport.${chatImport.state}`, { version: chatImport.version }))
        },
      })
      activeAgentSource = source
      disposers.push(inputTriggers.registerSource(source))
    }
    if (picker.drives.enabled) {
      const source = createCloudDriveSource((query, signal, limit) =>
        driveSearch.run(query, signal, async () => {
        // Re-read after the debounce, as the two sources above do.
        if (!remote) return []
        return filterDriveCandidates(
          unwrap(await remote.driveSearch({ query, limit: 100 }, signal)),
          scope.getSnapshot().settings.enabledDriveMounts,
        ).slice(0, limit)
        }), t, optionsFor('drives'))
      activeDriveSource = source
      disposers.push(inputTriggers.registerSource(source))
    }
    if (picker.plugins.enabled) {
      disposers.push(inputTriggers.registerSource(createPluginSource(async (signal) => {
        if (!remote) return []
        return unwrap(await remote.localPlugins(signal)).filter(row =>
          (!picker.plugins.onlyLive || row.status === 'live') &&
          (picker.plugins.showDeepSeek || !row.name.toLowerCase().startsWith('@deepseek-ai/')))
      }, t, optionsFor('plugins'))))
    }
    return disposers
  }
  const refreshStorage = async (): Promise<void> => {
    if (!remote) return
    scope.set({ ...scope.getSnapshot(), storage: unwrap(await remote.storageStats()) })
  }
  const clearProvider = async (provider: ChatProvider): Promise<void> => {
    if (!remote) return
    try {
      const count = unwrap(await remote.clearProvider({ provider }))
      await Promise.all([refreshStats(), refreshStorage()])
      const current = scope.getSnapshot().browse
      if (current) await browse(current.query, current.provider, 0)
      notices.show(t('notice.cleared', { count }), { error: undefined })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  applySources = (picker) => {
    const next = picker ?? defaultPickerSettings()
    // Settings unrelated to the @ picker (for example Auto sync) use the
    // same save endpoint. Re-registering every input source for those saves
    // can dispose UI-owned registrations while the settings panel is still
    // rendering, leaving the panel blank. Only rebuild when picker behavior
    // actually changed.
    if (appliedPicker !== undefined && samePickerSettings(appliedPicker, next)) return
    for (const dispose of sourceDisposers) dispose()
    activeConversationSource = undefined
    activeDriveSource = undefined
    sourceDisposers = registerSources(next)
    appliedPicker = next
  }
  applySources(undefined)
  ctx.effect(() => () => { for (const dispose of sourceDisposers) dispose() }, 'reference-anything.client.sources')

  const save = async (settings: SettingsRecord): Promise<boolean> => {
    if (!remote) return false
    try {
      const before = scope.getSnapshot().settings
      const value = unwrap(await remote.settingsUpdate(settings))
      applySources?.(value.picker)
      notices.show(t('notice.settingsSaved'), { settings: value, error: undefined })
      for (const kind of value.enabledAgents) {
        if (!before.enabledAgents.includes(kind) || before.agentDirectories?.[kind] !== value.agentDirectories?.[kind]) void rescanAgent(kind).catch(() => {})
      }
      return true
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }); return false }
  }
  const setSetupStep = (setupStep: SetupStage) => { scope.set({ ...scope.getSnapshot(), setupStep }) }
  const clearRemoteMissing = async (): Promise<void> => {
    if (!remote) return
    try {
      const count = unwrap(await remote.clearRemoteMissing())
      await Promise.all([refreshStats(), refreshStorage()])
      const current = scope.getSnapshot().browse
      if (current) await browse(current.query, current.provider, 0)
      notices.show(t('notice.cleared', { count }), { error: undefined })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  const clearOldAccounts = async (): Promise<void> => {
    if (!remote) return
    try {
      const count = unwrap(await remote.clearOldAccounts())
      await Promise.all([refreshStats(), refreshStorage()])
      const current = scope.getSnapshot().browse
      if (current) await browse(current.query, current.provider, 0)
      notices.show(t('notice.cleared', { count }), { error: undefined })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  ctx.effect(() => () => { notices.dispose() }, 'reference-anything.client.settings-notice')
  const startSync = async (providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void> => {
    if (!remote) return
    try {
      currentJob = unwrap(await remote.syncStart({ providers, mode }))
      const initial: SyncStatus = {
        jobId: currentJob, status: 'running', providers, completed: 0, total: 0,
        providerProgress: providers.map(provider => ({ provider, phase: 'listing', completed: 0, total: 0 })),
      }
      scope.set({ ...scope.getSnapshot(), sync: initial, error: undefined, notice: undefined })
      void activeConversationSource?.refreshCachedMenu()
      if (poll) clearInterval(poll); poll = setInterval(() => { void pollJob() }, 1_000); await pollJob()
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  const runOpenListOperation = async (state: 'downloading' | 'upgrade', call: () => ReturnType<ReferenceAnythingRemoteFace['openListInstall']>): Promise<void> => {
    const previous = scope.getSnapshot().openList
    scope.set({ ...scope.getSnapshot(), openList: { state, installed: previous?.installed ?? false, supportsRollback: previous?.supportsRollback ?? false, upgradeAvailable: previous?.upgradeAvailable ?? false, ...(previous?.newerVersion === undefined ? {} : { newerVersion: previous.newerVersion }), ...(previous?.mode === undefined ? {} : { mode: previous.mode }), ...(previous?.version === undefined ? {} : { version: previous.version }) } })
    const pollStatus = setInterval(() => { void refreshOpenList() }, 2_000)
    try { unwrap(await call()) } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) } finally { clearInterval(pollStatus); await refreshOpenList() }
  }
  const shownReleases = new Set<string>()
  const ReferenceSettings = (props: Parameters<typeof ConversationSettings>[0]) => createElement(ConversationSettings, {
    ...props,
    releaseIntro: createElement(SettingsReleaseIntro, { useScope: props.useScope, shown: shownReleases, install: installPackageUpdate, t: props.t, locale: ctx.locale }),
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'reference-anything', order: 56, label: () => t('settings.title'), locale: REFERENCE_ANYTHING_NS,
    inject: () => ({
      hooks: { scope }, close: () => undefined, save, sync: startSync, refresh, quickRefreshOnOpen,
      browse, deleteConversation, clearProvider, clearRemoteMissing, clearOldAccounts, refreshStats,
      refreshOpenList, refreshChatImport,
      rescanAgent,
      upgradeChatImport: async () => {
        try {
          if (!remote) throw new Error(t('menu.updateDisconnected'))
          scope.set({ ...scope.getSnapshot(), chatImportError: undefined })
          const chatImport = unwrap(await remote.chatImportUpgradeInstall())
          scope.set({ ...scope.getSnapshot(), chatImport, chatImportError: undefined })
        } catch (error) { scope.set({ ...scope.getSnapshot(), chatImportError: message(error) }) }
      },
      pickAgentDirectory: async (agent: LocalAgent) => {
        const path = await pickDirectoryWithError(ctx.uiWorkspace, error => { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) })
        if (!path) return
        const settings = scope.getSnapshot().settings
        if (await save({ ...settings, agentDirectories: { ...(settings.agentDirectories ?? {}), [agent]: path } })) await refreshAgentStats()
      },
      pickCloudDriveDownloadDirectory: () => pickDirectoryWithError(ctx.uiWorkspace, error => {
        scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined })
      }),
      openCloudDriveDownloadDirectory: async () => {
        try { if (remote) unwrap(await remote.openDownloadDirectory()) }
        catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      openListInstall: async () => { if (!remote) return; await runOpenListOperation('downloading', () => remote!.openListInstall()) },
      openListUpgrade: async (rollback = false) => { if (!remote) return; await runOpenListOperation(!rollback && scope.getSnapshot().openList?.upgradeAvailable ? 'upgrade' : 'downloading', () => remote!.openListUpgrade({ rollback })) },
      openListConnectExternal: async (input: { endpoint: string; username?: string; password?: string; token?: string }) => { if (!remote) return; try { unwrap(await remote.openListConnectExternal(input)); await refreshOpenList() } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }); throw error } },
      openListDisconnect: async () => { if (!remote) return; try { unwrap(await remote.openListDisconnect()); await refreshOpenList() } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }); throw error } },
      openListCreateMount: async (input: { id?: string; mountPath: string; driver: string; addition: Record<string, unknown> }) => { if (!remote) return; try { unwrap(await remote.openListCreateMount(input)) } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }); throw error } finally { await refreshOpenList() } },
      openListDisableMount: async (id: string, disabled = true) => { if (!remote) return; try { unwrap(await remote.openListDisableMount({ id, disabled })) } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }); throw error } finally { await refreshOpenList() } },
      openListRemoveMount: async (id: string) => { if (!remote) return; try { unwrap(await remote.openListRemoveMount({ id })) } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }); throw error } finally { await refreshOpenList() } },
      openListReindex: async (id: string) => { if (!remote) return { supported: false }; try { const result = unwrap(await remote.openListReindex({ id })); await refreshOpenList(); return result } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }); return { supported: false } } },
      checkUpdate: async () => {
        try {
          if (!remote) return
          const update = unwrap(await remote.checkUpdate())
          notices.show(update.updateAvailable ? t('notice.updateAvailable', { version: update.latestVersion }) : t('notice.upToDate', { version: update.currentVersion }), { update, error: undefined })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      installUpdate: async () => {
        try { await installPackageUpdate() }
        catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      setupAll: async (extensionPageOpened: boolean) => {
        if (!remote) return
        try {
          scope.set({ ...scope.getSnapshot(), error: undefined, notice: undefined, setupStep: 'checking' })
          const activeRemote = remote
          const health = await runSetupSequence({
            health: () => scope.getSnapshot().health,
            refresh,
            discoverOpenCli: async () => unwrap(await activeRemote.discoverOpenCli()),
            selectOpenCli: async executable => {
              const settings = scope.getSnapshot().settings
              unwrap(await activeRemote.settingsUpdate({ ...settings, opencliPath: executable }))
            },
            installOpenCli: async () => { unwrap(await activeRemote.installOpenCli()) },
            installAdapter: async () => { unwrap(await activeRemote.installAdapter()) },
            restartDaemon: async () => { unwrap(await activeRemote.restartDaemon()) },
            stage: setSetupStep,
          })
          if (!health?.version || !health.opencliCompatible) throw new Error(t('settings.opencliStillUnavailable'))
          if (setupReady(health)) {
            notices.show(t('notice.setupComplete'), { error: undefined, setupStep: 'complete' })
          } else if (health?.extensionConnected && !health.connectivityOk) {
            scope.set({ ...scope.getSnapshot(), error: t('settings.connectivityStillUnavailable'), notice: undefined, setupStep: undefined })
          } else if (!health?.extensionConnected) {
            notices.show(extensionPageOpened ? t('notice.oneClickSetup') : t('notice.extensionStoreBlocked'), { error: undefined, setupStep: 'extension' })
          } else {
            scope.set({ ...scope.getSnapshot(), error: t('settings.setupIncomplete'), notice: undefined, setupStep: undefined })
          }
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), setupStep: undefined }) }
      },
      discoverOpenCli: async () => {
        try {
          if (!remote) return
          const discovery = unwrap(await remote.discoverOpenCli())
          if (!discovery.found) throw new Error(discovery.error || t('settings.opencliNotFound'))
          const settings = scope.getSnapshot().settings
          unwrap(await remote.settingsUpdate({ ...settings, opencliPath: discovery.executable }))
          await refresh()
          notices.show(t('notice.opencliFound', { version: discovery.version }), { error: undefined })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      installOpenCli: async () => {
        try {
          if (!remote) return
          const discovery = unwrap(await remote.installOpenCli())
          await refresh()
          const health = scope.getSnapshot().health
          if (!health?.version || !health.opencliCompatible) throw new Error(t('settings.opencliStillUnavailable'))
          notices.show(t('notice.opencliInstalled', { version: discovery.version }), { error: undefined })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      useProfile: async (profile: string) => {
        try {
          if (!remote) return
          const settings = scope.getSnapshot().settings
          unwrap(await remote.settingsUpdate({ ...settings, profile }))
          await refresh()
          const health = scope.getSnapshot().health
          if (!health?.extensionConnected) throw new Error(t('settings.profileStillUnavailable'))
          notices.show(t('notice.profileSelected'), { error: undefined })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      install: async () => {
        try {
          if (!remote) return
          unwrap(await remote.installAdapter()); await refresh()
          const health = scope.getSnapshot().health
          if (!health?.pluginInstalled || !health.adapterCompatible) throw new Error(t('settings.adapterStillUnavailable'))
          notices.show(t('notice.adapterInstalled'), { error: undefined })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      restartDaemon: async () => {
        try {
          if (!remote) return
          unwrap(await remote.restartDaemon()); await refresh()
          const health = scope.getSnapshot().health
          if (!health?.daemonRunning || health.daemonStale) throw new Error(t('settings.daemonStillUnavailable'))
          notices.show(t('notice.daemonRestarted'), { error: undefined })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      cancel: async () => { try { if (remote && currentJob) unwrap(await remote.syncCancel({ jobId: currentJob })); await pollJob() } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) } },
    } as never),
  }, ReferenceSettings))
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }








