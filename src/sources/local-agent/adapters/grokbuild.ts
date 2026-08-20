/**
 * Grok Build sessions: `~/.grok/sessions/<slug>/<id>/chat_history.jsonl`, and
 * the same layout under `~/.grok/archived_sessions/`.
 *
 * A session is a *directory*, not a file: `chat_history.jsonl` holds the
 * conversation while a sibling `summary.json` holds the generated title, the
 * `cwd`, and the timestamps. A pure adapter reads one file, so the title falls
 * back to the opening prompt and Grok sessions carry no recorded `cwd` — which
 * means they list under `scope: 'all'` rather than being matched to a
 * workspace. That is a real gap, not an oversight; closing it would mean
 * giving adapters I/O, which is the one thing the interface exists to prevent.
 *
 * Records are `{type, content, timestamp}` with `content` either a string or a
 * Messages-API block array. Two of the five types are dropped: `system` is
 * harness-injected, and `reasoning` carries Grok's encrypted internal state,
 * which renders as a wall of base64 rather than as thought.
 *
 * @module dsh-reference-anything/local-agent/adapters/grokbuild
 */

import { join } from 'node:path'
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
  parseRecord,
  parseTimestamp,
  pushAssistant,
  pushContentBlocks,
} from './shared.ts'

/** Reads Grok Build chat histories. */
export const grokbuildAdapter: TranscriptAdapter = {
  kind: 'grokbuild',
  displayName: 'Grok Build',

  defaultRoots(home: string): readonly string[] {
    return [join(home, '.grok', 'sessions'), join(home, '.grok', 'archived_sessions')]
  },

  matches(relativePath: string): boolean {
    const path = relativePath.toLowerCase()
    return path.endsWith('/chat_history.jsonl') || path === 'chat_history.jsonl'
  },

  createState(): AdapterState {
    return createSharedState()
  },

  step(line: string, state: AdapterState, options: ConvertOptions): readonly ParsedTurn[] {
    const record = parseRecord(line)
    if (record === undefined) return []

    if (record['type'] === 'user') {
      const text = contentBlockUserText(record['content'])
      return text === undefined ? [] : emitUser(state, text)
    }
    if (record['type'] !== 'assistant') return []

    const content = record['content']
    if (typeof content === 'string') pushAssistant(state, content)
    else pushContentBlocks(state, arrayField(record, 'content'), options)
    return []
  },

  flush(state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    return flushAssistant(state)
  },

  head(headLines: readonly string[], _tailLines: readonly string[]): TranscriptHead {
    let createdAt: number | undefined
    let firstPrompt: string | undefined

    for (const line of headLines) {
      const record = parseRecord(line)
      if (record === undefined) continue
      createdAt ??= parseTimestamp(record['timestamp'])
      if (firstPrompt === undefined && record['type'] === 'user') {
        firstPrompt = contentBlockUserText(record['content'])
      }
    }

    const title = normalizeTitle(firstPrompt ?? '')
    return {
      ...title === '' ? {} : { title },
      ...firstPrompt === undefined ? {} : { firstPrompt },
      ...createdAt === undefined ? {} : { createdAt },
    }
  },
}
