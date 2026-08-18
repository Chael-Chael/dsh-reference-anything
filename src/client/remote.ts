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
export interface Health { version: string; daemon: string; pluginInstalled: boolean }
export interface SyncStatus {
  jobId: string; status: 'running' | 'complete' | 'cancelled' | 'failed'; providers: ChatProvider[]
  provider?: ChatProvider; completed: number; total: number; error?: string
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
  search(input: { query: string; provider?: ChatProvider; limit: number }, signal?: AbortSignal): Promise<RemoteResult<readonly SearchResult[]>>
  health(signal?: AbortSignal): Promise<RemoteResult<Health>>
  syncStart(input: { providers: ChatProvider[]; mode: 'incremental' | 'full' }): Promise<RemoteResult<string>>
  syncStatus(input: { jobId: string }): Promise<RemoteResult<SyncStatus | undefined>>
  syncCancel(input: { jobId: string }): Promise<RemoteResult<boolean>>
  settingsGet(): Promise<RemoteResult<SettingsRecord>>
  settingsUpdate(settings: SettingsRecord): Promise<RemoteResult<SettingsRecord>>
  browse(input: { query: string; provider?: ChatProvider; limit: number; offset: number }, signal?: AbortSignal): Promise<RemoteResult<BrowsePage>>
  deleteConversation(input: { uriId: string }, signal?: AbortSignal): Promise<RemoteResult<boolean>>
  syncStates(): Promise<RemoteResult<readonly ProviderSyncState[]>>
}
