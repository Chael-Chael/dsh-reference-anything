import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { REFERENCE_ANYTHING_INVOCATIONS } from '../contract.ts'
import type { ChatProvider, SettingsRecord } from '../wire.ts'

/** The stored facts about one mirrored conversation, shared by both list surfaces. */
export interface ConversationRow {
  uriId: string; provider: ChatProvider; title: string; url: string; updatedAt: string
  turnCount: number; partial: boolean; syncedAt: string
}
export interface SearchResult extends ConversationRow {
  /** How this row was found, so the menu row can say why it matched. */
  matchedVia: 'recent' | 'title' | 'content'
  /** Excerpt around a body hit; shown in the menu, never sent to the model. */
  snippet?: string
}
/** One local-agent transcript offered by the `@` menu; `id` is source-scoped, not a URI. */
export interface AgentCandidate { id: string; kind: string; label: string; provider: string; updatedAt?: number }
/** One cloud-drive file offered by the `@` menu; `origin` is a display path, never a URL. */
export interface DriveCandidate { id: string; label: string; provider: string; origin?: string; updatedAt?: number; searchIncomplete?: boolean; isDirectory?: boolean }
export type ExtensionState = 'connected' | 'disconnected' | 'profile-required' | 'profile-disconnected' | 'daemon-offline'
export interface Health {
  version: string; daemon: string; pluginInstalled: boolean
  daemonRunning: boolean; extensionConnected: boolean; extensionState: ExtensionState
  extensionVersion?: string; profileCount?: number
  opencliCompatible: boolean; daemonVersion?: string; daemonStale: boolean
  connectivityOk: boolean; connectivityChecked: boolean; pluginVersion?: string; adapterCommandsReady: boolean; adapterCompatible: boolean
  versionError?: string; daemonError?: string; pluginError?: string; doctorError?: string
}
export interface BrowserProfile { id: string; alias?: string; connected: boolean; isDefault: boolean }
export interface OpenCliDiscovery { found: boolean; executable: string; version: string; error?: string }
export interface PackageUpdateStatus {
  currentVersion: string; latestVersion: string; updateAvailable: boolean; checkedAt: number; error?: string
}
export interface PackageUpdateResult { version: string; restartRequired: boolean }
export interface ProviderStats {
  provider: ChatProvider; conversations: number; lastSyncedAt: string
  status: 'ready' | 'syncing' | 'error' | 'empty'; error?: string
}
export interface SyncStatus {
  jobId: string; status: 'running' | 'complete' | 'partial' | 'cancelled' | 'failed'; providers: ChatProvider[]
  provider?: ChatProvider; completed: number; total: number
  providerProgress: Array<{ provider: ChatProvider; phase: 'listing' | 'syncing' | 'complete' | 'failed' | 'cancelled'; completed: number; total: number; error?: string }>
  error?: string
}

/**
 * A deterministic progress fraction for both sync surfaces.
 *
 * Listing is one atomic OpenCLI operation, so its conversation total is not
 * known until the provider returns. While any provider is still listing, give
 * each listed provider a fixed first-quarter phase, then use its real
 * completed/total conversation count for the remaining three quarters. Once
 * all providers have listed, the existing aggregate conversation counter is
 * exact and avoids changing the meaning of the established UI percentage.
 */
export function syncProgressFraction(sync: Pick<SyncStatus, 'status' | 'completed' | 'total' | 'providerProgress'>): number {
  if (sync.status !== 'running') return sync.status === 'complete' ? 1 : 0
  if (!sync.providerProgress.some(row => row.phase === 'listing')) {
    return sync.total > 0 ? clamp(sync.completed / sync.total) : 0
  }
  if (sync.providerProgress.length === 0) return 0
  const fraction = sync.providerProgress.reduce((sum, row) => {
    if (row.phase === 'listing') return sum
    if (row.phase === 'complete' && row.total === 0) return sum + 1
    const detail = row.total > 0 ? clamp(row.completed / row.total) : 0
    return sum + 0.25 + detail * 0.75
  }, 0) / sync.providerProgress.length
  return clamp(fraction)
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export interface ManagedConversation extends ConversationRow { remoteMissing: boolean }
export interface BrowsePage { items: readonly ManagedConversation[]; total: number }
export interface StorageStats { bytes: number; conversations: number; remoteMissing: number; oldAccountConversations: number }
export interface ProviderSyncState {
  provider: ChatProvider; status: 'idle' | 'running' | 'cancelled' | 'failed'
  lastSyncAt: string; lastCompleteScanAt: string; error: string
}
export interface OpenListStatus { state: 'install' | 'downloading' | 'running' | 'failed' | 'upgrade'; installed: boolean; mode?: 'managed' | 'external'; version?: string; endpoint?: string; supportsRollback: boolean; upgradeAvailable: boolean; newerVersion?: boolean; error?: string }
export interface OpenListDriverField { name: string; label: string; type: 'text' | 'password' | 'number' | 'boolean' | 'select'; secret?: boolean; required: boolean; hasDefault?: boolean; default?: string | number | boolean; options?: ReadonlyArray<{ label: string; value: string }> }
export interface OpenListDriver { name: string; description?: string; quickAuth?: boolean; fields: readonly OpenListDriverField[] }
export interface OpenListMount { id: string; name: string; driver: string; enabled: boolean; status?: 'ready' | 'disabled' | 'error'; error?: string; capacityUsed?: number; capacityTotal?: number; indexStatus?: 'idle' | 'running' | 'complete' | 'failed'; indexProgress?: number; indexCount?: number }
export interface OpenListReindex { supported: boolean; reason?: string }

export const REFERENCE_ANYTHING_REMOTE: TypertRemoteContribution = {
  package: 'dsh-reference-anything', descriptors: REFERENCE_ANYTHING_INVOCATIONS,
}

export interface ReferenceAnythingRemoteFace {
  agentSearch(agentId: string, input: { query: string; limit: number }, signal?: AbortSignal): Promise<RemoteResult<readonly AgentCandidate[]>>
  driveSearch(input: { query: string; limit: number }, signal?: AbortSignal): Promise<RemoteResult<readonly DriveCandidate[]>>
  search(input: { query: string; provider?: ChatProvider; limit: number }, signal?: AbortSignal): Promise<RemoteResult<readonly SearchResult[]>>
  health(signal?: AbortSignal): Promise<RemoteResult<Health>>
  quickHealth(signal?: AbortSignal): Promise<RemoteResult<Health>>
  profiles(signal?: AbortSignal): Promise<RemoteResult<readonly BrowserProfile[]>>
  discoverOpenCli(signal?: AbortSignal): Promise<RemoteResult<OpenCliDiscovery>>
  installOpenCli(signal?: AbortSignal): Promise<RemoteResult<OpenCliDiscovery>>
  installAdapter(signal?: AbortSignal): Promise<RemoteResult<boolean>>
  restartDaemon(signal?: AbortSignal): Promise<RemoteResult<boolean>>
  updateStatus(signal?: AbortSignal): Promise<RemoteResult<PackageUpdateStatus>>
  checkUpdate(signal?: AbortSignal): Promise<RemoteResult<PackageUpdateStatus>>
  installUpdate(signal?: AbortSignal): Promise<RemoteResult<PackageUpdateResult>>
  stats(): Promise<RemoteResult<readonly ProviderStats[]>>
  syncStart(input: { providers: ChatProvider[]; mode: 'incremental' | 'full' }): Promise<RemoteResult<string>>
  syncStatus(input: { jobId: string }): Promise<RemoteResult<SyncStatus | undefined>>
  syncCancel(input: { jobId: string }): Promise<RemoteResult<boolean>>
  settingsGet(): Promise<RemoteResult<SettingsRecord>>
  settingsUpdate(settings: SettingsRecord): Promise<RemoteResult<SettingsRecord>>
  browse(input: { query: string; provider?: ChatProvider; limit: number; offset: number }, signal?: AbortSignal): Promise<RemoteResult<BrowsePage>>
  deleteConversation(input: { uriId: string }, signal?: AbortSignal): Promise<RemoteResult<boolean>>
  storageStats(): Promise<RemoteResult<StorageStats>>
  clearProvider(input: { provider: ChatProvider }, signal?: AbortSignal): Promise<RemoteResult<number>>
  clearOlder(input: { days: number }, signal?: AbortSignal): Promise<RemoteResult<number>>
  clearRemoteMissing(signal?: AbortSignal): Promise<RemoteResult<number>>
  clearOldAccounts(signal?: AbortSignal): Promise<RemoteResult<number>>
  syncStates(): Promise<RemoteResult<readonly ProviderSyncState[]>>
  openListStatus(signal?: AbortSignal): Promise<RemoteResult<OpenListStatus>>
  openListInstall(signal?: AbortSignal): Promise<RemoteResult<OpenListStatus>>
  openListUpgrade(input: { rollback?: boolean }, signal?: AbortSignal): Promise<RemoteResult<OpenListStatus>>
  openListConnectExternal(input: { endpoint: string; username?: string; password?: string; token?: string }, signal?: AbortSignal): Promise<RemoteResult<OpenListStatus>>
  openListDisconnect(signal?: AbortSignal): Promise<RemoteResult<OpenListStatus>>
  openListDrivers(signal?: AbortSignal): Promise<RemoteResult<readonly OpenListDriver[]>>
  openListMounts(signal?: AbortSignal): Promise<RemoteResult<readonly OpenListMount[]>>
  openListCreateMount(input: { id?: string; mountPath: string; driver: string; addition: Record<string, unknown>; order?: number; remark?: string }, signal?: AbortSignal): Promise<RemoteResult<OpenListMount>>
  openListDisableMount(input: { id: string; disabled?: boolean }, signal?: AbortSignal): Promise<RemoteResult<boolean>>
  openListRemoveMount(input: { id: string }, signal?: AbortSignal): Promise<RemoteResult<boolean>>
  openListReindex(input: { id: string }, signal?: AbortSignal): Promise<RemoteResult<OpenListReindex>>
}
