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
export interface WorkspaceEntry { path: string; kind: 'file' | 'directory' }
export interface SessionCandidate { sessionId: string; label: string; cwd?: string; createdAt: number }
export interface Health {
  version: string; daemon: string; pluginInstalled: boolean
  versionError?: string; daemonError?: string; pluginError?: string
}
export interface BrowserProfile { id: string; alias?: string; connected: boolean; isDefault: boolean }
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

export interface ManagedConversation extends ConversationRow { remoteMissing: boolean }
export interface BrowsePage { items: readonly ManagedConversation[]; total: number }
export interface ProviderSyncState {
  provider: ChatProvider; status: 'idle' | 'running' | 'cancelled' | 'failed'
  lastSyncAt: string; lastCompleteScanAt: string; error: string
}

export const REFERENCE_ANYTHING_REMOTE: TypertRemoteContribution = {
  package: 'dsh-reference-anything', descriptors: REFERENCE_ANYTHING_INVOCATIONS,
}

export interface ReferenceAnythingRemoteFace {
  workspaceSearch(agentId: string, signal?: AbortSignal): Promise<RemoteResult<readonly WorkspaceEntry[]>>
  sessionSearch(agentId: string, input: { query: string; limit: number }, signal?: AbortSignal): Promise<RemoteResult<readonly SessionCandidate[]>>
  search(input: { query: string; provider?: ChatProvider; limit: number }, signal?: AbortSignal): Promise<RemoteResult<readonly SearchResult[]>>
  health(signal?: AbortSignal): Promise<RemoteResult<Health>>
  profiles(signal?: AbortSignal): Promise<RemoteResult<readonly BrowserProfile[]>>
  installAdapter(signal?: AbortSignal): Promise<RemoteResult<boolean>>
  restartDaemon(signal?: AbortSignal): Promise<RemoteResult<boolean>>
  stats(): Promise<RemoteResult<readonly ProviderStats[]>>
  syncStart(input: { providers: ChatProvider[]; mode: 'incremental' | 'full' }): Promise<RemoteResult<string>>
  syncStatus(input: { jobId: string }): Promise<RemoteResult<SyncStatus | undefined>>
  syncCancel(input: { jobId: string }): Promise<RemoteResult<boolean>>
  settingsGet(): Promise<RemoteResult<SettingsRecord>>
  settingsUpdate(settings: SettingsRecord): Promise<RemoteResult<SettingsRecord>>
  browse(input: { query: string; provider?: ChatProvider; limit: number; offset: number }, signal?: AbortSignal): Promise<RemoteResult<BrowsePage>>
  deleteConversation(input: { uriId: string }, signal?: AbortSignal): Promise<RemoteResult<boolean>>
  syncStates(): Promise<RemoteResult<readonly ProviderSyncState[]>>
}
