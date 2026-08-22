/**
 * Pi Coding Agent sessions:
 * `~/.pi/agent/sessions/--<cwd>--/<stamp>_<uuid>.jsonl`.
 *
 * Line-delimited, but not linear. Every entry after the `session` header
 * carries an `id` and a `parentId`, and the file accumulates *all* branches a
 * session explored — so reading it front to back would interleave abandoned
 * attempts with the one that was kept. The conversation is the path from the
 * last entry back to the root, which is only knowable once the file has ended;
 * hence {@link TranscriptAdapter.document}. Older v1 files have no ids at all
 * and are treated as a chain in write order.
 *
 * Compaction is respected rather than unwound: from the newest `compaction` on
 * the active path, the conversation is its summary, then whatever it retained,
 * then everything after it. The entries it replaced are not in the file to
 * read, so the summary is the only surviving account of them.
 *
 * Pi also names its blocks differently from the Messages API — a tool call's
 * argument bag is `arguments`, not `input` — which the shared block renderer
 * already accepts.
 *
 * @module dsh-reference-anything/local-agent/adapters/pi
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
  COMPACTION_MARKER,
  arrayField,
  blankToUndefined,
  createSharedState,
  emitUser,
  flushAssistant,
  holdLine,
  normalizeTitle,
  objectField,
  parseRecord,
  parseTimestamp,
  pushAssistant,
  pushContentBlocks,
  stringField,
  takeHeld,
} from './shared.ts'

/** Precedes the text summarizing a branch the session came back from. */
const BRANCH_MARKER = '[summary of an earlier branch]'

/** One entry with its resolved place in the branch tree. */
interface Entry {
  readonly id: string
  readonly parentId: string | undefined
  readonly record: Record<string, unknown>
}

/** Reads Pi Coding Agent sessions. */
export const piAdapter: TranscriptAdapter = {
  kind: 'pi',
  displayName: 'Pi',
  document: true,

  defaultRoots(home: string): readonly string[] {
    return [joinLocalPath(home, '.pi', 'agent', 'sessions')]
  },

  matches(relativePath: string): boolean {
    return relativePath.toLowerCase().endsWith('.jsonl')
  },

  createState(): AdapterState {
    return createSharedState()
  },

  step(line: string, state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    return holdLine(state, line)
  },

  flush(state: AdapterState, options: ConvertOptions): readonly ParsedTurn[] {
    const document = takeHeld(state)
    if (document === undefined) return flushAssistant(state)

    const entries: Entry[] = []
    for (const line of document.split('\n')) {
      const record = parseRecord(line)
      if (record === undefined || record['type'] === 'session') continue
      const id = stringField(record, 'id') ?? `e${entries.length}`
      // v1 wrote no ids, so an entry with no parent continues the previous
      // one. That makes the "tree" a chain, which is what v1 sessions are.
      const parentId = typeof record['parentId'] === 'string'
        ? record['parentId']
        : entries[entries.length - 1]?.id
      entries.push({ id, parentId, record })
    }

    const turns: ParsedTurn[] = []
    for (const item of compacted(activeBranch(entries), state)) {
      turns.push(...foldEntry(item, state, options))
    }
    turns.push(...flushAssistant(state))
    return turns
  },

  head(headLines: readonly string[], tailLines: readonly string[]): TranscriptHead {
    let cwd: string | undefined
    let createdAt: number | undefined
    let named: string | undefined
    let firstPrompt: string | undefined

    // Pi's header is the first line, so a probe of the start always reaches
    // it — the branch tree only matters once turns are being read.
    for (const line of [...headLines, ...tailLines]) {
      const record = parseRecord(line)
      if (record === undefined) continue
      if (record['type'] === 'session') {
        cwd ??= stringField(record, 'cwd')
        createdAt ??= parseTimestamp(record['timestamp'])
        continue
      }
      // A rename writes another `session_info`, so the newest one wins.
      if (record['type'] === 'session_info') named = stringField(record, 'name') ?? named
    }

    for (const line of headLines) {
      const record = parseRecord(line)
      if (record?.['type'] !== 'message') continue
      const message = objectField(record, 'message')
      if (message?.['role'] !== 'user') continue
      firstPrompt = blankToUndefined(userText(message['content']))
      if (firstPrompt !== undefined) break
    }

    const title = normalizeTitle(named ?? firstPrompt ?? '')
    return {
      ...title === '' ? {} : { title },
      ...cwd === undefined ? {} : { cwd },
      ...firstPrompt === undefined ? {} : { firstPrompt },
      ...createdAt === undefined ? {} : { createdAt },
    }
  },
}

/**
 * The path from the newest entry back to the root, in write order.
 *
 * The last entry is the leaf of whichever branch the session ended on, so
 * walking its parents recovers exactly the conversation a person would say
 * happened and discards the attempts they backed out of.
 * @param entries - every entry in the file, in write order.
 * @returns the active path, oldest first.
 */
function activeBranch(entries: readonly Entry[]): readonly Entry[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const path: Entry[] = []
  const seen = new Set<string>()
  let cursor = entries[entries.length - 1]
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    path.push(cursor)
    cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId)
  }
  return path.reverse()
}

/**
 * Trim the path to what survived the newest compaction on it.
 *
 * A `compaction` entry states that everything before it is gone and carries
 * both a summary and, on modern files, the tail it kept verbatim. Older files
 * name the first surviving entry instead.
 * @param path - the active branch, oldest first.
 * @param state - fold state; marked compacted when a boundary is crossed.
 * @returns the entries to fold, oldest first.
 */
function compacted(path: readonly Entry[], state: AdapterState): readonly Entry[] {
  let at = -1
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path[index]?.record['type'] === 'compaction') {
      at = index
      break
    }
  }
  const boundary = at < 0 ? undefined : path[at]
  if (boundary === undefined) return path

  state.compacted = true
  const kept: Entry[] = [boundary]
  const retained = arrayField(boundary.record, 'retainedTail')
  if (retained !== undefined) {
    for (const message of retained) {
      kept.push({ id: '', parentId: undefined, record: { type: 'message', message } })
    }
  } else {
    const from = stringField(boundary.record, 'firstKeptEntryId')
    const start = from === undefined ? -1 : path.findIndex(entry => entry.id === from)
    if (start >= 0) kept.push(...path.slice(start, at))
  }
  kept.push(...path.slice(at + 1))
  return kept
}

/** Fold one entry on the active path. */
function foldEntry(entry: Entry, state: AdapterState, options: ConvertOptions): readonly ParsedTurn[] {
  const record = entry.record
  switch (record['type']) {
    case 'message':
      return foldMessage(objectField(record, 'message'), state, options)
    case 'compaction':
      pushAssistant(state, marked(COMPACTION_MARKER, stringField(record, 'summary')))
      return []
    case 'branch_summary':
      pushAssistant(state, marked(BRANCH_MARKER, stringField(record, 'summary')))
      return []
    default:
      // `model_change`, `thinking_level_change`, `label`, `session_info`, and
      // the extension-injected `custom` entries are session state.
      return []
  }
}

/** Fold one embedded `AgentMessage`, whose role vocabulary is Pi's own. */
function foldMessage(
  message: Record<string, unknown> | undefined,
  state: AdapterState,
  options: ConvertOptions,
): readonly ParsedTurn[] {
  if (message === undefined) return []
  switch (message['role']) {
    case 'user': {
      const text = blankToUndefined(userText(message['content']))
      return text === undefined ? [] : emitUser(state, text)
    }
    case 'assistant':
      pushContentBlocks(state, arrayField(message, 'content'), options)
      return []
    case 'compactionSummary':
      pushAssistant(state, marked(COMPACTION_MARKER, stringField(message, 'summary')))
      return []
    case 'branchSummary':
      pushAssistant(state, marked(BRANCH_MARKER, stringField(message, 'summary')))
      return []
    default:
      // `toolResult` and `bashExecution` are results of work already recorded
      // as a call, and `custom` is an extension's injected context.
      return []
  }
}

/**
 * Flatten a Pi content value to the words a person typed.
 * @param content - the message's `content`, a string or a block array.
 * @returns the flattened text; empty when nothing readable was found.
 */
function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const entry = block as Record<string, unknown>
    if (entry['type'] === 'text' && typeof entry['text'] === 'string' && entry['text'].trim() !== '') {
      parts.push(entry['text'].trim())
    } else if (entry['type'] === 'image') {
      const mime = typeof entry['mimeType'] === 'string' ? entry['mimeType'] : 'image'
      parts.push(`[image: ${mime}]`)
    }
  }
  return parts.join('\n')
}

/** Label a summary so it does not read as something the assistant just said. */
function marked(marker: string, summary: string | undefined): string | undefined {
  const text = summary?.trim() ?? ''
  return text === '' ? undefined : `${marker}\n\n${text}`
}
