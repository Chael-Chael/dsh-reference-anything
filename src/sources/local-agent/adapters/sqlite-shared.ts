/**
 * What the three database-backed formats have in common.
 *
 * opencode, its fork mimocode, and zcode all store a conversation the same
 * way — a `session` row, `message` rows under it, and `part` rows under those,
 * each part a JSON blob naming its own type. The queries differ (zcode filters
 * to main sessions, and each probes its own optional columns) and the message-level
 * rules differ (zcode drops system prompts, opencode honours a `tail_start_id`),
 * but the part-level projection is identical, and it is where all the fiddly
 * work is. It lives here so one change to how a tool call renders reaches every
 * database format at once.
 *
 * Everything below is pure: it takes a {@link SqliteReader}, never a driver.
 *
 * @module dsh-reference-anything/local-agent/adapters/sqlite-shared
 */

import type { AdapterState, ConvertOptions, ParsedTurn, SqliteReader } from '../types.ts'
import { cleanUserText, emitUser, pushAssistant, renderToolCall } from './shared.ts'

/**
 * Message ids bound into one `IN (…)` clause.
 *
 * SQLite accepts far more parameters than this, but a bounded chunk keeps the
 * statement cache from being churned by a different arity per session.
 */
const ID_CHUNK = 400

/** One message row with the parts that belong to it, in order. */
export interface SessionMessage {
  readonly id: string
  /** The message's own JSON payload: `role`, `path.cwd`, `agent`, `summary`… */
  readonly data: Record<string, unknown>
  /** Its parts' JSON payloads, oldest first. */
  readonly parts: readonly Record<string, unknown>[]
}

/** A session's messages, and whether older ones were left behind. */
export interface SessionMessages {
  readonly messages: readonly SessionMessage[]
  /** The record cap was reached, so the oldest messages were not read. */
  readonly truncated: boolean
}

/**
 * Read one session's messages, newest-anchored and bounded.
 *
 * Bounded from the *end* rather than the start, for the same reason the
 * line-local reader anchors an oversized file to its tail: the newest turns are
 * the ones a reader asking about a conversation almost always wants, and a
 * bound that kept the oldest would return the setup and drop the answer.
 * @param db - a read-only reader over the database.
 * @param sessionId - the conversation to read.
 * @param maxRecords - most message rows to materialize.
 * @returns the messages oldest-first, and whether the cap cut any off.
 */
export function readSessionMessages(
  db: SqliteReader,
  sessionId: string,
  maxRecords: number,
): SessionMessages {
  const cap = Math.max(1, Math.trunc(maxRecords))
  const rows = db.all(
    'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?',
    sessionId,
    cap,
  )
  const ordered = [...rows].reverse()
  const ids = ordered.map(row => String(row['id']))
  const parts = readParts(db, ids)
  const messages: SessionMessage[] = []
  for (const row of ordered) {
    const data = parseBlob(row['data'])
    // A message whose payload is not JSON is dirty data, not a reason to fail
    // the whole read; the conversation around it is still worth returning.
    if (data === undefined) continue
    const id = String(row['id'])
    messages.push({ id, data, parts: parts.get(id) ?? [] })
  }
  return { messages, truncated: rows.length >= cap }
}

/** Fetch the parts of exactly the messages that were kept. */
function readParts(db: SqliteReader, ids: readonly string[]): Map<string, Record<string, unknown>[]> {
  const byMessage = new Map<string, Record<string, unknown>[]>()
  for (let at = 0; at < ids.length; at += ID_CHUNK) {
    const chunk = ids.slice(at, at + ID_CHUNK)
    if (chunk.length === 0) continue
    const holes = chunk.map(() => '?').join(',')
    const rows = db.all(
      `SELECT message_id, data FROM part WHERE message_id IN (${holes}) ORDER BY time_created, id`,
      ...chunk,
    )
    for (const row of rows) {
      const data = parseBlob(row['data'])
      if (data === undefined) continue
      const key = String(row['message_id'])
      const bucket = byMessage.get(key)
      if (bucket === undefined) byMessage.set(key, [data])
      else bucket.push(data)
    }
  }
  return byMessage
}

/**
 * The text a user typed, joined from the message's text parts.
 *
 * These agents inject their own material through the same `user` role a person
 * types into — a `<system-reminder>` appended to a real question, a whole
 * `AGENTS.md` wrapped in `<INSTRUCTIONS>` — so the same stripping the JSONL
 * adapters apply is applied here. A message that was nothing but machinery
 * collapses to an empty string and the caller emits no turn for it.
 * @param message - one message row.
 * @param strip - whether to remove harness-injected wrappers.
 * @returns the prompt, or an empty string when the message carried no words.
 */
export function userPromptText(message: SessionMessage, strip = true): string {
  const texts: string[] = []
  for (const part of message.parts) {
    if (part['type'] !== 'text') continue
    const text = part['text']
    if (typeof text === 'string' && text.trim() !== '') texts.push(text.trim())
  }
  const joined = texts.join('\n')
  return strip ? cleanUserText(joined) : joined
}

/**
 * Fold one assistant message's parts into the open assistant run.
 *
 * Structural parts — `step-start`, `step-finish`, `compaction`, `timeline`, and
 * whatever a later build adds — carry nothing a reader can use and are skipped,
 * which is what keeps a new part type from breaking an old adapter.
 * @param state - fold state, mutated in place.
 * @param message - the assistant message whose parts to project.
 * @param options - projection settings.
 */
export function pushSessionParts(
  state: AdapterState,
  message: SessionMessage,
  options: ConvertOptions,
): void {
  for (const part of message.parts) {
    switch (part['type']) {
      case 'text':
        pushAssistant(state, asText(part['text']))
        break
      case 'reasoning':
        if (options.includeThinking) pushAssistant(state, asText(part['text']))
        break
      case 'tool': {
        const state_ = part['state']
        const input = typeof state_ === 'object' && state_ !== null
          ? (state_ as Record<string, unknown>)['input']
          : undefined
        pushAssistant(state, renderToolCall(part['tool'], input, options.toolCalls, options.toolSummaryChars))
        break
      }
      case 'file':
        // No attachment handle is emitted: `reference_attachment_read` only
        // serves the web-chat source, so a handle here would be a dead end.
        pushAssistant(state, `[attachment: ${asText(part['filename']) ?? 'unknown'}]`)
        break
      case 'patch': {
        const files = part['files']
        pushAssistant(state, `[patch: ${Array.isArray(files) ? files.length : 0} files]`)
        break
      }
      case 'subtask': {
        const command = asText(part['command']) ?? ''
        const description = asText(part['description']) ?? ''
        const detail = [command, description].filter(entry => entry !== '').join(' — ')
        pushAssistant(state, `[subtask${detail === '' ? '' : `: ${detail}`}]`)
        break
      }
      default:
        break
    }
  }
}

/**
 * Fold one message into the running conversation.
 * @param state - fold state, mutated in place.
 * @param message - the message to fold.
 * @param options - projection settings.
 * @returns turns this message completed, in order.
 */
export function stepSessionMessage(
  state: AdapterState,
  message: SessionMessage,
  options: ConvertOptions,
): readonly ParsedTurn[] {
  const role = message.data['role']
  if (role === 'user') {
    const prompt = userPromptText(message, options.stripEnvironmentPreamble)
    return prompt === '' ? [] : emitUser(state, prompt)
  }
  if (role !== 'assistant') return []
  pushSessionParts(state, message, options)
  return []
}

/**
 * Parse a `data` column, which every one of these schemas stores as JSON text.
 * @param value - the raw column value.
 * @returns the object, or undefined when the column is absent or not a JSON object.
 */
export function parseBlob(value: unknown): Record<string, unknown> | undefined {
  const text = typeof value === 'string'
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value).toString('utf8')
      : undefined
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** Read a nested string, treating a blank one as absent. */
export function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Read a string field from a nested object, for the `path.cwd` shape both forks use.
 * @param data - the message payload.
 * @param outer - the containing object's key.
 * @param inner - the key inside it.
 * @returns the value, or undefined when either level is missing.
 */
export function nestedText(
  data: Record<string, unknown>,
  outer: string,
  inner: string,
): string | undefined {
  const nested = data[outer]
  if (typeof nested !== 'object' || nested === null) return undefined
  return asText((nested as Record<string, unknown>)[inner])
}
