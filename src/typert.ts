import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { CORE_INVOCATIONS, DRIVE_INVOCATIONS, LOCAL_AGENT_INVOCATIONS, LOCAL_PLUGIN_INVOCATIONS, REMOTE_PACKAGES, REMOTE_SERVICE_KEYS, WEB_CHAT_INVOCATIONS } from './contract.ts'

/** TypeScript signatures shown by the Typert registry, by method name. */
const SIGNATURES: Readonly<Record<string, string>> = {
  chatImportStatus: 'chatImportStatus(): Promise<ChatImportCompatibility>',
  chatImportUpgradeInstall: 'chatImportUpgradeInstall(signal: AbortSignal): Promise<ChatImportCompatibility>',
  agentSearch: 'agentSearch(agent: Agent, input: AgentSearchInput, signal: AbortSignal): Promise<AgentCandidate[]>',
  driveSearch: 'driveSearch(input: DriveSearchInput, signal: AbortSignal): Promise<DriveCandidate[]>',
  search: 'search(input: SearchInput): Promise<SearchResult[]>',
  health: 'health(signal: AbortSignal): Promise<Health>',
  quickHealth: 'quickHealth(signal: AbortSignal): Promise<Health>',
  profiles: 'profiles(signal: AbortSignal): Promise<BrowserProfile[]>',
  discoverOpenCli: 'discoverOpenCli(signal: AbortSignal): Promise<OpenCliDiscovery>',
  installOpenCli: 'installOpenCli(signal: AbortSignal): Promise<OpenCliDiscovery>',
  installAdapter: 'installAdapter(signal: AbortSignal): Promise<boolean>',
  restartDaemon: 'restartDaemon(signal: AbortSignal): Promise<boolean>',
  updateStatus: 'updateStatus(signal: AbortSignal): Promise<PackageUpdateStatus>',
  checkUpdate: 'checkUpdate(signal: AbortSignal): Promise<PackageUpdateStatus>',
  installUpdate: 'installUpdate(signal: AbortSignal): Promise<PackageUpdateResult>',
  stats: 'stats(): ProviderStats[]',
  tokenConnect: 'tokenConnect(input: TokenConnect, signal: AbortSignal): Promise<Settings>',
  syncStart: 'syncStart(input: SyncStart): string',
  syncStatus: 'syncStatus(input: JobInput): SyncStatus | undefined',
  syncCancel: 'syncCancel(input: JobInput): boolean',
  settingsGet: 'settingsGet(): Settings',
  settingsUpdate: 'settingsUpdate(settings: Settings): Promise<Settings>',
  browse: 'browse(input: BrowseInput): BrowsePage',
  deleteConversation: 'deleteConversation(input: DeleteInput): Promise<boolean>',
  storageStats: 'storageStats(): StorageStats',
  clearProvider: 'clearProvider(input: ClearProviderInput): Promise<number>',
  clearRemoteMissing: 'clearRemoteMissing(signal: AbortSignal): Promise<number>',
  clearOldAccounts: 'clearOldAccounts(signal: AbortSignal): Promise<number>',
  syncStates: 'syncStates(): ProviderSyncState[]',
  openListStatus: 'openListStatus(signal: AbortSignal): Promise<OpenListStatus>',
  openListInstall: 'openListInstall(signal: AbortSignal): Promise<OpenListStatus>',
  openListUpgrade: 'openListUpgrade(input: OpenListUpgradeInput, signal: AbortSignal): Promise<OpenListStatus>',
  openListConnectExternal: 'openListConnectExternal(input: OpenListExternalConnect, signal: AbortSignal): Promise<OpenListStatus>',
  openListDisconnect: 'openListDisconnect(signal: AbortSignal): Promise<OpenListStatus>',
  openListDrivers: 'openListDrivers(signal: AbortSignal): Promise<OpenListDriver[]>',
  openListMounts: 'openListMounts(signal: AbortSignal): Promise<OpenListMount[]>',
  openListCreateMount: 'openListCreateMount(input: OpenListMountCreate, signal: AbortSignal): Promise<OpenListMount>',
  openListDisableMount: 'openListDisableMount(input: OpenListDisableMountInput, signal: AbortSignal): Promise<boolean>',
  openListRemoveMount: 'openListRemoveMount(input: OpenListMountInput, signal: AbortSignal): Promise<boolean>',
  openListReindex: 'openListReindex(input: OpenListMountInput, signal: AbortSignal): Promise<OpenListReindex>',
  localPlugins: 'localPlugins(signal: AbortSignal): Promise<LocalPluginCandidate[]>',
  sources: 'sources(signal: AbortSignal): Promise<string[]>',
  driveStatus: 'driveStatus(signal: AbortSignal): Promise<DriveStatus>',
}

function manifest(pkg: string, key: string, exportName: string, description: string, invocations: readonly InvocationDescriptor[]): TypertContribution {
  return {
    package: pkg, face: 'host', schemas: [],
    model: { services: [{
      key, exportName, description, tags: [],
      members: invocations.map(item => ({ kind: 'method' as const, name: item.method, signature: SIGNATURES[item.method] ?? `${item.method}(): Promise<unknown>` })),
      types: [],
    }], events: [], objects: [] },
    invocations,
  }
}

export const CORE_TYPERT_MANIFEST = manifest(REMOTE_PACKAGES.core, REMOTE_SERVICE_KEYS.core, 'ReferenceAnythingRemote',
  'Reference Anything settings, sources, and package updates.', CORE_INVOCATIONS)
export const WEB_CHAT_TYPERT_MANIFEST = manifest(REMOTE_PACKAGES.webChat, REMOTE_SERVICE_KEYS.webChat, 'WebChatRemote',
  'Local Web conversation mirror and synchronization.', WEB_CHAT_INVOCATIONS)
export const LOCAL_AGENT_TYPERT_MANIFEST = manifest(REMOTE_PACKAGES.localAgent, REMOTE_SERVICE_KEYS.localAgent, 'LocalAgentRemote',
  'Local Agent conversation discovery and import.', LOCAL_AGENT_INVOCATIONS)
export const DRIVE_TYPERT_MANIFEST = manifest(REMOTE_PACKAGES.drive, REMOTE_SERVICE_KEYS.drive, 'CloudDriveRemote',
  'Cloud drive discovery and OpenList administration.', DRIVE_INVOCATIONS)
export const LOCAL_PLUGIN_TYPERT_MANIFEST = manifest(REMOTE_PACKAGES.localPlugin, REMOTE_SERVICE_KEYS.localPlugin, 'LocalPluginRemote',
  'Installed DSH plugins for the local-plugin source.', LOCAL_PLUGIN_INVOCATIONS)
