/**
 * OpenClaw sessions: `~/.openclaw/agents/<agent>/sessions/<id>.jsonl`.
 *
 * An event stream of two shapes: a `session` record carrying the id, `cwd`,
 * and start time, then `message` records wrapping a Messages-API message whose
 * content is either a string or a block array.
 *
 * The detail that needs handling is OpenClaw's gateway, which appends
 * `\n[message_id: …]` to text it relays. It is routing metadata, and left in
 * place it reads as part of what was said, so it is stripped from every body.
 *
 * OpenClaw also keeps the session's display name in a sibling `sessions.json`
 * index rather than in the transcript. A pure adapter cannot open it, so the
 * title falls to the opening prompt — which is what OpenClaw itself shows for
 * an unnamed session anyway.
 *
 * @module dsh-reference-anything/local-agent/adapters/openclaw
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

/** Routing metadata the gateway appends to relayed text. */
const MESSAGE_ID_SUFFIX = '\n[message_id:'

/** Reads OpenClaw session transcripts. */
export const openclawAdapter: TranscriptAdapter = {
  kind: 'openclaw',
  displayName: 'OpenClaw',

  defaultRoots(home: string): readonly string[] {
    return [joinLocalPath(home, '.openclaw', 'agents')]
  },

  matches(relativePath: string): boolean {
    const path = relativePath.toLowerCase()
    return path.includes('/sessions/') && path.endsWith('.jsonl')
  },

  createState(): AdapterState {
    return createSharedState()
  },

  step(line: string, state: AdapterState, options: ConvertOptions): readonly ParsedTurn[] {
    const record = parseRecord(line)
    if (record === undefined || record['type'] !== 'message') return []
    const message = objectField(record, 'message')
    if (message === undefined) return []
    const content = message['content']

    if (message['role'] === 'user') {
      const text = contentBlockUserText(content)
      return text === undefined ? [] : emitUser(state, stripMessageId(text))
    }
    // `toolResult` is a role of its own here rather than a user record full of
    // `tool_result` blocks; either way it is plumbing this projection drops.
    if (message['role'] !== 'assistant') return []

    if (typeof content === 'string') pushAssistant(state, stripMessageId(content))
    else pushContentBlocks(state, arrayField(message, 'content'), options)
    return []
  },

  flush(state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    return flushAssistant(state)
  },

  head(headLines: readonly string[], _tailLines: readonly string[]): TranscriptHead {
    let cwd: string | undefined
    let createdAt: number | undefined
    let firstPrompt: string | undefined

    for (const line of headLines) {
      const record = parseRecord(line)
      if (record === undefined) continue
      if (record['type'] === 'session') {
        cwd ??= stringField(record, 'cwd')
        createdAt ??= parseTimestamp(record['timestamp'])
        continue
      }
      if (record['type'] !== 'message' || firstPrompt !== undefined) continue
      const message = objectField(record, 'message')
      if (message?.['role'] !== 'user') continue
      createdAt ??= parseTimestamp(record['timestamp'])
      const text = contentBlockUserText(message['content'])
      if (text !== undefined) firstPrompt = stripMessageId(text)
    }

    const title = normalizeTitle(firstPrompt ?? basename(cwd) ?? '')
    return {
      ...title === '' ? {} : { title },
      ...cwd === undefined ? {} : { cwd },
      ...firstPrompt === undefined ? {} : { firstPrompt },
      ...createdAt === undefined ? {} : { createdAt },
    }
  },
}

/**
 * Drop the gateway's trailing `[message_id: …]` marker.
 * @param text - one message body.
 * @returns the body without the marker, or unchanged when it carried none.
 */
function stripMessageId(text: string): string {
  const at = text.lastIndexOf(MESSAGE_ID_SUFFIX)
  return at === -1 ? text : text.slice(0, at).trimEnd()
}

/**
 * The last segment of a recorded path, as a last-resort session name.
 *
 * Deliberately not `node:path`'s: the transcript may have been written on a
 * different platform than the one reading it, so both separators are honoured
 * regardless of which one this host uses.
 * @param path - the recorded `cwd`, if there was one.
 * @returns the final segment, or undefined when there is nothing to name.
 */
function basename(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const trimmed = path.replace(/[\\/]+$/u, '')
  const segment = trimmed.split(/[\\/]/u).pop()
  return segment === undefined || segment === '' ? undefined : segment
}
