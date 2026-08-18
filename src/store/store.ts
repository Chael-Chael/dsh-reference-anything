import { createHash } from 'node:crypto'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { ReferenceAnythingError } from '../errors.ts'
import { compareMatches, scoreTitle, snippet, type TitleMatch } from '../search.ts'
import type { ConversationItem, ReferenceSnapshot, ReferenceWindow } from '../types.ts'
import type {
  AttachmentRecord, ChatProvider, ConversationRecord, RevisionRecord, SettingsRecord,
  StoredAttachment, StoredTurn, SyncStateRecord, TurnChunkRecord,
} from './spec.ts'
import type { referenceAnythingDomainSpec } from './spec.ts'

export const REVISION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const TURNS_PER_CHUNK = 50

/**
 * Shortest query that may trigger a body scan. One character matches almost
 * every conversation, which is neither useful nor worth the scan.
 */
export const CONTENT_MIN_QUERY = 2
/** Conversations a single body scan may examine, newest first. */
export const CONTENT_SCAN_LIMIT = 300
/** Characters of one conversation a body scan reads before giving up on it. */
export const CONTENT_SCAN_CHARS = 200_000

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

/** Durable, per-provider sync status — survives page reloads, unlike any one in-flight job's status. */
export interface ProviderSyncState {
  provider: ChatProvider
  status: 'idle' | 'running' | 'cancelled' | 'failed'
  lastSyncAt: string
  lastCompleteScanAt: string
  error: string
}

/** How a conversation earned its place in a result list. */
export type MatchedVia = 'recent' | 'title' | 'content'

/** One scored discovery result. */
export interface ConversationMatch {
  readonly key: string
  readonly row: ConversationRecord
  readonly via: MatchedVia
  /** Excerpt around the body hit; UI-only, and present only when `via` is `content`. */
  readonly snippet?: string
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

  /** Remove every persisted transcript while retaining the title directory. */
  async clearMirrorContent(): Promise<void> {
    for (const [key] of this.attachments.entries()) await retryWindowsReplace(() => this.attachments.delete(key))
    for (const [key] of this.chunks.entries()) await retryWindowsReplace(() => this.chunks.delete(key))
    for (const [key] of this.revisions.entries()) await retryWindowsReplace(() => this.revisions.delete(key))
    for (const [key, row] of this.conversations.entries()) {
      if (row.currentRevision === undefined) continue
      const { currentRevision: _revision, ...metadata } = row
      await retryWindowsReplace(() => this.conversations.put(key, metadata))
    }
  }

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

  /**
   * Rank conversations for a discovery surface, best match first.
   *
   * Three passes, each only reached when the one before it left room. Titles
   * are matched loosely (see {@link scoreTitle}) because the `@` mention
   * query can never contain a space; bodies are searched only when titles
   * came up short, which is what makes the auto-generated "New chat" titles
   * findable at all without paying for a scan on every keystroke.
   * @param query - user query, provider prefix already stripped.
   * @param provider - restrict to one provider.
   * @param limit - maximum results.
   * @returns matches, best first, capped at `limit`.
   */
  list(query: string, provider: ChatProvider | undefined, limit: number): ConversationMatch[] {
    const needle = query.trim()
    const candidates = [...this.conversations.entries()]
      .filter(([, row]) => !row.remoteMissing && (!provider || row.provider === provider))
      .sort((a, b) => recency(b[1]) - recency(a[1]))
    if (needle === '') {
      return candidates.slice(0, limit).map(([key, row]) => ({ key, row, via: 'recent' as const }))
    }

    const titled: Array<{ key: string; row: ConversationRecord; match: TitleMatch }> = []
    const unmatched: Array<[string, ConversationRecord]> = []
    for (const [key, row] of candidates) {
      const match = scoreTitle(row.title, needle)
      if (match) titled.push({ key, row, match })
      else unmatched.push([key, row])
    }
    // `candidates` is already newest-first and sort is stable, so equal
    // matches keep that order without re-comparing timestamps.
    titled.sort((a, b) => compareMatches(a.match, b.match))

    const results: ConversationMatch[] = titled.slice(0, limit)
      .map(({ key, row }) => ({ key, row, via: 'title' as const }))
    if (results.length >= limit || needle.length < CONTENT_MIN_QUERY) return results

    const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu')
    for (const [key, row] of unmatched.slice(0, CONTENT_SCAN_LIMIT)) {
      const hit = this.findInBody(key, row, pattern)
      if (!hit) continue
      results.push({ key, row, via: 'content', snippet: hit })
      if (results.length >= limit) break
    }
    return results
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

  /**
   * Search one conversation's stored turns for `pattern`.
   *
   * Reads chunks by key off the current revision rather than iterating the
   * chunk table, whose `entries()` copies every record in the domain. Matching
   * runs against the turn text in place — no lowercased copy is built, so the
   * excerpt keeps its original casing and nothing is cached beside the
   * records the domain already holds in memory.
   * @returns the excerpt around the first hit, or undefined when there is none.
   */
  private findInBody(conversationKey: string, row: ConversationRecord, pattern: RegExp): string | undefined {
    if (!row.currentRevision) return undefined
    const revision = this.revisions.get(`${conversationKey}:${row.currentRevision}`)
    if (!revision) return undefined
    let budget = CONTENT_SCAN_CHARS
    for (const chunkKey of revision.chunkKeys) {
      for (const turn of this.chunks.get(chunkKey)?.turns ?? []) {
        const at = turn.text.search(pattern)
        if (at >= 0) return snippet(turn.text, at)
        budget -= turn.text.length
        if (budget <= 0) return undefined
      }
    }
    return undefined
  }

  /**
   * Page through every stored conversation, including ones the provider no
   * longer lists — a management view needs to surface `remoteMissing` rows
   * so they can be cleaned up, unlike {@link list}'s mention/search surface.
   */
  page(
    query: string, provider: ChatProvider | undefined, limit: number, offset: number,
  ): { items: Array<[string, ConversationRecord]>; total: number } {
    const needle = query.trim().toLocaleLowerCase()
    const filtered = [...this.conversations.entries()]
      .filter(([, row]) => !provider || row.provider === provider)
      .filter(([, row]) => needle === '' || row.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => recency(b[1]) - recency(a[1]))
    return { items: filtered.slice(offset, offset + limit), total: filtered.length }
  }

  /**
   * Permanently purge one conversation and everything derived from it.
   *
   * A sync job racing this call can resurrect a broken row (see
   * {@link WebChatHistoryService.remove}, which guards against that at the
   * service layer) — this method itself makes no atomicity promise beyond
   * "delete whatever currently references this key."
   * @returns whether a conversation with this key existed.
   */
  async remove(conversationKey: string): Promise<boolean> {
    if (!this.conversations.get(conversationKey)) return false
    for (const [key, revision] of this.revisions.entries()) {
      if (revision.conversationKey !== conversationKey) continue
      for (const chunkKey of revision.chunkKeys) await this.chunks.delete(chunkKey)
      await this.revisions.delete(key)
    }
    for (const [key, row] of this.attachments.entries()) {
      if (row.conversationKey === conversationKey) await this.attachments.delete(key)
    }
    await this.conversations.delete(conversationKey)
    return true
  }

  /**
   * One row per provider, aggregated across every account scope it has ever
   * synced under. `status`/`error`/`lastSyncAt` come from whichever attempt is
   * most recent — success or failure — so a background failure is never
   * hidden behind an older successful scope's row. `lastCompleteScanAt` is
   * the max across all of that provider's rows, so it never regresses just
   * because the latest attempt failed before finishing.
   */
  syncStateSummary(): ProviderSyncState[] {
    const freshest = new Map<ChatProvider, ProviderSyncState>()
    const lastCompleteScan = new Map<ChatProvider, string>()
    for (const [, row] of this.syncStates.entries()) {
      const current = freshest.get(row.provider)
      if (!current || Date.parse(row.lastSyncAt || '') > Date.parse(current.lastSyncAt || '')) {
        freshest.set(row.provider, {
          provider: row.provider, status: row.status, lastSyncAt: row.lastSyncAt,
          lastCompleteScanAt: row.lastCompleteScanAt, error: row.error,
        })
      }
      // `!seen` short-circuits the first real value in — `Date.parse('') > Date.parse(x)` is always
      // false (NaN comparisons never succeed), so comparing straight through would silently drop it.
      if (row.lastCompleteScanAt) {
        const seen = lastCompleteScan.get(row.provider)
        if (!seen || Date.parse(row.lastCompleteScanAt) > Date.parse(seen)) lastCompleteScan.set(row.provider, row.lastCompleteScanAt)
      }
    }
    return [...freshest.values()].map(state => ({ ...state, lastCompleteScanAt: lastCompleteScan.get(state.provider) || state.lastCompleteScanAt }))
  }

  /**
   * Record what the provider's listing says about one conversation.
   *
   * Skips the write when nothing but `syncedAt` would change: under the JSON
   * storage backend a single record write re-serializes and fsyncs the entire
   * domain, so an unchanged history would otherwise cost one whole-mirror
   * rewrite per conversation on every pass.
   * @returns the conversation key, written or not.
   */
  async putConversation(row: ProviderConversationRow, accountScope: string): Promise<string> {
    const key = ConversationStore.conversationKey(row.provider, accountScope, row.id)
    const current = this.conversations.get(key)
    // Directory rows only discover conversations. Once a detail snapshot is
    // mirrored, its metadata stays authoritative until the matching detail
    // fetch succeeds and commitRevision atomically publishes the provider's
    // listing timestamp.
    const hasMirroredTurns = current?.currentRevision !== undefined
    const next: ConversationRecord = {
      provider: row.provider, accountScope, externalId: row.id,
      title: row.title.trim() || row.id, url: row.url,
      ...(current?.currentRevision ? { currentRevision: current.currentRevision } : {}),
      createdAt: row.createdAt || current?.createdAt || '',
      updatedAt: hasMirroredTurns ? current.updatedAt : row.updatedAt.trim(),
      // Once a revision exists its turn count is the honest one: the provider
      // counts turns this mirror drops (empty ones), so letting its number
      // back in would flip the value on every metadata refresh.
      messageCount: current?.currentRevision ? current.messageCount : Math.max(0, Math.trunc(row.messageCount || 0)),
      partial: row.partial, remoteMissing: false, syncedAt: new Date().toISOString(),
    }
    if (current && sameConversation(current, next)) return key
    await this.conversations.put(key, next)
    return key
  }

  needsDetail(key: string, row: ProviderConversationRow, full: boolean): boolean {
    if (full) return true
    const current = this.conversations.get(key)
    return !current?.currentRevision || current.updatedAt !== row.updatedAt || current.partial !== row.partial
  }

  /**
   * Store one fetched transcript as an immutable revision and make it current.
   *
   * @param conversationKey - the conversation being updated; it must already exist.
   * @param rows - the provider's turns, in any order.
   * @param next - the listing row this transcript was fetched for. Supplying
   * it folds the metadata update into the same write that publishes the
   * revision, which is what keeps `updatedAt` — the only change signal
   * {@link needsDetail} has — from advancing ahead of the content it describes.
   * @returns the revision id, `sha256:<hex>` over the normalized turns.
   */
  async commitRevision(
    conversationKey: string, rows: readonly ProviderTurnRow[], next?: ProviderConversationRow,
  ): Promise<string> {
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
    // Direct callers without a provider listing row retain the best timestamp
    // embedded in the transcript. The sync path supplies `next`, whose
    // provider timestamp is the authoritative update watermark.
    const newestTurnAt = next ? '' : turns.reduce<string>((latest, turn) => {
      const latestAt = parseTimestamp(latest)
      const candidateAt = parseTimestamp(turn.createdAt)
      return candidateAt !== undefined && (latestAt === undefined || candidateAt > latestAt) ? turn.createdAt : latest
    }, '')
    const merged: ConversationRecord = {
      ...conversation,
      ...(next ? {
        title: next.title.trim() || next.id, url: next.url, createdAt: next.createdAt,
        updatedAt: next.updatedAt, partial: next.partial, remoteMissing: false,
      } : newestTurnAt ? { updatedAt: newestTurnAt } : {}),
      currentRevision: revision, messageCount: turns.length, syncedAt: new Date(now).toISOString(),
    }
    // The revision id IS the content hash, so an unchanged transcript commits
    // back to the key it already occupies. Rewriting its chunks and
    // attachments would cost one whole-domain rewrite each (JSON backend) to
    // store bytes that are already there — the common case for a full rescan,
    // and for any conversation whose `updatedAt` moved without its content.
    if (conversation.currentRevision === revision && this.revisions.get(revisionKey)) {
      await this.conversations.put(conversationKey, merged)
      return revision
    }
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
      partial: merged.partial || activeRows.some(row => row.partial),
      syncedAt: new Date(now).toISOString(), expiresAt: new Date(now + REVISION_RETENTION_MS).toISOString(),
    })
    for (const turn of turns) for (const attachment of turn.attachments) {
      await this.attachments.put(`${revisionKey}:${turn.ordinal}:${attachment.attachmentId}`, {
        ...attachment, conversationKey, revision, ordinal: turn.ordinal,
      })
    }
    await this.conversations.put(conversationKey, merged)
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
    const expired: Array<[string, RevisionRecord]> = []
    for (const [key, revision] of this.revisions.entries()) {
      const current = this.conversations.get(revision.conversationKey)?.currentRevision
      if (revision.revision === current || Date.parse(revision.expiresAt) > now) continue
      expired.push([key, revision])
    }
    if (expired.length === 0) return
    // One pass over the attachments table for the whole sweep. Re-scanning it
    // per expired revision was quadratic, and `entries()` copies every record
    // each time it is called.
    const byRevision = new Map<string, string[]>()
    for (const [key, row] of this.attachments.entries()) {
      const group = `${row.conversationKey}\u0000${row.revision}`
      const bucket = byRevision.get(group)
      if (bucket) bucket.push(key)
      else byRevision.set(group, [key])
    }
    for (const [key, revision] of expired) {
      for (const chunkKey of revision.chunkKeys) await this.chunks.delete(chunkKey)
      for (const attachmentKey of byRevision.get(`${revision.conversationKey}\u0000${revision.revision}`) ?? []) {
        await this.attachments.delete(attachmentKey)
      }
      await this.revisions.delete(key)
    }
  }
}

/** Antivirus/indexers may briefly hold the JSON target across its atomic rename on Windows. */
async function retryWindowsReplace<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY') || attempt >= 7) throw error
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt))
    }
  }
}

/** Whether two conversation records differ in anything but `syncedAt`, which always does. */
function sameConversation(a: ConversationRecord, b: ConversationRecord): boolean {
  return a.provider === b.provider && a.accountScope === b.accountScope && a.externalId === b.externalId
    && a.title === b.title && a.url === b.url && a.currentRevision === b.currentRevision
    && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && a.messageCount === b.messageCount
    && a.partial === b.partial && a.remoteMissing === b.remoteMissing
}

/** Sort key for "most recently active", falling back to when we last saw it. */
function recency(row: ConversationRecord): number {
  const parsed = Date.parse(row.updatedAt || row.syncedAt)
  return Number.isNaN(parsed) ? 0 : parsed
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
