import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type ClientContext, type ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { ALL_LOCAL_AGENTS, ALL_PROVIDERS, defaultPickerSettings, samePickerSettings, type ChatProvider, type PickerSettings, type SettingsRecord } from '../wire.ts'
import { REFERENCE_ANYTHING_REMOTE, type AgentCandidate, type DriveCandidate, type ReferenceAnythingRemoteFace, type SearchResult, type SyncStatus } from './remote.ts'
import { createCloudDriveSource, createCommandSource, createConversationSource, createFileSource, createLocalAgentSource, createSearchDebounce, createSessionSource, createSkillSource, type RefreshablePickerSource } from './source.ts'
import { ConversationSettings, PAGE_SIZE, type SettingsSnapshot } from './components.tsx'
import {
  adoptMenuGroupTitleProjection, adoptMenuViewportTracking, adoptReferenceIconProjection, adoptStyles,
} from './styles.ts'
import { createPickerMenuActionGuard, createPickerMenuUpdater } from './menu-update.ts'
import { en, REFERENCE_ANYTHING_NS, zh } from './locale.ts'
import { runSetupSequence, setupReady, type SetupStage } from './health.ts'
import { createAutoDismissNotice } from './notice.ts'
import { filterAgentCandidates, filterDriveCandidates } from './selection.ts'

// `ctx.remote.commands` is a separately injected Remote face. Declaring only
// `remote` lets the @ source register, but its candidate request can fail and
// the input-trigger menu then removes the Commands group as a failed source.
export const inject = [
  'inputTriggers', 'remote', 'remote.commands', 'remote.fileReferences', 'remote.sessionReferenceResolver',
  'slots', 'connection', 'locale', 'sessions',
]

export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => adoptMenuViewportTracking(), 'reference-anything.client.menu-viewport-tracking')
  ctx.effect(() => adoptReferenceIconProjection(), 'reference-anything.client.icon-projection')
  let remote: ReferenceAnythingRemoteFace | undefined
  const scope = createSnapshotStore<SettingsSnapshot>({
    settings: { opencliPath: 'opencli', profile: '', detailConcurrency: 8, autoSync: false, syncOnStartup: false, autoSyncMinutes: 60, historyMode: 'metadata-only', enabledProviders: [...ALL_PROVIDERS], enabledAgents: [...ALL_LOCAL_AGENTS], maxReadTurns: 10, inputRenderMode: 'pill' }, loading: true,
  })
  let currentJob = ''
  let lastSyncFinishedAt: string | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let activeConversationSource: RefreshablePickerSource | undefined
  let activeDriveSource: RefreshablePickerSource | undefined
  let refreshGeneration = 0
  const t = ctx.locale.bind(REFERENCE_ANYTHING_NS)
  const notices = createAutoDismissNotice(() => scope.getSnapshot(), value => { scope.set(value) })
  let applySources: ((picker: PickerSettings | undefined) => void) | undefined
  ctx.effect(() => ctx.locale.register(REFERENCE_ANYTHING_NS, { zh, en }), 'reference-anything.client.dictionaries')
  ctx.effect(() => adoptMenuGroupTitleProjection(t), 'reference-anything.client.menu-group-localization')

  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  const refreshOpenList = async (): Promise<void> => {
    if (!remote) return
    try {
      const status = unwrap(await remote.openListStatus())
      const [drivers, mounts] = status.mode === undefined ? [undefined, undefined] : await Promise.all([
        remote.openListDrivers().then(unwrap).catch(() => undefined), remote.openListMounts().then(unwrap).catch(() => undefined),
      ])
      const finalStatus = status.mode === undefined ? status : unwrap(await remote.openListStatus())
      const previousMounts = scope.getSnapshot().openListMounts
      scope.set({ ...scope.getSnapshot(), openList: finalStatus, openListDrivers: drivers, openListMounts: mounts })
      const before = previousMounts?.map(mount => `${mount.id}:${mount.name}:${mount.enabled}:${mount.status}`).join('|') ?? ''
      const after = mounts?.map(mount => `${mount.id}:${mount.name}:${mount.enabled}:${mount.status}`).join('|') ?? ''
      if (before !== after) void activeDriveSource?.refreshCachedMenu({ refetch: true })
    } catch { /* the normal settings panel remains available if OpenList is absent */ }
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
      void refreshOpenList()
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
      void refreshOpenList()
    } catch (error) {
      if (generation === refreshGeneration) scope.set({ ...scope.getSnapshot(), error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }
  let quickHealthAttempted = false
  const quickRefreshOnOpen = async (): Promise<void> => {
    if (!remote || quickHealthAttempted) return
    const settings = scope.getSnapshot().settings
    if (!(settings.picker ?? defaultPickerSettings()).conversations.enabled) return
    quickHealthAttempted = true
    try {
      const health = unwrap(await remote.quickHealth())
      scope.set({ ...scope.getSnapshot(), health })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
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
    void refreshUpdateStatus()
    return () => { remote = undefined; if (poll) clearInterval(poll); void dispose() }
  }, 'reference-anything.client.remote')

  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const sessions = (ctx as unknown as { sessions: ISessions }).sessions
  const updateMenu = createPickerMenuUpdater(inputTriggers, sessions)
  const guardMenuActions = createPickerMenuActionGuard(inputTriggers, sessions)
  const connection = ctx.get('connection') as ConnectionHandle
  let sourceDisposers: Array<() => void> = []
  let appliedPicker: PickerSettings | undefined
  const registerSources = (picker: PickerSettings) => {
    const optionsFor = (key: Exclude<keyof PickerSettings, 'displayMode'>) => ({
      order: picker[key].order,
      limit: picker[key].limit,
      maxCandidates: picker[key].maxCandidates,
      displayMode: picker.displayMode,
      updateMenu,
      guardMenuActions,
    })
    const source = createConversationSource((query, provider, signal, limit) =>
      conversationSearch.run(query, signal, async () => {
        // Re-read after the debounce: the Remote can unmount with its scope.
        if (!remote) return []
        return unwrap(await remote.search({ query, ...(provider ? { provider } : {}), limit }, signal))
      }), t, optionsFor('conversations'), {
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
        const { result } = await connection.api.skills.list({ sessionId }, signal)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value.skills
      }, t, optionsFor('skills'))))
    if (picker.files.enabled) disposers.push(inputTriggers.registerSource(createFileSource(async (sessionId, query, signal) => {
      const result = await ctx.remote.fileReferences.list(sessionId, query, signal)
      return result.ok ? result.value : []
    }, t, optionsFor('files'))))
    if (picker.sessions.enabled) disposers.push(inputTriggers.registerSource(createSessionSource(async (sessionId, query, signal) => {
      const result = await ctx.remote.sessionReferenceResolver.candidates(sessionId, query, signal)
      return result.ok ? result.value : []
    }, t, optionsFor('sessions'))))
    if (picker.agents.enabled) disposers.push(inputTriggers.registerSource(createLocalAgentSource((sessionId, query, signal, limit) =>
      agentSearch.run(query, signal, async () => {
        // Re-read after the debounce, as the conversation source does above.
        if (!remote) return []
        return filterAgentCandidates(
          unwrap(await remote.agentSearch(sessionId, { query, limit: 100 }, signal)),
          scope.getSnapshot().settings.enabledAgents,
        ).slice(0, limit)
      }), t, optionsFor('agents'))))
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
  const clearOlder = async (days: number): Promise<void> => {
    if (!remote) return
    try {
      const count = unwrap(await remote.clearOlder({ days }))
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

  const save = async (settings: SettingsRecord): Promise<void> => {
    if (!remote) return
    try {
      const value = unwrap(await remote.settingsUpdate(settings))
      applySources?.(value.picker)
      notices.show(t('notice.settingsSaved'), { settings: value, error: undefined })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
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
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'reference-anything', order: 56, label: () => t('settings.title'), locale: REFERENCE_ANYTHING_NS,
    inject: () => ({
      hooks: { scope }, close: () => undefined, save, sync: startSync, refresh, quickRefreshOnOpen,
      browse, deleteConversation, clearProvider, clearOlder, clearRemoteMissing, clearOldAccounts, refreshStats,
      refreshOpenList,
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
        try {
          if (!remote) return
          const result = unwrap(await remote.installUpdate())
          const previous = scope.getSnapshot().update
          const update = {
            currentVersion: result.version, latestVersion: result.version, updateAvailable: false, checkedAt: Date.now(),
          }
          notices.show(result.restartRequired ? t('notice.updateInstalled', { version: result.version }) : t('notice.upToDate', { version: previous?.currentVersion || result.version }), { update, error: undefined })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
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
  }, ConversationSettings))
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
