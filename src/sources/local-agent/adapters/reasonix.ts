/**
 * Reasonix sessions: `~/.reasonix/sessions/<stem>.jsonl`.
 *
 * Records are OpenAI chat messages written straight to disk with no envelope
 * — `{role, content}` and nothing wrapping it — which makes this the one
 * supported format whose lines would be valid request payloads as they stand.
 *
 * Two versions are in the wild and both are accepted: v1 nests a tool call
 * under `function: {name, arguments}`, v2 flattens it to `{name, arguments}`.
 * `arguments` is a JSON *string* in both, which the shared renderer handles.
 *
 * Sibling files share the directory — `<stem>.meta.json` holds the workspace
 * and summary, `<stem>.events.jsonl` is a write-ahead log replayed over the
 * checkpoint — and neither is a transcript, so both are rejected by path. The
 * WAL means a session's newest turns can be missing from the file this reads;
 * that is a staleness bound, not a correctness one, and it resolves itself the
 * next time Reasonix checkpoints.
 *
 * @module dsh-reference-anything/local-agent/adapters/reasonix
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
  contentBlockUserText,
  createSharedState,
  emitUser,
  flushAssistant,
  normalizeTitle,
  objectField,
  parseRecord,
  parseTimestamp,
  pushAssistant,
  renderToolCall,
  stringField,
} from './shared.ts'

/** Reads Reasonix session transcripts. */
export const reasonixAdapter: TranscriptAdapter = {
  kind: 'reasonix',
  displayName: 'Reasonix',

  defaultRoots(home: string): readonly string[] {
    return [joinLocalPath(home, '.reasonix', 'sessions')]
  },

  matches(relativePath: string): boolean {
    const path = relativePath.toLowerCase()
    return path.endsWith('.jsonl') && !path.endsWith('.events.jsonl')
  },

  createState(): AdapterState {
    return createSharedState()
  },

  step(line: string, state: AdapterState, options: ConvertOptions): readonly ParsedTurn[] {
    const record = parseRecord(line)
    if (record === undefined) return []

    if (record['role'] === 'user') {
      const text = contentBlockUserText(record['content'])
      return text === undefined ? [] : emitUser(state, text)
    }
    // `tool` records are results, which this projection drops by design.
    if (record['role'] !== 'assistant') return []

    pushAssistant(state, contentBlockUserText(record['content'], false))
    if (options.includeThinking) pushAssistant(state, stringField(record, 'reasoning_content'))
    for (const call of arrayField(record, 'tool_calls') ?? []) {
      if (typeof call !== 'object' || call === null) continue
      const entry = call as Record<string, unknown>
      // v1 nests under `function`, v2 is flat. Reading the nested shape first
      // means a v1 record never falls through to v2's undefined fields.
      const fn = objectField(entry, 'function') ?? entry
      pushAssistant(state, renderToolCall(
        fn['name'], fn['arguments'], options.toolCalls, options.toolSummaryChars,
      ))
    }
    return []
  },

  flush(state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    return flushAssistant(state)
  },

  head(headLines: readonly string[], _tailLines: readonly string[]): TranscriptHead {
    let firstPrompt: string | undefined
    let createdAt: number | undefined

    for (const line of headLines) {
      const record = parseRecord(line)
      if (record === undefined) continue
      createdAt ??= parseTimestamp(record['createdAt'])
      if (firstPrompt === undefined && record['role'] === 'user') {
        firstPrompt = contentBlockUserText(record['content'])
      }
    }

    // The transcript carries no title of its own — Reasonix keeps the summary
    // in the sibling `.meta.json`, which a probe of this file cannot see — so
    // the opening prompt names the session.
    const title = normalizeTitle(firstPrompt ?? '')
    return {
      ...title === '' ? {} : { title },
      ...firstPrompt === undefined ? {} : { firstPrompt },
      ...createdAt === undefined ? {} : { createdAt },
    }
  },
}
