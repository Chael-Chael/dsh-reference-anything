/**
 * Reads zcode's SQLite history.
 *
 * zcode (z.ai's CLI) keeps every session in `~/.zcode/cli/db/db.sqlite` with the
 * same three tables opencode uses, which is why the part-level projection is
 * shared. Three rules are its own:
 *
 * - **Subagent sessions are hidden.** A row with a `parent_id` is work zcode
 *   spawned for itself; listing it would put a fragment of a conversation in the
 *   menu beside the conversation it belongs to.
 * - **System prompts are dropped.** zcode stores them as `role: 'system'`
 *   messages in the same table as the conversation.
 * - **Compaction is recorded twice.** A `compaction` part carries the summary,
 *   and older builds hang it on the message instead. Either way the carrier is a
 *   marker rather than something the user said, so the message is dropped and
 *   the summary re-emitted once, ahead of the turns that survived.
 *
 * @module dsh-reference-anything/local-agent/adapters/zcode
 */

import { join } from 'node:path'
import type { ParsedTurn, QueryAdapter, SessionTurns, SqliteReader, TranscriptSession } from '../types.ts'
import { COMPACTION_MARKER, createSharedState, flushAssistant, normalizeTitle, parseTimestamp } from './shared.ts'
import { readSessionMessages, stepSessionMessage } from './sqlite-shared.ts'
import type { SessionMessage } from './sqlite-shared.ts'

/**
 * The select list both queries share, with `$recency` standing for whichever
 * timestamp column this build has. Aliased so the projection below reads one
 * column name regardless.
 */
const SESSION_FIELDS = 'id, title, directory, $recency AS recency'

/** Reads zcode's session database. */
export const zcodeAdapter: QueryAdapter = {
  kind: 'zcode',
  displayName: 'zcode',
  query: true,

  defaultRoots(home: string): readonly string[] {
    return [join(home, '.zcode', 'cli', 'db')]
  },

  matches(relativePath: string): boolean {
    // Exact, so SQLite's `-wal` and `-shm` sidecars are not opened as databases.
    return relativePath.split(/[\\/]/u).at(-1) === 'db.sqlite'
  },

  sessions(db: SqliteReader, limit: number): readonly TranscriptSession[] {
    const columns = db.columns('session')
    if (columns.size === 0) return []
    // A build that predates `parent_id` has no subagent rows to exclude, so the
    // predicate is dropped rather than made into a query error.
    const scope = columns.has('parent_id') ? "WHERE parent_id IS NULL OR parent_id = ''" : ''
    const recency = columns.has('time_updated') ? 'time_updated' : 'time_created'
    const rows = db.all(
      `SELECT ${SESSION_FIELDS.replace('$recency', recency)} FROM session ${scope} ORDER BY recency DESC, id DESC LIMIT ?`,
      Math.max(1, Math.trunc(limit)),
    )
    const sessions: TranscriptSession[] = []
    for (const row of rows) {
      const session = toSession(row)
      if (session !== undefined) sessions.push(session)
    }
    return sessions
  },

  session(db: SqliteReader, sessionId: string): TranscriptSession | undefined {
    const columns = db.columns('session')
    if (columns.size === 0) return undefined
    const recency = columns.has('time_updated') ? 'time_updated' : 'time_created'
    // No `parent_id` predicate here: the subagent filter is about what the menu
    // offers, and a caller holding an id has already got past the menu.
    const [row] = db.all(
      `SELECT ${SESSION_FIELDS.replace('$recency', recency)} FROM session WHERE id = ? LIMIT 1`,
      sessionId,
    )
    return row === undefined ? undefined : toSession(row)
  },

  turns(db, sessionId, options, maxRecords): SessionTurns {
    const { messages, truncated } = readSessionMessages(db, sessionId, maxRecords)
    const state = createSharedState()
    const items: ParsedTurn[] = []
    let summary: string | undefined
    const conversation: SessionMessage[] = []
    for (const message of messages) {
      if (message.data['role'] === 'system') continue
      // Last compaction wins: an older summary describes history a newer one has
      // already folded into itself.
      const onPart = partSummary(message)
      if (onPart !== undefined) summary = onPart
      const onMessage = messageSummary(message)
      if (onMessage !== undefined) {
        // The older shape puts the summary on a message whose own body is just
        // a lead-in, so the whole message goes; the part shape marks up a
        // message that still carries conversation, and only the part goes.
        summary = onMessage
        continue
      }
      conversation.push(message)
    }
    if (summary !== undefined) items.push({ role: 'assistant', text: `${COMPACTION_MARKER}\n\n${summary}` })
    for (const message of conversation) items.push(...stepSessionMessage(state, message, options))
    items.push(...flushAssistant(state))
    return { items, truncated, compacted: summary !== undefined }
  },
}

/**
 * Project one `session` row.
 *
 * zcode records a single timestamp per session in the column this build has, so
 * a conversation's start and its last activity are the same instant here.
 * @param row - the row as read, with its timestamp aliased to `recency`.
 * @returns the session, or undefined when the row has no usable id.
 */
function toSession(row: Record<string, unknown>): TranscriptSession | undefined {
  const id = typeof row['id'] === 'string' ? row['id'] : String(row['id'] ?? '')
  if (id === '') return undefined
  const at = parseTimestamp(row['recency']) ?? 0
  return {
    id,
    title: normalizeTitle(row['title']),
    cwd: typeof row['directory'] === 'string' ? row['directory'] : '',
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * The summary carried by a `compaction` part, if this message has one.
 *
 * The part itself never reaches the reader — `pushSessionParts` skips every
 * structural type — so this is the only thing that recovers it.
 * @param message - one message row with its parts.
 * @returns the summary text, or undefined when no part carried one.
 */
export function partSummary(message: SessionMessage): string | undefined {
  for (const part of message.parts) {
    if (part['type'] !== 'compaction') continue
    const body = summaryBody(part['summary'])
    if (body !== undefined) return body
  }
  return undefined
}

/**
 * The summary hung on the message itself, which is where older builds put it.
 *
 * A message shaped this way is a marker rather than something the user said:
 * its own body is a lead-in to the summary. The caller drops it.
 * @param message - one message row.
 * @returns the summary text, or undefined when this is ordinary conversation.
 */
export function messageSummary(message: SessionMessage): string | undefined {
  return summaryBody(message.data['summary'])
}

/** Read `summary.body`, which is where both shapes keep the text. */
function summaryBody(summary: unknown): string | undefined {
  if (typeof summary !== 'object' || summary === null) return undefined
  const body = (summary as Record<string, unknown>)['body']
  if (typeof body !== 'string') return undefined
  const trimmed = body.trim()
  return trimmed === '' ? undefined : trimmed
}
