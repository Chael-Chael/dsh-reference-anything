import { createHash } from 'node:crypto'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { ReferenceAnythingError } from '../errors.ts'
import type { ConversationItem, ReferenceSnapshot, ReferenceWindow } from '../types.ts'
import type {
  AttachmentRecord, ChatProvider, ConversationRecord, RevisionRecord, SettingsRecord,
  StoredAttachment, StoredTurn, SyncStateRecord, TurnChunkRecord,
} from './spec.ts'
import { referenceAnythingDomainSpec } from './spec.ts'

export const REVISION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const TURNS_PER_CHUNK = 50

export interface ProviderConversationRow {
  provider: ChatProvider
  accountScope: string
  id: string
  title: string
  url: string
  createdAt: string
  updatedAt: string
  messageCount: number
  cursor: string
  partial: boolean
}

export interface ProviderTurnRow {
  conversationId: string
  ordinal: number
  messageId: string
  parentId: string
  branchId: string
  activeBranch: boolean
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  attachmentsJson: string
  partial: boolean
}

export interface ProviderStats {
  provider: ChatProvider
  conversations: number
  lastSyncedAt: string
  status: 'ready' | 'syncing' | 'error' | 'empty'
  error?: string
}

interface CursorPayload {
  v: 1
  ref: string
  revision: string
  nextOrdinal: number
}

type RefDomain = Domain<typeof referenceAnythingDomainSpec>

export class ConversationStore {
  readonly conversations: KvTable<string, ConversationRecord>
  readonly revisions: KvTable<string, RevisionRecord>
  readonly chunks: KvTable<string, TurnChunkRecord>
  readonly attachments: KvTable<string, AttachmentRecord>
  readonly syncStates: KvTable<string, SyncStateRecord>

  constructor(readonly domain: RefDomain) {
    this.conversations = domain.table('conversations')
    this.revisions = domain.table('revisions')
    this.chunks = domain.table('turn_chunks')
    this.attachments = domain.table('attachments')
    this.syncStates = domain.table('sync_states')
  }

  get settings(): SettingsRecord { return this.domain.global.get() }
  setSettings(settings: SettingsRecord): Promise<void> { return this.domain.global.set(settings) }

  static conversationKey(provider: ChatProvider, accountScope: string, externalId: string): string {
    return Buffer.from(JSON.stringify([provider, accountScope, externalId])).toString('base64url')
  }

  static parseConversationKey(key: string): [ChatProvider, string, string] {
    try {
      const value: unknown = JSON.parse(Buffer.from(key, 'base64url').toString('utf8'))
      if (!Array.isArray(value) || value.length !== 3 || !value.every(item => typeof item === 'string')) throw new Error()
      return value as [ChatProvider, string, string]
    } catch {
      throw new ReferenceAnythingError('web conversation reference id is malformed', 'REFERENCE_INVALID_URI')
    }
  }

  list(query: string, provider: ChatProvider | undefined, limit: number): Array<[string, ConversationRecord]> {
    const needle = query.trim().toLocaleLowerCase()
    return [...this.conversations.entries()]
      .filter(([, row]) => !row.remoteMissing && (!provider || row.provider === provider))
      .filter(([, row]) => needle === '' || row.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => Date.parse(b[1].updatedAt || b[1].syncedAt) - Date.parse(a[1].updatedAt || a[1].syncedAt))
      .slice(0, limit)
  }

  stats(providers: readonly ChatProvider[]): ProviderStats[] {
    return providers.map((provider) => {
      const conversations = [...this.conversations.entries()].filter(([, row]) => row.provider === provider && !row.remoteMissing)
      const states = [...this.syncStates.entries()].map(([, row]) => row).filter(row => row.provider === provider)
      const latest = states.sort((a, b) => Date.parse(b.lastSyncAt || '') - Date.parse(a.lastSyncAt || ''))[0]
      const latestSuccessful = states.find(row => row.status === 'idle')
      const latestLocalUpdate = conversations.reduce((latestAt, [, row]) => {
        const candidate = row.syncedAt || row.updatedAt
        return !latestAt || Date.parse(candidate) > Date.parse(latestAt) ? candidate : latestAt
      }, '')
      return {
        provider, conversations: conversations.length, lastSyncedAt: latestSuccessful?.lastSyncAt || latestLocalUpdate,
        status: latest?.status === 'running' ? 'syncing' : latest?.status === 'failed' ? 'error' : conversations.length ? 'ready' : 'empty',
        ...(latest?.error ? { error: latest.error } : {}),
      }
    })
  }

  async putConversation(row: ProviderConversationRow, accountScope: string): Promise<string> {
    const key = ConversationStore.conversationKey(row.provider, accountScope, row.id)
    const current = this.conversations.get(key)
    await this.conversations.put(key, {
      provider: row.provider, accountScope, externalId: row.id,
      title: row.title.trim() || row.id, url: row.url,
      ...(current?.currentRevision ? { currentRevision: current.currentRevision } : {}),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      messageCount: Math.max(0, Math.trunc(row.messageCount || 0)),
      partial: row.partial, remoteMissing: false, syncedAt: new Date().toISOString(),
    })
    return key
  }

  needsDetail(key: string, row: ProviderConversationRow, full: boolean): boolean {
    if (full) return true
    const current = this.conversations.get(key)
    return !current?.currentRevision || current.updatedAt !== row.updatedAt || current.partial !== row.partial
  }

  async commitRevision(conversationKey: string, rows: readonly ProviderTurnRow[]): Promise<string> {
    const conversation = this.conversations.get(conversationKey)
    if (!conversation) throw new ReferenceAnythingError('conversation disappeared before its revision commit', 'REFERENCE_NOT_FOUND')
    const activeRows = rows.filter(row => row.activeBranch !== false)
      .sort((a, b) => a.ordinal - b.ordinal)
    const turns = activeRows.map((row, ordinal): StoredTurn => ({
      ordinal, messageId: String(row.messageId || ordinal), parentId: String(row.parentId || ''),
      branchId: String(row.branchId || ''), role: row.role, text: String(row.text || ''),
      createdAt: String(row.createdAt || ''), attachments: parseAttachments(row.attachmentsJson),
    })).filter(turn => turn.text.trim() !== '' || turn.attachments.length > 0)
    const canonical = JSON.stringify(turns)
    const digest = createHash('sha256').update(canonical).digest('hex')
    const revision = `sha256:${digest}`
    const revisionKey = `${conversationKey}:${revision}`
    const now = Date.now()
    const chunkKeys: string[] = []
    for (let index = 0; index * TURNS_PER_CHUNK < turns.length; index++) {
      const chunkKey = `${revisionKey}:${index}`
      chunkKeys.push(chunkKey)
      await this.chunks.put(chunkKey, {
        conversationKey, revision, index,
        turns: turns.slice(index * TURNS_PER_CHUNK, (index + 1) * TURNS_PER_CHUNK),
      })
    }
    await this.revisions.put(revisionKey, {
      conversationKey, revision, contentHash: digest, turnCount: turns.length,
      activeBranch: activeRows.find(row => row.branchId)?.branchId || '', chunkKeys,
      partial: conversation.partial || activeRows.some(row => row.partial),
      syncedAt: new Date(now).toISOString(), expiresAt: new Date(now + REVISION_RETENTION_MS).toISOString(),
    })
    for (const turn of turns) for (const attachment of turn.attachments) {
      await this.attachments.put(`${revisionKey}:${turn.ordinal}:${attachment.attachmentId}`, {
        ...attachment, conversationKey, revision, ordinal: turn.ordinal,
      })
    }
    await this.conversations.put(conversationKey, {
      ...conversation, currentRevision: revision, messageCount: turns.length, syncedAt: new Date(now).toISOString(),
    })
    return revision
  }

  read(conversationKey: string, window: ReferenceWindow): ReferenceSnapshot {
    const conversation = this.conversations.get(conversationKey)
    if (!conversation?.currentRevision) throw new ReferenceAnythingError('conversation has not been synchronized', 'REFERENCE_NOT_FOUND')
    let revision = conversation.currentRevision
    let end: number | undefined = window.before
    if (window.cursor !== undefined) {
      const cursor = decodeCursor(window.cursor)
      if (cursor.ref !== conversationKey) throw new ReferenceAnythingError('cursor belongs to another reference', 'REFERENCE_INVALID_CURSOR')
      revision = cursor.revision
      end = cursor.nextOrdinal
    }
    const revisionRecord = this.revisions.get(`${conversationKey}:${revision}`)
    if (!revisionRecord) throw new ReferenceAnythingError('reference cursor revision has expired', 'REFERENCE_CURSOR_EXPIRED')
    if (revision !== conversation.currentRevision && Date.parse(revisionRecord.expiresAt) <= Date.now()) {
      throw new ReferenceAnythingError('reference cursor revision has expired', 'REFERENCE_CURSOR_EXPIRED')
    }
    const all = revisionRecord.chunkKeys.flatMap(key => this.chunks.get(key)?.turns ?? [])
    const boundedEnd = Math.max(0, Math.min(end ?? all.length, all.length))
    const start = Math.max(0, boundedEnd - Math.max(1, Math.trunc(window.limit)))
    const nextCursor = start > 0 ? encodeCursor({ v: 1, ref: conversationKey, revision, nextOrdinal: start }) : undefined
    return {
      ref: { source: 'web-chat', id: conversationKey }, label: conversation.title, origin: conversation.url,
      updatedAt: parseTimestamp(conversation.updatedAt), provider: conversation.provider, revision,
      partial: revisionRecord.partial, capturedAt: Date.parse(revisionRecord.syncedAt),
      body: {
        kind: 'conversation',
        items: all.slice(start, boundedEnd).map((turn): ConversationItem => ({
          role: turn.role, text: turn.text,
          ...(turn.attachments.length ? { attachments: turn.attachments.map(attachment => ({
            attachmentId: attachment.attachmentId, kind: attachment.kind, name: attachment.name,
            mimeType: attachment.mimeType, size: attachment.size, status: attachment.status,
          })) } : {}),
        })),
        startIndex: start, totalTurns: all.length, hasOlder: start > 0,
        ...(nextCursor ? { nextCursor } : {}), revision,
      },
    }
  }

  attachment(conversationKey: string, revision: string, attachmentId: string): AttachmentRecord | undefined {
    return [...this.attachments.entries()].find(([, row]) => row.conversationKey === conversationKey
      && row.revision === revision && row.attachmentId === attachmentId)?.[1]
  }

  async markRemoteMissing(provider: ChatProvider, accountScope: string, seen: ReadonlySet<string>): Promise<void> {
    for (const [key, row] of this.conversations.entries()) {
      if (row.provider !== provider || row.accountScope !== accountScope || seen.has(row.externalId) || row.remoteMissing) continue
      await this.conversations.put(key, { ...row, remoteMissing: true })
    }
  }

  async collectExpired(now = Date.now()): Promise<void> {
    for (const [key, revision] of this.revisions.entries()) {
      const current = this.conversations.get(revision.conversationKey)?.currentRevision
      if (revision.revision === current || Date.parse(revision.expiresAt) > now) continue
      for (const chunkKey of revision.chunkKeys) await this.chunks.delete(chunkKey)
      for (const [attachmentKey, row] of this.attachments.entries()) {
        if (row.conversationKey === revision.conversationKey && row.revision === revision.revision) await this.attachments.delete(attachmentKey)
      }
      await this.revisions.delete(key)
    }
  }
}

function parseAttachments(raw: string): StoredAttachment[] {
  try {
    const value: unknown = JSON.parse(raw || '[]')
    if (!Array.isArray(value)) return []
    return value.map((item, index) => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const status = row.status === 'available' || row.status === 'expired' ? row.status : 'unavailable'
      const locator = typeof row.locator === 'string' && row.locator ? row.locator : undefined
      const name = String(row.name ?? 'attachment')
      const mimeType = String(row.mimeType ?? '')
      return {
        attachmentId: String(row.attachmentId ?? row.id ?? index),
        kind: attachmentKind(row.kind ?? row.type, mimeType, name), name,
        mimeType, size: Number(row.size ?? 0), status,
        ...(locator ? { locator } : {}),
      }
    })
  } catch { return [] }
}

function attachmentKind(value: unknown, mimeType: string, name: string): 'image' | 'file' {
  if (value === 'image' || value === 'file') return value
  if (mimeType.toLowerCase().startsWith('image/')) return 'image'
  return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(name) ? 'image' : 'file'
}

function encodeCursor(value: CursorPayload): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const row = parsed as Partial<CursorPayload>
    if (row.v !== 1 || typeof row.ref !== 'string' || typeof row.revision !== 'string'
      || !Number.isInteger(row.nextOrdinal) || Number(row.nextOrdinal) < 0) throw new Error()
    return row as CursorPayload
  } catch {
    throw new ReferenceAnythingError('reference cursor is malformed', 'REFERENCE_INVALID_CURSOR')
  }
}

function parseTimestamp(value: string): number | undefined {
  if (!value) return undefined
  const number = Number(value)
  if (Number.isFinite(number)) return number < 10_000_000_000 ? number * 1000 : number
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : date
}
