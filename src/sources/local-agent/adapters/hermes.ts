/**
 * Hermes sessions: `~/.hermes/sessions/<id>.jsonl`.
 *
 * Hermes writes two record shapes and neither generation is retired, so both
 * are accepted per line: a flat `{role, content, ts}` and a nested
 * `{type: 'session' | 'message', message: {role, content}, timestamp}`. The
 * discriminator is whether a `message` object is present, which costs one
 * lookup and removes the need to sniff the file first.
 *
 * Hermes also keeps its canonical history in a SQLite `state.db` and treats
 * the JSONL files as an export. Reading the database needs a query interface
 * rather than a line fold, so it is out of this adapter's scope; a session
 * that exists only in `state.db` will not appear in the menu.
 *
 * @module dsh-reference-anything/local-agent/adapters/hermes
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
  pushContentBlocks,
  stringField,
} from './shared.ts'

/** Reads Hermes session exports. */
export const hermesAdapter: TranscriptAdapter = {
  kind: 'hermes',
  displayName: 'Hermes',

  defaultRoots(home: string): readonly string[] {
    return [joinLocalPath(home, '.hermes', 'sessions')]
  },

  matches(relativePath: string): boolean {
    return relativePath.toLowerCase().endsWith('.jsonl')
  },

  createState(): AdapterState {
    return createSharedState()
  },

  step(line: string, state: AdapterState, options: ConvertOptions): readonly ParsedTurn[] {
    const record = parseRecord(line)
    if (record === undefined) return []
    // A `session` record is metadata; head() reads it and the fold ignores it.
    if (record['type'] === 'session' || record['type'] === 'init') return []
    const message = objectField(record, 'message') ?? record

    if (message['role'] === 'user') {
      const text = contentBlockUserText(message['content'])
      return text === undefined ? [] : emitUser(state, text)
    }
    if (message['role'] !== 'assistant') return []

    const content = message['content']
    if (typeof content === 'string') pushAssistant(state, content)
    else pushContentBlocks(state, arrayField(message, 'content'), options)
    return []
  },

  flush(state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    return flushAssistant(state)
  },

  head(headLines: readonly string[], _tailLines: readonly string[]): TranscriptHead {
    let recorded: string | undefined
    let cwd: string | undefined
    let createdAt: number | undefined
    let firstPrompt: string | undefined

    for (const line of headLines) {
      const record = parseRecord(line)
      if (record === undefined) continue
      // First non-empty wins for metadata: Hermes may repeat the session
      // record on resume, and the original values are the session's.
      recorded ??= stringField(record, 'title')
      cwd ??= stringField(record, 'cwd')
      createdAt ??= parseTimestamp(record['timestamp'] ?? record['ts'])
      if (firstPrompt !== undefined) continue
      const message = objectField(record, 'message') ?? record
      if (message['role'] === 'user') firstPrompt = contentBlockUserText(message['content'])
    }

    const title = normalizeTitle(recorded ?? firstPrompt ?? '')
    return {
      ...title === '' ? {} : { title },
      ...cwd === undefined ? {} : { cwd },
      ...firstPrompt === undefined ? {} : { firstPrompt },
      ...createdAt === undefined ? {} : { createdAt },
    }
  },
}
