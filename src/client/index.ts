import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore, type ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ChatProvider, SettingsRecord } from '../wire.ts'
import { REFERENCE_ANYTHING_REMOTE, type ReferenceAnythingRemoteFace, type SearchResult, type SyncStatus } from './remote.ts'
import { conversationReferenceUri, createConversationSource } from './source.ts'
import { ConversationsDock, ConversationSettings, PAGE_SIZE, type SettingsSnapshot } from './components.tsx'
import { adoptStyles } from './styles.ts'

export const inject = ['inputTriggers', 'remote', 'slots']

/**
 * Rows offered for a bare `@`. Deliberately small: this menu opens on every
 * `@` typed in the composer, so it is a peek at what is recent, not a browse
 * surface — the settings panel's paginated list is that.
 */
export const MENTION_RECENT_LIMIT = 5
/** Rows offered once the user has typed something to rank against. */
export const MENTION_QUERY_LIMIT = 8
/** Keystrokes to ride out before a typed query reaches the Host. */
const MENTION_DEBOUNCE_MS = 120
/** How long a query's rows stay reusable, so backspacing does not round-trip. */
const MENTION_CACHE_TTL_MS = 10_000

/**
 * Wait out a delay that a superseding keystroke can cancel.
 * @returns false when the wait was aborted and the caller should drop out.
 */
function settle(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true) }, ms)
    const onAbort = (): void => { clearTimeout(timer); resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function apply(ctx: ClientContext): void {
  adoptStyles()
  let remote: ReferenceAnythingRemoteFace | undefined
  const scope = createSnapshotStore<SettingsSnapshot>({
    settings: { opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false, autoSyncMinutes: 60 },
  })
  let currentJob = ''
  let poll: ReturnType<typeof setInterval> | undefined

  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  const refresh = async (): Promise<void> => {
    if (!remote) return
    try {
      const [settings, health, syncStates] = await Promise.all([remote.settingsGet(), remote.health(), remote.syncStates()])
      scope.set({
        ...scope.getSnapshot(), settings: unwrap(settings), health: unwrap(health),
        syncStates: unwrap(syncStates), error: undefined,
      })
    } catch (error) { scope.set({ ...scope.getSnapshot(), error: error instanceof Error ? error.message : String(error) }) }
  }
  /**
   * Refresh only the durable per-provider sync status.
   *
   * Deliberately not `refresh()`: that also calls `health()`, which shells out
   * to OpenCLI three times, and this runs on a timer while the panel is open.
   * A failure here leaves the last known states rather than replacing the
   * panel with an error — the next tick will try again.
   */
  const refreshSyncStates = async (): Promise<void> => {
    if (!remote) return
    try {
      scope.set({ ...scope.getSnapshot(), syncStates: unwrap(await remote.syncStates()) })
    } catch { /* keep showing the last known states */ }
  }
  const browse = async (query: string, provider: ChatProvider | undefined, offset: number): Promise<void> => {
    if (!remote) return
    const page = unwrap(await remote.browse({ query, ...(provider ? { provider } : {}), limit: PAGE_SIZE, offset }))
    scope.set({ ...scope.getSnapshot(), browse: { query, provider, offset, page } })
  }
  const deleteConversation = async (uriId: string): Promise<void> => {
    if (!remote) return
    unwrap(await remote.deleteConversation({ uriId }))
    urlByUri.delete(conversationReferenceUri(uriId))
    const current = scope.getSnapshot().browse
    await browse(current?.query ?? '', current?.provider, current?.offset ?? 0)
  }
  const pollJob = async (): Promise<void> => {
    if (!remote || !currentJob) return
    const status = unwrap(await remote.syncStatus({ jobId: currentJob }))
    if (status) scope.set({ ...scope.getSnapshot(), sync: status })
    if (!status || status.status !== 'running') {
      if (poll) clearInterval(poll)
      poll = undefined
      // A finished sync moves conversations the mention menu may have cached.
      searchCache.clear()
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
  const urlByUri = new Map<string, string>()
  const searchCache = new Map<string, { at: number; rows: readonly SearchResult[] }>()
  const source = createConversationSource(async (query, provider, signal) => {
    const limit = query ? MENTION_QUERY_LIMIT : MENTION_RECENT_LIMIT
    const cacheKey = `${provider ?? ''}\u0000${query}\u0000${limit}`
    const cached = searchCache.get(cacheKey)
    if (cached && Date.now() - cached.at < MENTION_CACHE_TTL_MS) return cached.rows
    // The trigger controller re-fetches on every keystroke with no debounce of
    // its own. An empty query is the menu opening, so it stays instant; a typed
    // one rides out the next few characters before reaching the Host.
    if (query && !await settle(MENTION_DEBOUNCE_MS, signal)) return []
    // Re-read after the wait: the Remote unmounts with its scope.
    if (!remote) return []
    const rows = unwrap(await remote.search({ query, ...(provider ? { provider } : {}), limit }, signal))
    searchCache.set(cacheKey, { at: Date.now(), rows })
    for (const row of rows) urlByUri.set(conversationReferenceUri(row.uriId), row.url)
    return rows
  })
  ctx.effect(() => inputTriggers.registerSource(source), 'reference-anything.client.source')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'reference-anything', order: 25,
    inject: () => ({ open: (uri: string) => { const url = urlByUri.get(uri); if (url) window.open(url, '_blank', 'noopener,noreferrer') } }),
  }, ConversationsDock))

  const save = async (settings: SettingsRecord): Promise<void> => {
    if (!remote) return
    const value = unwrap(await remote.settingsUpdate(settings)); scope.set({ ...scope.getSnapshot(), settings: value })
  }
  const startSync = async (providers: ChatProvider[], mode: 'incremental' | 'full'): Promise<void> => {
    if (!remote) return
    currentJob = unwrap(await remote.syncStart({ providers, mode }))
    const initial: SyncStatus = { jobId: currentJob, status: 'running', providers, completed: 0, total: 0 }
    scope.set({ ...scope.getSnapshot(), sync: initial })
    if (poll) clearInterval(poll); poll = setInterval(() => { void pollJob() }, 1_000); await pollJob()
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'reference-anything', order: 56, label: () => 'Conversations',
    inject: () => ({
      hooks: { scope }, save, sync: startSync, refresh, refreshSyncStates, browse, deleteConversation,
      cancel: async () => { if (remote && currentJob) unwrap(await remote.syncCancel({ jobId: currentJob })); await pollJob() },
    }),
  }, ConversationSettings))
}
