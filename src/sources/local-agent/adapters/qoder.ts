/**
 * Qoder CLI sessions: `~/.qoder/projects/<encoded-project>/<sessionId>.jsonl`.
 *
 * Qoder adopted Claude Code's record layout nearly verbatim — the same `user`
 * and `assistant` envelopes around a Messages-API `message`, the same
 * `ai-title` and `last-prompt` state records, the same `cwd` on every entry —
 * so the fold is the same one, and this adapter exists mainly to own the
 * different roots and the subagent rule.
 *
 * That rule is the one thing worth stating: Qoder writes a spawned subagent's
 * transcript to `<sessionId>/subagents/*.jsonl` while stamping it with the
 * *parent's* `sessionId`. Listing those as sessions of their own would give
 * two entries the same identity, so they are rejected by path.
 *
 * @module dsh-reference-anything/local-agent/adapters/qoder
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
  pushToolResults,
  stringField,
} from './shared.ts'

/** Reads Qoder CLI session transcripts. */
export const qoderAdapter: TranscriptAdapter = {
  kind: 'qoder',
  displayName: 'Qoder',

  defaultRoots(home: string): readonly string[] {
    return [joinLocalPath(home, '.qoder', 'projects')]
  },

  matches(relativePath: string): boolean {
    const path = relativePath.toLowerCase()
    return path.endsWith('.jsonl') && !path.includes('/subagents/')
  },

  createState(): AdapterState {
    return createSharedState()
  },

  step(line: string, state: AdapterState, options: ConvertOptions): readonly ParsedTurn[] {
    const record = parseRecord(line)
    if (record === undefined) return []
    const message = objectField(record, 'message')

    if (record['type'] === 'user') {
      pushToolResults(state, message?.['content'], options)
      const text = contentBlockUserText(message?.['content'])
      return text === undefined ? [] : emitUser(state, text)
    }
    if (record['type'] === 'assistant') {
      const content = message?.['content']
      if (typeof content === 'string') pushAssistant(state, content)
      else pushContentBlocks(state, arrayField(message, 'content'), options)
      return []
    }
    // `ai-title`, `last-prompt`, `mode`, and the subagent metadata records are
    // CLI state; head() reads the two that name the session.
    return []
  },

  flush(state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    return flushAssistant(state)
  },

  head(headLines: readonly string[], tailLines: readonly string[]): TranscriptHead {
    let aiTitle: string | undefined
    let lastPrompt: string | undefined
    let cwd: string | undefined
    let createdAt: number | undefined
    let firstPrompt: string | undefined

    // Later wins for the two title records: Qoder rewrites `ai-title` as the
    // session is renamed, so the newest one in the tail is the current name.
    for (const line of [...headLines, ...tailLines]) {
      const record = parseRecord(line)
      if (record === undefined) continue
      if (record['type'] === 'ai-title') aiTitle = stringField(record, 'aiTitle') ?? aiTitle
      else if (record['type'] === 'last-prompt') lastPrompt = stringField(record, 'lastPrompt') ?? lastPrompt
      cwd ??= stringField(record, 'cwd')
      createdAt ??= parseTimestamp(record['timestamp'])
    }

    for (const line of headLines) {
      const record = parseRecord(line)
      if (record?.['type'] !== 'user') continue
      firstPrompt = contentBlockUserText(objectField(record, 'message')?.['content'])
      if (firstPrompt !== undefined) break
    }

    const title = normalizeTitle(aiTitle ?? lastPrompt ?? firstPrompt ?? '')
    return {
      ...title === '' ? {} : { title },
      ...cwd === undefined ? {} : { cwd },
      ...firstPrompt === undefined ? {} : { firstPrompt },
      ...createdAt === undefined ? {} : { createdAt },
    }
  },
}
