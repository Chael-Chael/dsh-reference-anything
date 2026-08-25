/**
 * Claude Code transcripts: `~/.claude/projects/<project-slug>/<uuid>.jsonl`.
 *
 * The file is an append-only log of everything the CLI drew, not a
 * conversation: on a measured 70-file sample it held 6,277 `user` records of
 * which only 565 carried a string body — the other 5,712 were arrays of
 * `tool_result` blocks — against 11,434 `assistant` records that split text,
 * reasoning, and each tool call into separate entries. Both facts drive the
 * fold below, because projecting records one-to-one would bury the
 * conversation under its own plumbing.
 *
 * @module dsh-reference-anything/local-agent/adapters/claude-code
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
  cleanUserText,
  createSharedState,
  emitUser,
  flushAssistant,
  normalizeTitle,
  objectField,
  parseRecord,
  parseTimestamp,
  pushAssistant,
  renderToolCall,
  pushToolResults,
  stringField,
} from './shared.ts'

/** Reads Claude Code's session transcripts. */
export const claudeCodeAdapter: TranscriptAdapter = {
  kind: 'claude-code',
  displayName: 'Claude Code',

  defaultRoots(home: string): readonly string[] {
    return [joinLocalPath(home, '.claude', 'projects')]
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
    // `isMeta` marks records the CLI generated about itself — the caveat that
    // precedes a slash command's output, for one. They read as the user
    // speaking and are not.
    if (record['isMeta'] === true) return []
    if (record['isSidechain'] === true && !options.includeSidechains) return []

    const type = record['type']
    if (type === 'user') return stepUser(record, state, options)
    if (type === 'assistant') return stepAssistant(record, state, options)
    // Every other record type — `ai-title`, `last-prompt`, `mode`,
    // `attachment`, `file-history-*`, `atis-latch` — is CLI state, not
    // conversation. Titles come from head() instead, where a bounded probe can
    // reach the newest one.
    return []
  },

  flush(state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    return flushAssistant(state)
  },

  head(headLines: readonly string[], tailLines: readonly string[]): TranscriptHead {
    const found: {
      aiTitle?: string
      summary?: string
      lastPrompt?: string
      slug?: string
      cwd?: string
      firstPrompt?: string
      createdAt?: number
    } = {}

    // Head first, then tail, and later wins for every field that can be
    // rewritten: Claude Code re-emits `ai-title` as its guess improves — 1,421
    // times across the same sample — so a head-only read gets a stale name.
    for (const line of [...headLines, ...tailLines]) {
      const record = parseRecord(line)
      if (record === undefined) continue
      const type = record['type']
      if (type === 'ai-title') found.aiTitle = stringField(record, 'aiTitle') ?? found.aiTitle
      else if (type === 'summary') found.summary = stringField(record, 'summary') ?? found.summary
      else if (type === 'last-prompt') found.lastPrompt = stringField(record, 'lastPrompt') ?? found.lastPrompt
      found.slug = stringField(record, 'slug') ?? found.slug
      found.cwd = stringField(record, 'cwd') ?? found.cwd
      if (found.createdAt === undefined) found.createdAt = parseTimestamp(record['timestamp'])
    }

    // The opening prompt comes from the head alone — the tail's user records
    // are the newest ones and would name the wrong thing.
    for (const line of headLines) {
      const record = parseRecord(line)
      if (record === undefined || record['type'] !== 'user') continue
      if (record['isMeta'] === true || record['isCompactSummary'] === true) continue
      const text = userText(record)
      if (text !== undefined) {
        found.firstPrompt = text
        break
      }
    }

    const title = normalizeTitle(
      found.aiTitle ?? found.summary ?? found.lastPrompt ?? found.slug ?? found.firstPrompt ?? '',
    )
    return {
      ...title === '' ? {} : { title },
      ...found.cwd === undefined ? {} : { cwd: found.cwd },
      ...found.firstPrompt === undefined ? {} : { firstPrompt: found.firstPrompt },
      ...found.createdAt === undefined ? {} : { createdAt: found.createdAt },
    }
  },
}

/** Fold one `user` record, which is a real turn far less often than it looks. */
function stepUser(
  record: Record<string, unknown>,
  state: AdapterState,
  options: ConvertOptions,
): readonly ParsedTurn[] {
  if (record['isCompactSummary'] === true || record['subtype'] === 'compact_boundary') {
    state.compacted = true
    const summary = userText(record)
    const closed = flushAssistant(state)
    return summary === undefined
      ? closed
      : [...closed, { role: 'assistant', text: `${COMPACTION_MARKER}\n\n${summary}` }]
  }
  pushToolResults(state, objectField(record, 'message')?.['content'], options)
  const text = userText(record)
  return text === undefined ? [] : emitUser(state, text)
}

/** Fold one `assistant` record into the open run rather than into a turn of its own. */
function stepAssistant(
  record: Record<string, unknown>,
  state: AdapterState,
  options: ConvertOptions,
): readonly ParsedTurn[] {
  const blocks = arrayField(objectField(record, 'message'), 'content')
  if (blocks === undefined) return []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const entry = block as Record<string, unknown>
    switch (entry['type']) {
      case 'text':
        pushAssistant(state, typeof entry['text'] === 'string' ? entry['text'] : undefined)
        break
      case 'thinking':
        if (options.includeThinking) {
          pushAssistant(state, typeof entry['thinking'] === 'string' ? entry['thinking'] : undefined)
        }
        break
      case 'tool_use':
        pushAssistant(state, renderToolCall(entry['name'], entry['input'], options.toolCalls, options.toolSummaryChars))
        break
      default:
        // `redacted_thinking` and anything a later CLI adds carry nothing a
        // reader can use; silently skipping keeps new record shapes harmless.
        break
    }
  }
  return []
}

/**
 * The words a person actually typed in one `user` record, if any.
 *
 * A string body is always a real turn. An array body is usually a batch of
 * `tool_result` blocks the CLI attributes to the user role — plumbing, and the
 * overwhelming majority — but occasionally carries `text` blocks, such as the
 * note left when someone interrupts a tool call. So the discriminator is the
 * block type, not the container type.
 * @param record - one `user` record.
 * @returns the user's text, or undefined when the record is not a turn.
 */
function userText(record: Record<string, unknown>): string | undefined {
  const content = objectField(record, 'message')?.['content']
  if (typeof content === 'string') return blank(cleanUserText(content))
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const entry = block as Record<string, unknown>
    if (entry['type'] === 'text' && typeof entry['text'] === 'string') parts.push(entry['text'])
  }
  return parts.length === 0 ? undefined : blank(cleanUserText(parts.join('\n')))
}

/** Collapse an empty result to `undefined`, so callers test one thing. */
function blank(text: string): string | undefined {
  return text.trim() === '' ? undefined : text.trim()
}
