import { createHash } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { ReferenceAnythingError } from '../../errors.ts'
import type { ReferenceSnapshot, ReferenceWindow } from '../../types.ts'

const turnSchema = z.object({ role: z.enum(['user', 'assistant']), text: z.string() })

export const agentMirrorSchema = z.object({
  kind: z.string(), id: z.string(), title: z.string(), cwd: z.string(), origin: z.string(),
  firstPrompt: z.string(), updatedAt: z.number(), syncedAt: z.number(),
  sourceVersion: z.string(), revision: z.string(), partial: z.boolean(),
  turns: z.array(turnSchema), summaryTurns: z.array(turnSchema),
})
export type AgentMirror = z.infer<typeof agentMirrorSchema>

/** Separate from the bookmark domain, so existing installations retain their schema. */
export const localAgentHistoryDomainSpec = defineDomain({
  name: 'reference_local_agent_history', version: 1,
  tables: { conversations: domainTable<string, AgentMirror>(agentMirrorSchema) },
})

const CURSOR_PREFIX = 'agent-history:'

/** A row is published in one durable write; a failed import cannot expose half a transcript. */
export class AgentMirrorStore {
  readonly conversations: KvTable<string, AgentMirror>

  constructor(readonly domain: Domain<typeof localAgentHistoryDomainSpec>) {
    this.conversations = domain.table('conversations')
  }

  async commit(input: Omit<AgentMirror, 'revision' | 'syncedAt'>): Promise<void> {
    const revision = createHash('sha256').update(JSON.stringify({
      turns: input.turns, summaryTurns: input.summaryTurns, partial: input.partial,
    })).digest('hex')
    const row = { ...input, revision, syncedAt: Date.now() }
    await this.conversations.put(input.id, row)
  }

  read(id: string, provider: string, window: ReferenceWindow): ReferenceSnapshot {
    const row = this.conversations.get(id)
    if (row === undefined) throw new ReferenceAnythingError('local agent history has not been synchronized', 'REFERENCE_NOT_FOUND')
    let end = window.before
    const detail = window.detail ?? 'full'
    if (window.cursor !== undefined) {
      const cursor = decodeCursor(window.cursor)
      if (cursor.id !== id) throw new ReferenceAnythingError('history cursor belongs to another transcript', 'REFERENCE_INVALID_CURSOR')
      if (cursor.revision !== row.revision) throw new ReferenceAnythingError('local agent history changed since this page was read', 'REFERENCE_CURSOR_EXPIRED')
      if (detail !== cursor.detail) throw new ReferenceAnythingError('history cursor uses a different detail level; restart paging with the requested detail', 'REFERENCE_INVALID_CURSOR')
      end = cursor.before
    }
    const turns = detail === 'summary' ? row.summaryTurns : row.turns
    const boundedEnd = Math.max(0, Math.min(end ?? turns.length, turns.length))
    const start = Math.max(0, boundedEnd - Math.max(1, Math.trunc(window.limit)))
    const nextCursor = start > 0 ? CURSOR_PREFIX + Buffer.from(JSON.stringify({
      v: 1, id, revision: row.revision, before: start, detail,
    })).toString('base64url') : undefined
    return {
      ref: { source: 'local-agent', id }, label: row.title, origin: row.origin, provider,
      updatedAt: row.updatedAt, syncedAt: row.syncedAt, revision: row.revision,
      partial: row.partial, capturedAt: row.syncedAt,
      body: {
        kind: 'conversation', items: turns.slice(start, boundedEnd), startIndex: start,
        totalTurns: turns.length, hasOlder: start > 0, revision: row.revision,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      },
    }
  }
}

export function isMirrorCursor(value: string): boolean { return value.startsWith(CURSOR_PREFIX) }

function decodeCursor(value: string): { id: string; revision: string; before: number; detail: 'summary' | 'full' } {
  try {
    if (!isMirrorCursor(value)) throw new Error('wrong cursor format')
    return z.object({
      v: z.literal(1), id: z.string(), revision: z.string(), before: z.number().int().nonnegative(),
      detail: z.enum(['summary', 'full']),
    }).parse(JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')))
  } catch {
    throw new ReferenceAnythingError('local agent history cursor is malformed', 'REFERENCE_INVALID_CURSOR')
  }
}
