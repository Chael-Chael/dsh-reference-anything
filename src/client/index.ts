import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { ALL_PROVIDERS, defaultPickerSettings, samePickerSettings, type ChatProvider, type InputRenderMode, type PickerSettings, type SettingsRecord } from '../wire.ts'
import { REFERENCE_ANYTHING_REMOTE, type ReferenceAnythingRemoteFace, type SearchResult, type SessionCandidate, type SyncStatus } from './remote.ts'
import { COMMAND_SOURCE, CONVERSATION_SOURCE, FILE_SOURCE, SESSION_SOURCE, SKILL_SOURCE, createCommandSource, createConversationSource, createSearchDebounce, createSessionSource, createSkillSource, createWorkspaceSource } from './source.ts'
import { ConversationSettings, PAGE_SIZE, type SettingsSnapshot } from './components.tsx'
import { adoptAdaptiveChipCaret, adoptAdaptiveChipHitTesting, adoptAdaptiveChipInsertionCaret, adoptAdaptiveChipKeyboardNavigation, adoptAdaptiveChipSelection, adoptAdaptiveComposerHeight, adoptConversationMentionProjection, adoptConversationSyncActionProjection, adoptMenuExpansionProjection, adoptMenuGroupTitleProjection, adoptReferenceIconProjection, adoptStyles } from './styles.ts'
import { en, REFERENCE_ANYTHING_NS, zh } from './locale.ts'
import { createSettingsOpenHealthCheck, runSetupSequence, setupReady, type SetupStage } from './health.ts'

// `ctx.remote.commands` is a separately injected Remote face. Declaring only
// `remote` lets the @ source register, but its candidate request can fail and
// the input-trigger menu then removes the Commands group as a failed source.
export const inject = ['inputTriggers', 'remote', 'remote.commands', 'slots', 'connection', 'locale']

export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => adoptReferenceIconProjection(), 'reference-anything.client.icon-projection')
  ctx.effect(() => adoptConversationMentionProjection(), 'reference-anything.client.message-projection')
  ctx.effect(() => adoptAdaptiveComposerHeight(), 'reference-anything.client.adaptive-composer-height')
  ctx.effect(() => adoptAdaptiveChipHitTesting(), 'reference-anything.client.adaptive-chip-hit-testing')
  ctx.effect(() => adoptAdaptiveChipInsertionCaret(), 'reference-anything.client.adaptive-chip-insertion-caret')
  ctx.effect(() => adoptAdaptiveChipKeyboardNavigation(), 'reference-anything.client.adaptive-chip-keyboard-navigation')
  ctx.effect(() => adoptAdaptiveChipSelection(), 'reference-anything.client.adaptive-chip-selection')
  ctx.effect(() => adoptAdaptiveChipCaret(), 'reference-anything.client.adaptive-chip-caret')
  let remote: ReferenceAnythingRemoteFace | undefined
  const scope = createSnapshotStore<SettingsSnapshot>({
    settings: { opencliPath: 'opencli', profile: '', detailConcurrency: 8, autoSync: false, syncOnStartup: false, autoSyncMinutes: 60, historyMode: 'metadata-only', enabledProviders: [...ALL_PROVIDERS], maxReadTurns: 10, inputRenderMode: 'pill' }, loading: true,
  })
  let currentJob = ''
  let poll: ReturnType<typeof setInterval> | undefined
  let settingsNoticeTimer: ReturnType<typeof setTimeout> | undefined
  let refreshGeneration = 0
  const t = ctx.locale.bind(REFERENCE_ANYTHING_NS)
  let applySources: ((picker: PickerSettings | undefined, renderMode?: InputRenderMode) => void) | undefined
  ctx.effect(() => ctx.locale.register(REFERENCE_ANYTHING_NS, { zh, en }), 'reference-anything.client.dictionaries')
  ctx.effect(() => adoptMenuGroupTitleProjection(t), 'reference-anything.client.menu-group-localization')

  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
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
      applySources?.(currentSettings.picker, currentSettings.inputRenderMode)
      scope.set({ ...scope.getSnapshot(), settings: currentSettings, stats, storage: unwrap(storageResult),
        error: statsUnavailable && !stats ? 'Local conversation statistics are unavailable until the DSH host is restarted.' : undefined, loading: false })
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
      applySources?.(currentSettings.picker, currentSettings.inputRenderMode)
      scope.set({ ...scope.getSnapshot(), settings: currentSettings, health: unwrap(health), profiles, stats, storage: unwrap(storageResult),
        error: statsUnavailable && !stats ? 'Local conversation statistics are unavailable until the DSH host is restarted.' : undefined, loading: false })
    } catch (error) {
      if (generation === refreshGeneration) scope.set({ ...scope.getSnapshot(), error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }
  const checkHealthOnSettingsOpen = createSettingsOpenHealthCheck(refresh)
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
  const sessionSearch = createSearchDebounce<SessionCandidate>()
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
      if (status) scope.set({ ...scope.getSnapshot(), sync: status })
      if (!status || status.status !== 'running') {
        if (poll) clearInterval(poll)
        poll = undefined
        await refreshLocal()
        const current = scope.getSnapshot().browse
        if (current) await browse(current.query, current.provider, current.offset)
      }
    } catch (error) {
      if (poll) clearInterval(poll); poll = undefined
      scope.set({ ...scope.getSnapshot(), error: message(error) })
    }
  }

  ctx.effect(async () => {
    const dispose = await ctx.remote.$mount(REFERENCE_ANYTHING_REMOTE)
    remote = (ctx.reflect as unknown as { get(name: string): unknown }).get('remote.referenceAnything') as ReferenceAnythingRemoteFace | undefined
    if (!remote) throw new Error('referenceAnything Remote did not mount')
    await refreshLocal()
    return () => { remote = undefined; if (poll) clearInterval(poll); void dispose() }
  }, 'reference-anything.client.remote')

  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const connection = ctx.get('connection') as ConnectionHandle
  let sourceDisposers: Array<() => void> = []
  let appliedPicker: PickerSettings | undefined
  let appliedRenderMode: InputRenderMode | undefined
  let menuPicker = defaultPickerSettings()
  const registerSources = (picker: PickerSettings, renderMode: InputRenderMode) => {
    menuPicker = picker
    const source = createConversationSource((query, provider, signal, limit) =>
      conversationSearch.run(query, signal, async () => {
        // Re-read after the debounce: the Remote can unmount with its scope.
        if (!remote) return []
        return unwrap(await remote.search({ query, ...(provider ? { provider } : {}), limit }, signal))
      }), t, { ...picker.conversations, renderMode })
    const disposers: Array<() => void> = []
    if (picker.conversations.enabled) disposers.push(inputTriggers.registerSource(source))
    if (picker.commands.enabled) disposers.push(inputTriggers.registerSource(createCommandSource(async (sessionId, signal) => { signal.throwIfAborted(); return unwrap(await ctx.remote.commands.list(sessionId)) }, t, picker.commands)))
    if (picker.skills.enabled) disposers.push(inputTriggers.registerSource(createSkillSource(async (sessionId, signal) => {
        const { result } = await connection.api.skills.list({ sessionId }, signal)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value.skills
      }, t, picker.skills)))
    if (picker.files.enabled) disposers.push(inputTriggers.registerSource(createWorkspaceSource(async (sessionId, signal) => {
        if (!remote) return []
        return unwrap(await remote.workspaceSearch(sessionId, signal))
      }, t, { ...picker.files, renderMode })))
    if (picker.sessions.enabled) disposers.push(inputTriggers.registerSource(createSessionSource((sessionId, query, signal) =>
      sessionSearch.run(query, signal, async () => {
        if (!remote) return []
        return unwrap(await remote.sessionSearch(sessionId, { query, limit: 50 }, signal))
      }), t, { ...picker.sessions, renderMode })))
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
      scope.set({ ...scope.getSnapshot(), notice: t('notice.cleared', { count }), error: undefined })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  const clearOlder = async (days: number): Promise<void> => {
    if (!remote) return
    try {
      const count = unwrap(await remote.clearOlder({ days }))
      await Promise.all([refreshStats(), refreshStorage()])
      const current = scope.getSnapshot().browse
      if (current) await browse(current.query, current.provider, 0)
      scope.set({ ...scope.getSnapshot(), notice: t('notice.cleared', { count }), error: undefined })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  applySources = (picker, renderMode = 'pill') => {
    const next = picker ?? defaultPickerSettings()
    // Settings unrelated to the @ picker (for example Auto sync) use the
    // same save endpoint. Re-registering every input source for those saves
    // can dispose UI-owned registrations while the settings panel is still
    // rendering, leaving the panel blank. Only rebuild when picker behavior
    // actually changed.
    if (appliedPicker !== undefined && samePickerSettings(appliedPicker, next) && appliedRenderMode === renderMode) return
    for (const dispose of sourceDisposers) dispose()
    sourceDisposers = registerSources(next, renderMode)
    appliedPicker = next
    appliedRenderMode = renderMode
  }
  applySources(undefined)
  ctx.effect(() => () => { for (const dispose of sourceDisposers) dispose() }, 'reference-anything.client.sources')

  const save = async (settings: SettingsRecord): Promise<void> => {
    if (!remote) return
    try {
      const value = unwrap(await remote.settingsUpdate(settings))
      applySources?.(value.picker, value.inputRenderMode)
      const notice = t('notice.settingsSaved')
      if (settingsNoticeTimer) clearTimeout(settingsNoticeTimer)
      scope.set({ ...scope.getSnapshot(), settings: value, error: undefined, notice })
      settingsNoticeTimer = setTimeout(() => {
        const current = scope.getSnapshot()
        if (current.notice === notice) scope.set({ ...current, notice: undefined })
        settingsNoticeTimer = undefined
      }, 2_400)
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
      scope.set({ ...scope.getSnapshot(), notice: t('notice.cleared', { count }), error: undefined })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  const clearOldAccounts = async (): Promise<void> => {
    if (!remote) return
    try {
      const count = unwrap(await remote.clearOldAccounts())
      await Promise.all([refreshStats(), refreshStorage()])
      const current = scope.getSnapshot().browse
      if (current) await browse(current.query, current.provider, 0)
      scope.set({ ...scope.getSnapshot(), notice: t('notice.cleared', { count }), error: undefined })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  ctx.effect(() => () => { if (settingsNoticeTimer) clearTimeout(settingsNoticeTimer) }, 'reference-anything.client.settings-notice')
  const startSync = async (providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void> => {
    if (!remote) return
    try {
      currentJob = unwrap(await remote.syncStart({ providers, mode }))
      const initial: SyncStatus = {
        jobId: currentJob, status: 'running', providers, completed: 0, total: 0,
        providerProgress: providers.map(provider => ({ provider, phase: 'listing', completed: 0, total: 0 })),
      }
      scope.set({ ...scope.getSnapshot(), sync: initial, error: undefined, notice: undefined })
      if (poll) clearInterval(poll); poll = setInterval(() => { void pollJob() }, 1_000); await pollJob()
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
  }
  ctx.effect(() => adoptConversationSyncActionProjection({
    source: CONVERSATION_SOURCE,
    idleLabel: t('menu.syncAll'), listingLabel: (completed, total) => t('menu.syncListingProgress', { completed, total }),
    progressLabel: (completed, total) => t('menu.syncProgress', { completed, total }),
    completeLabel: t('sync.complete'), partialLabel: t('sync.partial'),
    failedLabel: t('sync.failed'), cancelledLabel: t('sync.cancelled'),
    start: () => startSync(scope.getSnapshot().settings.enabledProviders, 'incremental'),
    getStatus: () => scope.getSnapshot().sync,
    subscribe: listener => scope.subscribe(listener),
  }), 'reference-anything.client.conversation-sync-action')
  const menuSourceKeys: Readonly<Record<string, keyof PickerSettings>> = {
    [COMMAND_SOURCE]: 'commands', [SKILL_SOURCE]: 'skills', [FILE_SOURCE]: 'files',
    [SESSION_SOURCE]: 'sessions', [CONVERSATION_SOURCE]: 'conversations',
  }
  ctx.effect(() => adoptMenuExpansionProjection({
    sources: Object.keys(menuSourceKeys), label: t('menu.expandAll'),
    getVisibleLimit: source => menuPicker[menuSourceKeys[source] ?? 'conversations'].limit, batchSize: 5,
  }), 'reference-anything.client.menu-expansion')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'reference-anything', order: 56, label: () => t('settings.title'), locale: REFERENCE_ANYTHING_NS,
    inject: () => ({
      hooks: { scope }, save, sync: startSync, refresh,
      refreshOnOpen: () => checkHealthOnSettingsOpen((scope.getSnapshot().settings.picker ?? defaultPickerSettings()).conversations.enabled),
      browse, deleteConversation, clearProvider, clearOlder, clearRemoteMissing, clearOldAccounts, refreshStats,
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
            scope.set({ ...scope.getSnapshot(), error: undefined, notice: t('notice.setupComplete'), setupStep: 'complete' })
          } else if (health?.extensionConnected && !health.connectivityOk) {
            scope.set({ ...scope.getSnapshot(), error: t('settings.connectivityStillUnavailable'), notice: undefined, setupStep: undefined })
          } else if (!health?.extensionConnected) {
            scope.set({ ...scope.getSnapshot(), error: undefined, notice: extensionPageOpened ? t('notice.oneClickSetup') : t('notice.extensionStoreBlocked'), setupStep: 'extension' })
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
          scope.set({ ...scope.getSnapshot(), error: undefined, notice: t('notice.opencliFound', { version: discovery.version }) })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      installOpenCli: async () => {
        try {
          if (!remote) return
          const discovery = unwrap(await remote.installOpenCli())
          await refresh()
          const health = scope.getSnapshot().health
          if (!health?.version || !health.opencliCompatible) throw new Error(t('settings.opencliStillUnavailable'))
          scope.set({ ...scope.getSnapshot(), error: undefined, notice: t('notice.opencliInstalled', { version: discovery.version }) })
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
          scope.set({ ...scope.getSnapshot(), error: undefined, notice: t('notice.profileSelected') })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      install: async () => {
        try {
          if (!remote) return
          unwrap(await remote.installAdapter()); await refresh()
          const health = scope.getSnapshot().health
          if (!health?.pluginInstalled || !health.adapterCompatible) throw new Error(t('settings.adapterStillUnavailable'))
          scope.set({ ...scope.getSnapshot(), error: undefined, notice: t('notice.adapterInstalled') })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      restartDaemon: async () => {
        try {
          if (!remote) return
          unwrap(await remote.restartDaemon()); await refresh()
          const health = scope.getSnapshot().health
          if (!health?.daemonRunning || health.daemonStale) throw new Error(t('settings.daemonStillUnavailable'))
          scope.set({ ...scope.getSnapshot(), error: undefined, notice: t('notice.daemonRestarted') })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
      },
      cancel: async () => { try { if (remote && currentJob) unwrap(await remote.syncCancel({ jobId: currentJob })); await pollJob() } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) } },
    }),
  }, ConversationSettings))
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
