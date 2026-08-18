import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { defaultPickerSettings, samePickerSettings, type ChatProvider, type PickerSettings, type SettingsRecord } from '../wire.ts'
import { REFERENCE_ANYTHING_REMOTE, type ReferenceAnythingRemoteFace, type SearchResult, type SessionCandidate, type SyncStatus } from './remote.ts'
import { COMMAND_SOURCE, CONVERSATION_SOURCE, FILE_SOURCE, SESSION_SOURCE, SKILL_SOURCE, conversationReferenceUri, createCommandSource, createConversationSource, createSearchDebounce, createSessionSource, createSkillSource, createWorkspaceSource } from './source.ts'
import { ConversationsDock, ConversationSettings, PAGE_SIZE, type SettingsSnapshot } from './components.tsx'
import { adoptAdaptiveChipCaret, adoptConversationMentionProjection, adoptConversationSyncActionProjection, adoptMenuExpansionProjection, adoptMenuGroupTitleProjection, adoptReferenceIconProjection, adoptStyles } from './styles.ts'
import { en, REFERENCE_ANYTHING_NS, zh } from './locale.ts'
import { OPENCLI_EXTENSION_STORE_URL } from './health.ts'

// `ctx.remote.commands` is a separately injected Remote face. Declaring only
// `remote` lets the @ source register, but its candidate request can fail and
// the input-trigger menu then removes the Commands group as a failed source.
export const inject = ['inputTriggers', 'remote', 'remote.commands', 'slots', 'connection', 'locale']

export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => adoptReferenceIconProjection(), 'reference-anything.client.icon-projection')
  ctx.effect(() => adoptConversationMentionProjection(), 'reference-anything.client.message-projection')
  ctx.effect(() => adoptAdaptiveChipCaret(), 'reference-anything.client.adaptive-chip-caret')
  let remote: ReferenceAnythingRemoteFace | undefined
  const scope = createSnapshotStore<SettingsSnapshot>({
    settings: { opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false, autoSyncMinutes: 60, historyMode: 'metadata-only' }, loading: true,
  })
  let currentJob = ''
  let poll: ReturnType<typeof setInterval> | undefined
  const t = ctx.locale.bind(REFERENCE_ANYTHING_NS)
  let applySources: ((picker: PickerSettings | undefined) => void) | undefined
  ctx.effect(() => ctx.locale.register(REFERENCE_ANYTHING_NS, { zh, en }), 'reference-anything.client.dictionaries')
  ctx.effect(() => adoptMenuGroupTitleProjection(t), 'reference-anything.client.menu-group-localization')

  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  const refresh = async (): Promise<void> => {
    if (!remote) return
    try {
      const [settings, health] = await Promise.all([remote.settingsGet(), remote.health()])
      let profiles = scope.getSnapshot().profiles
      try { profiles = unwrap(await remote.profiles()) } catch { /* Profile discovery failure is represented by bridge health. */ }
      let stats = scope.getSnapshot().stats
      let statsUnavailable = false
      try { stats = unwrap(await remote.stats()) } catch { statsUnavailable = true }
      const currentSettings = unwrap(settings)
      applySources?.(currentSettings.picker)
      scope.set({ ...scope.getSnapshot(), settings: currentSettings, health: unwrap(health), profiles, stats,
        error: statsUnavailable && !stats ? 'Local conversation statistics are unavailable until the DSH host is restarted.' : undefined, loading: false })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: error instanceof Error ? error.message : String(error), loading: false }) }
  }
  /**
   * Re-read provider statistics only.
   *
   * Deliberately not `refresh()`: that also probes OpenCLI health, which
   * spawns three processes, and this runs on a timer while the panel is open.
   * A failure leaves the last known figures rather than replacing the panel
   * with an error — the next tick tries again.
   */
  const urlByUri = new Map<string, string>()
  // These defer rapid typing but deliberately retain no prior search rows.
  const conversationSearch = createSearchDebounce<SearchResult>()
  const sessionSearch = createSearchDebounce<SessionCandidate>()
  const refreshStats = async (): Promise<void> => {
    if (!remote) return
    try {
      scope.set({ ...scope.getSnapshot(), stats: unwrap(await remote.stats()) })
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
      urlByUri.delete(conversationReferenceUri(uriId))
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
        await refresh()
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
    await refresh()
    return () => { remote = undefined; if (poll) clearInterval(poll); void dispose() }
  }, 'reference-anything.client.remote')

  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const connection = ctx.get('connection') as ConnectionHandle
  let sourceDisposers: Array<() => void> = []
  let appliedPicker: PickerSettings | undefined
  let menuPicker = defaultPickerSettings()
  const registerSources = (picker: PickerSettings) => {
    menuPicker = picker
    const source = createConversationSource((query, provider, signal, limit) =>
      conversationSearch.run(query, signal, async () => {
        // Re-read after the debounce: the Remote can unmount with its scope.
        if (!remote) return []
        const rows = unwrap(await remote.search({ query, ...(provider ? { provider } : {}), limit }, signal))
        for (const row of rows) urlByUri.set(conversationReferenceUri(row.uriId), row.url)
        return rows
      }), t, picker.conversations)
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
      }, t, picker.files)))
    if (picker.sessions.enabled) disposers.push(inputTriggers.registerSource(createSessionSource((sessionId, query, signal) =>
      sessionSearch.run(query, signal, async () => {
        if (!remote) return []
        return unwrap(await remote.sessionSearch(sessionId, { query, limit: 50 }, signal))
      }), t, picker.sessions)))
    return disposers
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
    sourceDisposers = registerSources(next)
    appliedPicker = next
  }
  applySources(undefined)
  ctx.effect(() => () => { for (const dispose of sourceDisposers) dispose() }, 'reference-anything.client.sources')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'reference-anything', order: 25, locale: REFERENCE_ANYTHING_NS,
    inject: () => ({ open: (uri: string) => { const url = urlByUri.get(uri); if (url) window.open(url, '_blank', 'noopener,noreferrer') } }),
  }, ConversationsDock))

  const save = async (settings: SettingsRecord): Promise<void> => {
    if (!remote) return
    try {
      const value = unwrap(await remote.settingsUpdate(settings))
      applySources?.(value.picker)
      scope.set({ ...scope.getSnapshot(), settings: value, error: undefined, notice: t('notice.settingsSaved') })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error), notice: undefined }) }
  }
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
    start: () => startSync(['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi'], 'incremental'),
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
      hooks: { scope }, save, sync: startSync, refresh, browse, deleteConversation, refreshStats,
      setupAll: async () => {
        if (!remote) return
        try {
          const health = scope.getSnapshot().health
          // The adapter install is idempotent, but skip it when already present
          // so a healthy deployment isn't needlessly rewritten.
          if (health && !health.pluginInstalled) unwrap(await remote.installAdapter())
          if (health && !health.daemonRunning) unwrap(await remote.restartDaemon())
          // Chrome cannot be told to install an extension programmatically; the
          // "one-click" step is opening the Web Store listing for the user's
          // single "Add to Chrome" press.
          window.open(OPENCLI_EXTENSION_STORE_URL, '_blank', 'noopener,noreferrer')
          await refresh()
          scope.set({ ...scope.getSnapshot(), notice: t('notice.oneClickSetup') })
        } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) }
      },
      install: async () => { try { if (!remote) return; unwrap(await remote.installAdapter()); await refresh(); scope.set({ ...scope.getSnapshot(), notice: t('notice.adapterInstalled') }) } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) } },
      restartDaemon: async () => { try { if (!remote) return; unwrap(await remote.restartDaemon()); await refresh(); scope.set({ ...scope.getSnapshot(), notice: t('notice.daemonRestarted') }) } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) } },
      cancel: async () => { try { if (remote && currentJob) unwrap(await remote.syncCancel({ jobId: currentJob })); await pollJob() } catch (error) { scope.set({ ...scope.getSnapshot(), error: message(error) }) } },
    }),
  }, ConversationSettings))
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
