/**
 * Reads opencode's SQLite history, and mimocode's fork of it.
 *
 * opencode keeps every session it has ever run in one database under
 * `~/.local/share/opencode/`, rather than one file per conversation. That single
 * fact is why this is a {@link QueryAdapter} instead of a
 * {@link TranscriptAdapter}: there is no byte offset that means "the start of
 * this conversation", so a reference has to name the session as well as the
 * file, and a listing is a query rather than a directory walk.
 *
 * mimocode is a fork of it, and older opencode builds differ from newer ones,
 * so the columns that vary — `time_updated` here, `parent_id` in zcode — are
 * probed rather than branched on a version number nobody writes down. What
 * mimocode does not share is its background traffic: MiMo runs
 * memory-consolidation and distillation sessions through the same tables as the
 * user's own work, and those are filtered out of discovery.
 *
 * @module dsh-reference-anything/local-agent/adapters/opencode
 */

import { joinLocalPath } from '../path.ts'
import type {
  AgentKind,
  ParsedTurn,
  QueryAdapter,
  SessionTurns,
  SqliteReader,
  TranscriptSession,
} from '../types.ts'
import { COMPACTION_MARKER, createSharedState, flushAssistant, normalizeTitle, parseTimestamp } from './shared.ts'
import { nestedText, parseBlob, readSessionMessages, stepSessionMessage } from './sqlite-shared.ts'
import type { SessionMessage } from './sqlite-shared.ts'

/**
 * Sessions MiMo runs for itself rather than for the user.
 *
 * Measured against a real `mimocode.db`: 822 `checkpoint-writer` sessions
 * against a handful of real ones. Listing them would bury the user's own work
 * under machinery they never started.
 */
const BACKGROUND_TITLE = /^(checkpoint[-_ ]?writer|auto[-_ ]?(dream|distill))\b/iu

/**
 * How far discovery will over-fetch chasing enough non-background sessions.
 *
 * The filter is applied in this process rather than in SQL because the exact
 * predicate is a regular expression and the SQL equivalent — a pile of `LIKE`
 * patterns — would either miss forms or swallow a real session that happened to
 * be titled about checkpoints. Over-fetching is the cost of getting that right,
 * and it is bounded here rather than left to widen without limit.
 */
const OVERFETCH_STEPS = [1, 4, 16] as const

/** Shape one of the two forks. */
interface Variant {
  readonly kind: AgentKind
  readonly displayName: string
  readonly dataDir: string
  readonly dbName: string
  /** Whether this fork mixes its own background sessions into the same tables. */
  readonly background: boolean
}

/** Reads opencode's session database. */
export const opencodeAdapter: QueryAdapter = variantAdapter({
  kind: 'opencode',
  displayName: 'opencode',
  dataDir: 'opencode',
  dbName: 'opencode.db',
  background: false,
})

/** Reads mimocode's session database, minus its own background traffic. */
export const mimocodeAdapter: QueryAdapter = variantAdapter({
  kind: 'mimocode',
  displayName: 'mimocode',
  dataDir: 'mimocode',
  dbName: 'mimocode.db',
  background: true,
})

/**
 * Whether a session is MiMo's own background work rather than the user's.
 *
 * Exported for the tests, which is the only way to pin a filter whose whole job
 * is to be invisible when it works.
 * @param title - the session's recorded title.
 * @returns whether discovery should hide it.
 */
export function isBackgroundSession(title: string): boolean {
  return BACKGROUND_TITLE.test(title.trim())
}

function variantAdapter(variant: Variant): QueryAdapter {
  return {
    kind: variant.kind,
    displayName: variant.displayName,
    query: true,

    defaultRoots(home: string): readonly string[] {
      // The root is the directory, not the database: discovery walks
      // directories, and pointing it at a file would make the one format that
      // needs no walking the only one that needs a special case.
      return [joinLocalPath(home, '.local', 'share', variant.dataDir)]
    },

    matches(relativePath: string): boolean {
      // Exact, so SQLite's `-wal` and `-shm` sidecars are not mistaken for
      // databases and a backup copy is not listed as a second corpus.
      return relativePath.split(/[\\/]/u).at(-1) === variant.dbName
    },

    sessions(db: SqliteReader, limit: number): readonly TranscriptSession[] {
      const query = sessionQuery(db)
      if (query === undefined) return []

      const wanted = Math.max(1, Math.trunc(limit))
      let kept: TranscriptSession[] = []
      for (const step of OVERFETCH_STEPS) {
        const ask = wanted * step
        const rows = db.all(
          `SELECT ${query.fields} FROM session ORDER BY ${query.recency} DESC, id DESC LIMIT ?`,
          ask,
        )
        kept = []
        for (const row of rows) {
          const session = toSession(row, query.recency)
          if (session === undefined) continue
          if (variant.background && isBackgroundSession(session.title)) continue
          kept.push(session)
          if (kept.length >= wanted) break
        }
        // Enough survived the filter, or the database has nothing more to give.
        if (kept.length >= wanted || rows.length < ask) break
      }
      return kept
    },

    session(db: SqliteReader, sessionId: string): TranscriptSession | undefined {
      const query = sessionQuery(db)
      if (query === undefined) return undefined
      const [row] = db.all(`SELECT ${query.fields} FROM session WHERE id = ? LIMIT 1`, sessionId)
      return row === undefined ? undefined : toSession(row, query.recency)
    },

    turns(db, sessionId, options, maxRecords): SessionTurns {
      const { messages, truncated } = readSessionMessages(db, sessionId, maxRecords)
      const { kept, summary, compacted } = applyCompaction(messages)
      const state = createSharedState()
      const items: ParsedTurn[] = []
      // The summary stands where the discarded turns were: first, so the reader
      // meets it before the tail it explains.
      if (summary !== undefined) items.push({ role: 'assistant', text: `${COMPACTION_MARKER}\n\n${summary}` })
      for (const message of kept) items.push(...stepSessionMessage(state, message, options))
      items.push(...flushAssistant(state))
      return { items, truncated, compacted }
    },
  }
}

/**
 * Which columns this build has, resolved once per query.
 *
 * `time_updated` is the one that actually varies between the two forks and
 * across opencode's own history, so it is probed rather than assumed; a build
 * without it orders and dates sessions by when they started.
 * @param db - a read-only reader over the database.
 * @returns the select list and recency column, or undefined when there is no `session` table.
 */
function sessionQuery(db: SqliteReader): { fields: string; recency: string } | undefined {
  const columns = db.columns('session')
  if (columns.size === 0) return undefined
  const recency = columns.has('time_updated') ? 'time_updated' : 'time_created'
  const fields = ['id', 'title', 'directory', 'time_created']
  if (recency === 'time_updated') fields.push('time_updated')
  return { fields: fields.join(', '), recency }
}

/**
 * Project one `session` row.
 * @param row - the row as read.
 * @param recency - which column carries last activity.
 * @returns the session, or undefined when the row has no usable id.
 */
function toSession(row: Record<string, unknown>, recency: string): TranscriptSession | undefined {
  const id = typeof row['id'] === 'string' ? row['id'] : String(row['id'] ?? '')
  if (id === '') return undefined
  const createdAt = parseTimestamp(row['time_created']) ?? 0
  return {
    id,
    title: normalizeTitle(row['title']),
    cwd: typeof row['directory'] === 'string' ? row['directory'] : '',
    createdAt,
    updatedAt: parseTimestamp(row[recency]) ?? createdAt,
  }
}

/**
 * Honour the compaction opencode recorded, rather than unwinding it.
 *
 * A `compaction` part names the message the surviving tail starts at, and the
 * summary message beside it stands in for everything before. Replaying the
 * discarded messages would contradict what the agent itself decided to forget;
 * what is kept is the tail plus the summary, and the caller marks the read
 * partial so the loss is visible.
 * @param messages - the session's messages, oldest first.
 * @returns the messages to fold, the summary text, and whether a boundary was crossed.
 */
function applyCompaction(messages: readonly SessionMessage[]): {
  kept: readonly SessionMessage[]
  summary: string | undefined
  compacted: boolean
} {
  let tailStart: string | undefined
  let summary: string | undefined
  for (const message of messages) {
    for (const part of message.parts) {
      if (part['type'] === 'compaction' && typeof part['tail_start_id'] === 'string') {
        tailStart = part['tail_start_id']
      }
    }
    if (!isSummaryMessage(message)) continue
    const text = message.parts
      .filter(part => part['type'] === 'text' && typeof part['text'] === 'string')
      .map(part => String(part['text']).trim())
      .filter(text => text !== '')
      .join('\n')
      .trim()
    if (text !== '') summary = text
  }
  if (tailStart === undefined) return { kept: messages, summary: undefined, compacted: false }
  const at = messages.findIndex(message => message.id === tailStart)
  // A `tail_start_id` pointing at a message the record cap already dropped is
  // not a reason to discard the tail we do have.
  if (at < 0) return { kept: messages, summary, compacted: true }
  return { kept: messages.slice(at).filter(message => !isSummaryMessage(message)), summary, compacted: true }
}

/** Whether a message is a compaction summary rather than part of the conversation. */
function isSummaryMessage(message: SessionMessage): boolean {
  return message.data['mode'] === 'compaction' || message.data['summary'] === true
}

/**
 * The working directory a session ran in, when the session row did not record one.
 *
 * Older opencode databases leave `session.directory` empty and put the path on
 * each message instead, so this is the fallback discovery uses before deciding
 * a session belongs to no workspace.
 * @param db - a read-only reader over the database.
 * @param sessionId - the conversation to inspect.
 * @returns the recorded cwd, or undefined when no message carries one.
 */
export function sessionCwd(db: SqliteReader, sessionId: string): string | undefined {
  const rows = db.all(
    'SELECT data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 8',
    sessionId,
  )
  for (const row of rows) {
    const data = parseBlob(row['data'])
    if (data === undefined) continue
    const cwd = nestedText(data, 'path', 'cwd')
    if (cwd !== undefined) return cwd
  }
  return undefined
}
