import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { providerSchema, settingsRecordSchema } from '../wire.ts'
import type { ChatProvider, SettingsRecord } from '../wire.ts'

export { providerSchema, settingsRecordSchema }
export type { ChatProvider, SettingsRecord }

export const storedAttachmentSchema = z.object({
  attachmentId: z.string(),
  kind: z.enum(['image', 'file']).default('file'),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  status: z.enum(['available', 'unavailable', 'expired']),
  locator: z.string().optional(),
})
export type StoredAttachment = z.infer<typeof storedAttachmentSchema>

export const storedTurnSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  messageId: z.string(),
  parentId: z.string(),
  branchId: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  createdAt: z.string(),
  attachments: z.array(storedAttachmentSchema),
})
export type StoredTurn = z.infer<typeof storedTurnSchema>

export const conversationRecordSchema = z.object({
  provider: providerSchema,
  accountScope: z.string(),
  externalId: z.string(),
  title: z.string(),
  url: z.string(),
  currentRevision: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  partial: z.boolean(),
  remoteMissing: z.boolean(),
  syncedAt: z.string(),
})
export type ConversationRecord = z.infer<typeof conversationRecordSchema>

export const revisionRecordSchema = z.object({
  conversationKey: z.string(),
  revision: z.string(),
  contentHash: z.string(),
  turnCount: z.number().int().nonnegative(),
  activeBranch: z.string(),
  chunkKeys: z.array(z.string()),
  partial: z.boolean(),
  syncedAt: z.string(),
  expiresAt: z.string(),
})
export type RevisionRecord = z.infer<typeof revisionRecordSchema>

export const turnChunkRecordSchema = z.object({
  conversationKey: z.string(),
  revision: z.string(),
  index: z.number().int().nonnegative(),
  turns: z.array(storedTurnSchema).max(50),
})
export type TurnChunkRecord = z.infer<typeof turnChunkRecordSchema>

export const attachmentRecordSchema = storedAttachmentSchema.extend({
  conversationKey: z.string(),
  revision: z.string(),
  ordinal: z.number().int().nonnegative(),
})
export type AttachmentRecord = z.infer<typeof attachmentRecordSchema>

export const syncStateRecordSchema = z.object({
  provider: providerSchema,
  profile: z.string(),
  accountScope: z.string(),
  cursor: z.string(),
  status: z.enum(['idle', 'running', 'cancelled', 'failed']),
  lastSyncAt: z.string(),
  lastCompleteScanAt: z.string(),
  error: z.string(),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  // Both carry `.default()` so rows written before background sync existed
  // still parse at the durable read boundary — the domain validates with
  // `schema.parse`, so the default lands in memory and no version bump (which
  // would reject the whole medium) is needed.
  /** Provider-level failures in a row; drives how long auto-sync skips this provider. */
  consecutiveFailures: z.number().int().nonnegative().default(0),
  /** ISO instant before which auto-sync leaves this provider alone. Manual syncs ignore it. */
  nextEligibleAt: z.string().default(''),
})
export type SyncStateRecord = z.infer<typeof syncStateRecordSchema>

export const referenceAnythingDomainSpec = defineDomain({
  name: 'reference_anything',
  version: 1,
  global: {
    schema: settingsRecordSchema,
    initial: { opencliPath: 'opencli', profile: '', detailConcurrency: 8, autoSync: false, syncOnStartup: false, autoSyncMinutes: 60, historyMode: 'metadata-only' as const, enabledProviders: [...providerSchema.options], maxReadTurns: 10 },
  },
  tables: {
    conversations: domainTable<string, ConversationRecord>(conversationRecordSchema),
    revisions: domainTable<string, RevisionRecord>(revisionRecordSchema),
    turn_chunks: domainTable<string, TurnChunkRecord>(turnChunkRecordSchema),
    attachments: domainTable<string, AttachmentRecord>(attachmentRecordSchema),
    sync_states: domainTable<string, SyncStateRecord>(syncStateRecordSchema),
  },
})
