import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { providerSchema, settingsRecordSchema } from './wire.ts'

/**
 * One local-agent transcript as the `@` menu sees it.
 *
 * `id` is the source-scoped `kind:relPath`, not a `dsh-ref:` URI — the client
 * wraps it, the way it does for web chats, so the `'local-agent'` source string
 * stays hardcoded in exactly one place. Deliberately carries no `origin`: the
 * absolute path adds nothing a menu row can use and everything a screen-share
 * leaks.
 */
export const agentCandidateSchema = z.object({ id: z.string(), kind: z.string(), label: z.string(), provider: z.string(), updatedAt: z.number().optional() }).readonly()
// `origin` is the drive's own display path, shown under the candidate. It is
// never a download URL: those are signed with the account's credential and
// must not cross this wire.
export const driveCandidateSchema = z.object({
  id: z.string(), label: z.string(), provider: z.string(),
  origin: z.string().optional(), updatedAt: z.number().optional(),
  searchIncomplete: z.boolean().optional(), isDirectory: z.boolean().optional(),
}).strict().readonly()

/**
 * Binds the calling session to the invocation, so the Host can scope a search
 * to the session's cwd. Reintroduced here after 0.3.0 handed file and session
 * lookup back to DSH's native Remotes and removed its last other caller.
 */
const agentLookup = { name: 'agent', wire: 'agentId', source: 'lookup' as const, lookup: 'agent' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', schema: z.string().min(1) } }

export const searchInputSchema = z.object({
  query: z.string(), provider: providerSchema.optional(), limit: z.number().int().min(1).max(100),
}).readonly()
export const matchedViaSchema = z.enum(['recent', 'title', 'content'])
export const searchResultSchema = z.object({
  uriId: z.string(), provider: providerSchema, title: z.string(), url: z.string(), updatedAt: z.string(),
  turnCount: z.number().int().nonnegative(), partial: z.boolean(), syncedAt: z.string(),
  matchedVia: matchedViaSchema, snippet: z.string().optional(),
}).readonly()
export const extensionStateSchema = z.enum(['connected', 'disconnected', 'profile-required', 'profile-disconnected', 'daemon-offline'])
export const healthSchema = z.object({
  version: z.string(), daemon: z.string(), pluginInstalled: z.boolean(),
  daemonRunning: z.boolean(), extensionConnected: z.boolean(), extensionState: extensionStateSchema,
  extensionVersion: z.string().optional(), profileCount: z.number().int().nonnegative().optional(),
  opencliCompatible: z.boolean(), daemonVersion: z.string().optional(), daemonStale: z.boolean(),
  connectivityOk: z.boolean(), connectivityChecked: z.boolean(), pluginVersion: z.string().optional(), adapterCommandsReady: z.boolean(), adapterCompatible: z.boolean(),
  versionError: z.string().optional(), daemonError: z.string().optional(), pluginError: z.string().optional(), doctorError: z.string().optional(),
}).readonly()
export const browserProfileSchema = z.object({ id: z.string(), alias: z.string().optional(), connected: z.boolean(), isDefault: z.boolean() }).readonly()
export const openCliDiscoverySchema = z.object({
  found: z.boolean(), executable: z.string(), version: z.string(), error: z.string().optional(),
}).readonly()
export const packageUpdateStatusSchema = z.object({
  currentVersion: z.string(), latestVersion: z.string(), updateAvailable: z.boolean(),
  checkedAt: z.number().int().nonnegative(), error: z.string().optional(),
}).readonly()
export const packageUpdateResultSchema = z.object({
  version: z.string(), restartRequired: z.boolean(),
}).readonly()
export const providerStatsSchema = z.object({
  provider: providerSchema, conversations: z.number().int().nonnegative(), lastSyncedAt: z.string(),
  status: z.enum(['ready', 'syncing', 'error', 'empty']), error: z.string().optional(),
}).readonly()
export const syncStartSchema = z.object({ providers: z.array(providerSchema).min(1), mode: z.enum(['incremental', 'full']) }).readonly()
export const providerSyncProgressSchema = z.object({
  provider: providerSchema,
  phase: z.enum(['listing', 'syncing', 'complete', 'failed', 'cancelled']),
  completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), error: z.string().optional(),
}).readonly()
export const syncStatusSchema = z.object({
  jobId: z.string(), status: z.enum(['running', 'complete', 'partial', 'cancelled', 'failed']),
  providers: z.array(providerSchema), provider: providerSchema.optional(), completed: z.number(), total: z.number(),
  providerProgress: z.array(providerSyncProgressSchema), error: z.string().optional(),
}).readonly()
export const jobInputSchema = z.object({ jobId: z.string().min(1) }).readonly()

export const browseInputSchema = z.object({
  query: z.string(), provider: providerSchema.optional(),
  limit: z.number().int().min(1).max(100), offset: z.number().int().nonnegative(),
}).readonly()
export const managedConversationSchema = z.object({
  uriId: z.string(), provider: providerSchema, title: z.string(), url: z.string(), updatedAt: z.string(),
  turnCount: z.number().int().nonnegative(), partial: z.boolean(), syncedAt: z.string(), remoteMissing: z.boolean(),
}).readonly()
export const browsePageSchema = z.object({
  items: z.array(managedConversationSchema), total: z.number().int().nonnegative(),
}).readonly()
export const deleteInputSchema = z.object({ uriId: z.string().min(1) }).readonly()
export const storageStatsSchema = z.object({
  bytes: z.number().int().nonnegative(), conversations: z.number().int().nonnegative(),
  remoteMissing: z.number().int().nonnegative().default(0), oldAccountConversations: z.number().int().nonnegative().default(0),
}).readonly()
export const clearProviderInputSchema = z.object({ provider: providerSchema }).readonly()
export const clearOlderInputSchema = z.object({ days: z.number().int().min(1).max(36500) }).readonly()
export const providerSyncStateSchema = z.object({
  provider: providerSchema, status: z.enum(['idle', 'running', 'cancelled', 'failed']),
  lastSyncAt: z.string(), lastCompleteScanAt: z.string(), error: z.string(),
}).readonly()
// OpenList wire DTOs intentionally omit every credential, storage addition,
// raw/signed URL, and server-supplied diagnostic.  The Host keeps those in its
// restricted credential file and translates failures to a generic message.
export const openListStatusSchema = z.object({
  state: z.enum(['install', 'downloading', 'running', 'failed', 'upgrade']), installed: z.boolean(),
  mode: z.enum(['managed', 'external']).optional(), version: z.string().optional(), endpoint: z.string().optional(),
  supportsRollback: z.boolean(), upgradeAvailable: z.boolean(), newerVersion: z.boolean().optional(), error: z.string().optional(),
}).strict().readonly()
export const openListDriverFieldSchema = z.object({
  name: z.string(), label: z.string(), type: z.enum(['text', 'password', 'number', 'boolean', 'select']), secret: z.boolean(), required: z.boolean(), hasDefault: z.boolean().optional(), default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ label: z.string(), value: z.string() }).readonly()).optional(),
}).strict().readonly()
export const openListDriverSchema = z.object({ name: z.string(), description: z.string().optional(), quickAuth: z.boolean(), fields: z.array(openListDriverFieldSchema) }).strict().readonly()
export const openListMountSchema = z.object({
  id: z.string(), name: z.string(), driver: z.string(), enabled: z.boolean(), status: z.enum(['ready', 'disabled', 'error']).optional(), error: z.string().optional(),
  capacityUsed: z.number().nonnegative().optional(), capacityTotal: z.number().nonnegative().optional(),
  indexStatus: z.enum(['idle', 'running', 'complete', 'failed']).optional(), indexProgress: z.number().min(0).max(1).optional(), indexCount: z.number().nonnegative().optional(),
}).strict().readonly()
export const openListExternalConnectSchema = z.object({ endpoint: z.string().min(1), username: z.string().optional(), password: z.string().optional(), token: z.string().optional() }).strict().readonly()
export const openListMountCreateSchema = z.object({ id: z.string().min(1).optional(), mountPath: z.string().min(1), driver: z.string().min(1), addition: z.record(z.string(), z.unknown()), order: z.number().int().optional(), remark: z.string().optional() }).strict().readonly()
export const openListMountInputSchema = z.object({ id: z.string().min(1) }).strict().readonly()
export const openListDisableMountSchema = z.object({ id: z.string().min(1), disabled: z.boolean().optional() }).strict().readonly()
export const openListUpgradeInputSchema = z.object({ rollback: z.boolean().optional() }).strict().readonly()

export const REFERENCE_ANYTHING_INVOCATIONS: readonly InvocationDescriptor[] = [
  descriptor('agentSearch', [agentLookup, { name: 'input', wire: 'input', source: 'json', codec: strict('AgentSearchInput', z.object({ query: z.string(), limit: z.number().int().min(1).max(100) }).readonly()) }], strict('AgentCandidate[]', z.array(agentCandidateSchema)), true),
  // No session lookup, unlike `agentSearch`: a drive is the same drive from
  // every workspace, so there is nothing to scope the query to.
  descriptor('driveSearch', [{ name: 'input', wire: 'input', source: 'json', codec: strict('DriveSearchInput', z.object({ query: z.string(), limit: z.number().int().min(1).max(100) }).readonly()) }], strict('DriveCandidate[]', z.array(driveCandidateSchema)), true),
  descriptor('search', [{ name: 'input', wire: 'input', source: 'json', codec: strict('SearchInput', searchInputSchema) }], strict('SearchResult[]', z.array(searchResultSchema)), true),
  descriptor('health', [], strict('Health', healthSchema), true),
  descriptor('quickHealth', [], strict('Health', healthSchema), true),
  descriptor('profiles', [], strict('BrowserProfile[]', z.array(browserProfileSchema)), true),
  descriptor('discoverOpenCli', [], strict('OpenCliDiscovery', openCliDiscoverySchema), true),
  descriptor('installOpenCli', [], strict('OpenCliDiscovery', openCliDiscoverySchema), true),
  descriptor('installAdapter', [], strict('Boolean', z.boolean()), true),
  descriptor('restartDaemon', [], strict('Boolean', z.boolean()), true),
  descriptor('updateStatus', [], strict('PackageUpdateStatus', packageUpdateStatusSchema), true),
  descriptor('checkUpdate', [], strict('PackageUpdateStatus', packageUpdateStatusSchema), true),
  descriptor('installUpdate', [], strict('PackageUpdateResult', packageUpdateResultSchema), true),
  descriptor('stats', [], strict('ProviderStats[]', z.array(providerStatsSchema))),
  descriptor('syncStart', [{ name: 'input', wire: 'input', source: 'json', codec: strict('SyncStart', syncStartSchema) }], strict('JobId', z.string())),
  descriptor('syncStatus', [{ name: 'input', wire: 'input', source: 'json', codec: strict('JobInput', jobInputSchema) }], strict('SyncStatus?', syncStatusSchema.optional())),
  descriptor('syncCancel', [{ name: 'input', wire: 'input', source: 'json', codec: strict('JobInput', jobInputSchema) }], strict('Boolean', z.boolean())),
  descriptor('settingsGet', [], strict('Settings', settingsRecordSchema)),
  descriptor('settingsUpdate', [{ name: 'settings', wire: 'settings', source: 'json', codec: strict('Settings', settingsRecordSchema) }], strict('Settings', settingsRecordSchema)),
  descriptor('browse', [{ name: 'input', wire: 'input', source: 'json', codec: strict('BrowseInput', browseInputSchema) }], strict('BrowsePage', browsePageSchema), true),
  descriptor('deleteConversation', [{ name: 'input', wire: 'input', source: 'json', codec: strict('DeleteInput', deleteInputSchema) }], strict('Boolean', z.boolean()), true),
  descriptor('storageStats', [], strict('StorageStats', storageStatsSchema)),
  descriptor('clearProvider', [{ name: 'input', wire: 'input', source: 'json', codec: strict('ClearProviderInput', clearProviderInputSchema) }], strict('Count', z.number().int().nonnegative()), true),
  descriptor('clearOlder', [{ name: 'input', wire: 'input', source: 'json', codec: strict('ClearOlderInput', clearOlderInputSchema) }], strict('Count', z.number().int().nonnegative()), true),
  descriptor('clearRemoteMissing', [], strict('Count', z.number().int().nonnegative()), true),
  descriptor('clearOldAccounts', [], strict('Count', z.number().int().nonnegative()), true),
  descriptor('syncStates', [], strict('ProviderSyncState[]', z.array(providerSyncStateSchema))),
  descriptor('openListStatus', [], strict('OpenListStatus', openListStatusSchema), true),
  descriptor('openListInstall', [], strict('OpenListStatus', openListStatusSchema), true),
  descriptor('openListUpgrade', [{ name: 'input', wire: 'input', source: 'json', codec: strict('OpenListUpgradeInput', openListUpgradeInputSchema) }], strict('OpenListStatus', openListStatusSchema), true),
  descriptor('openListConnectExternal', [{ name: 'input', wire: 'input', source: 'json', codec: strict('OpenListExternalConnect', openListExternalConnectSchema) }], strict('OpenListStatus', openListStatusSchema), true),
  descriptor('openListDisconnect', [], strict('OpenListStatus', openListStatusSchema), true),
  descriptor('openListDrivers', [], strict('OpenListDriver[]', z.array(openListDriverSchema)), true),
  descriptor('openListMounts', [], strict('OpenListMount[]', z.array(openListMountSchema)), true),
  descriptor('openListCreateMount', [{ name: 'input', wire: 'input', source: 'json', codec: strict('OpenListMountCreate', openListMountCreateSchema) }], strict('OpenListMount', openListMountSchema), true),
  descriptor('openListDisableMount', [{ name: 'input', wire: 'input', source: 'json', codec: strict('OpenListDisableMountInput', openListDisableMountSchema) }], strict('Boolean', z.boolean()), true),
  descriptor('openListRemoveMount', [{ name: 'input', wire: 'input', source: 'json', codec: strict('OpenListMountInput', openListMountInputSchema) }], strict('Boolean', z.boolean()), true),
  descriptor('openListReindex', [{ name: 'input', wire: 'input', source: 'json', codec: strict('OpenListMountInput', openListMountInputSchema) }], strict('OpenListReindex', z.object({ supported: z.boolean(), reason: z.string().optional() }).readonly()), true),
]

function strict(type: string, schema: z.ZodType): { mode: 'strict'; typeSymbol: string; schema: z.ZodType } {
  return { mode: 'strict', typeSymbol: `dsh-reference-anything#${type}`, schema }
}

function descriptor(
  method: string,
  parameters: InvocationDescriptor['parameters'],
  result: NonNullable<InvocationDescriptor['result']>,
  cancelled = false,
): InvocationDescriptor {
  return {
    id: `dsh-reference-anything#referenceAnything/${method}`,
    service: 'referenceAnything', namespace: 'referenceAnything', method,
    invocation: { kind: 'direct' }, parameters,
    ...(cancelled ? { cancellation: { parameter: 'signal' } } : {}), result,
  }
}
