import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { REFERENCE_ANYTHING_INVOCATIONS } from '../contract.ts'
import type { ChatProvider, SettingsRecord } from '../wire.ts'

export interface SearchResult {
  uriId: string; provider: ChatProvider; title: string; url: string; updatedAt: string
  turnCount: number; partial: boolean; syncedAt: string
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
  jobId: string; status: 'running' | 'complete' | 'cancelled' | 'failed'; providers: ChatProvider[]
  provider?: ChatProvider; completed: number; total: number; error?: string
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
  stats(): Promise<RemoteResult<readonly ProviderStats[]>>
  syncStart(input: { providers: ChatProvider[]; mode: 'incremental' | 'full' }): Promise<RemoteResult<string>>
  syncStatus(input: { jobId: string }): Promise<RemoteResult<SyncStatus | undefined>>
  syncCancel(input: { jobId: string }): Promise<RemoteResult<boolean>>
  settingsGet(): Promise<RemoteResult<SettingsRecord>>
  settingsUpdate(settings: SettingsRecord): Promise<RemoteResult<SettingsRecord>>
}
