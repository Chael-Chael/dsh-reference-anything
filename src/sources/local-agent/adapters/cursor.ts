/**
 * Cursor agent transcripts:
 * `~/.cursor/projects/<slug>/agent-transcripts/<composer>/<composer>.jsonl`.
 *
 * The record shape is the Messages API's without an envelope — each line is
 * `{role, message: {content: [...]}}` and nothing else — so the fold is the
 * shortest of any supported format. Three details are Cursor's own:
 *
 * - The opening prompt arrives wrapped in `<user_query>…</user_query>`, which
 *   is markup Cursor adds rather than anything a person typed.
 * - Assistant text carries `[REDACTED]` sentinels where the client stripped
 *   something before writing. Left in, they read as though the model said the
 *   word.
 * - There is no `tool_result`, no timestamp, and no `cwd` anywhere in the
 *   file: results live in a separate bubble store and the composer uuid is the
 *   only identity. So a Cursor transcript can never be workspace-scoped from
 *   its contents, which the source handles by listing it under `scope: 'all'`.
 *
 * @module dsh-reference-anything/local-agent/adapters/cursor
 */

import { joinLocalPath } from '../path.ts'
import type {
  AdapterState,
  ConvertOptions,
  ParsedTurn,
  TranscriptAdapter,
  TranscriptHead,
} from '../types.ts'
import {
  arrayField,
  createSharedState,
  emitUser,
  flushAssistant,
  normalizeTitle,
  objectField,
  parseRecord,
  pushAssistant,
  renderToolCall,
} from './shared.ts'

/** Wrapper Cursor puts around the prompt it sends, not something anyone typed. */
const USER_QUERY_TAG = /<\/?user_query>/gu

/** Placeholder the client leaves where it removed content before writing. */
const REDACTED = /\[REDACTED\]/gu

/** Reads Cursor agent transcripts. */
export const cursorAdapter: TranscriptAdapter = {
  kind: 'cursor',
  displayName: 'Cursor',

  defaultRoots(home: string): readonly string[] {
    return [joinLocalPath(home, '.cursor', 'projects')]
  },

  matches(relativePath: string): boolean {
    const path = relativePath.toLowerCase()
    // Scoped to the transcript directory rather than to `.jsonl` alone: the
    // project tree holds other line-delimited state this adapter cannot read.
    return path.includes('agent-transcripts/') && path.endsWith('.jsonl')
  },

  createState(): AdapterState {
    return createSharedState()
  },

  step(line: string, state: AdapterState, options: ConvertOptions): readonly ParsedTurn[] {
    const record = parseRecord(line)
    if (record === undefined) return []
    const blocks = arrayField(objectField(record, 'message'), 'content') ?? []

    if (record['role'] === 'user') {
      const text = userText(blocks)
      return text === undefined ? [] : emitUser(state, text)
    }
    if (record['role'] !== 'assistant') return []

    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue
      const entry = block as Record<string, unknown>
      if (entry['type'] === 'text') {
        pushAssistant(state, scrub(entry['text']))
      } else if (entry['type'] === 'tool_use') {
        // `input` is already an object here; Cursor does not JSON-encode it the
        // way the wire format does.
        pushAssistant(state, renderToolCall(
          entry['name'], entry['input'], options.toolCalls, options.toolSummaryChars,
        ))
      }
    }
    return []
  },

  flush(state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    return flushAssistant(state)
  },

  head(headLines: readonly string[], tailLines: readonly string[]): TranscriptHead {
    let firstPrompt: string | undefined
    for (const line of [...headLines, ...tailLines]) {
      const record = parseRecord(line)
      if (record?.['role'] !== 'user') continue
      firstPrompt = userText(arrayField(objectField(record, 'message'), 'content') ?? [])
      if (firstPrompt !== undefined) break
    }
    const title = normalizeTitle(firstPrompt ?? '')
    // No `createdAt` and no `cwd`: the format records neither, and inventing
    // one from the file's mtime would claim the session started when it was
    // last written to.
    return {
      ...title === '' ? {} : { title },
      ...firstPrompt === undefined ? {} : { firstPrompt },
    }
  },
}

/**
 * The words a person typed, from a user record's content blocks.
 * @param blocks - the `message.content` array.
 * @returns the prompt, or undefined when the record carried no text.
 */
function userText(blocks: readonly unknown[]): string | undefined {
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const entry = block as Record<string, unknown>
    if (entry['type'] !== 'text' || typeof entry['text'] !== 'string') continue
    const text = entry['text'].replace(USER_QUERY_TAG, '').trim()
    if (text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Assistant text with the client's redaction sentinels removed.
 * @param value - the block's `text` field, of unknown type.
 * @returns the text, or undefined when nothing survived the scrub.
 */
function scrub(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(REDACTED, '').trim()
  return text === '' ? undefined : text
}
