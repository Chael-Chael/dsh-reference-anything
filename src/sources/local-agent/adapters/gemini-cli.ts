/**
 * Gemini CLI chats: `~/.gemini/history/<slot>/chats/session-*.json`.
 *
 * The only supported format that is not line-delimited. One file is one JSON
 * object — `{sessionId, projectHash, startTime, directories, messages}` — so
 * half of it is not a shorter conversation, and the adapter declares itself
 * {@link TranscriptAdapter.document} to say so: records are held verbatim
 * until the file ends, then parsed once.
 *
 * The messages themselves are the simplest of any agent: `user` carries a
 * parts array, `gemini` carries a plain string plus its `thoughts` and
 * `toolCalls`, and `info` is the CLI's own banner text. Tool results are
 * inlined on the call rather than split into a following record, which this
 * projection drops along with every other result.
 *
 * @module dsh-reference-anything/local-agent/adapters/gemini-cli
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
  blankToUndefined,
  createSharedState,
  emitUser,
  flushAssistant,
  holdLine,
  normalizeTitle,
  parseDocument,
  parseTimestamp,
  pushAssistant,
  renderToolCall,
  renderToolResult,
  takeHeld,
} from './shared.ts'

/** Reads Gemini CLI chat files. */
export const geminiCliAdapter: TranscriptAdapter = {
  kind: 'gemini-cli',
  displayName: 'Gemini CLI',
  document: true,

  defaultRoots(home: string): readonly string[] {
    return [joinLocalPath(home, '.gemini', 'history')]
  },

  matches(relativePath: string): boolean {
    const path = relativePath.toLowerCase()
    return path.includes('/chats/') && path.endsWith('.json')
  },

  createState(): AdapterState {
    return createSharedState()
  },

  step(line: string, state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    return holdLine(state, line)
  },

  flush(state: AdapterState, options: ConvertOptions): readonly ParsedTurn[] {
    const chat = asRecord(parseDocument(takeHeld(state)))
    const messages = chat?.['messages']
    if (!Array.isArray(messages)) return []

    const turns: ParsedTurn[] = []
    for (const message of messages) {
      const entry = asRecord(message)
      if (entry === undefined) continue
      if (entry['type'] === 'user') {
        const text = blankToUndefined(partsText(entry['content']))
        if (text !== undefined) turns.push(...emitUser(state, text))
      } else if (entry['type'] === 'gemini') {
        pushGemini(entry, state, options)
      }
      // `info` is a CLI banner — an error notice, a cancellation — not speech.
    }
    turns.push(...flushAssistant(state))
    return turns
  },

  head(headLines: readonly string[], tailLines: readonly string[]): TranscriptHead {
    // A probe that captured the whole small file parses; one that captured a
    // prefix of a large file does not, and the entry degrades to its filename
    // rather than to a guess at the missing half.
    const chat = asRecord(parseDocument(headLines.join('\n')))
      ?? asRecord(parseDocument([...headLines, ...tailLines].join('\n')))
    if (chat === undefined) return {}

    const messages = Array.isArray(chat['messages']) ? chat['messages'] : []
    let firstPrompt: string | undefined
    for (const message of messages) {
      const entry = asRecord(message)
      if (entry?.['type'] !== 'user') continue
      firstPrompt = blankToUndefined(partsText(entry['content']))
      if (firstPrompt !== undefined) break
    }

    const directories = chat['directories']
    const cwd = Array.isArray(directories) && typeof directories[0] === 'string' ? directories[0] : undefined
    const createdAt = parseTimestamp(chat['startTime'])
    const title = normalizeTitle(firstPrompt ?? '')
    return {
      ...title === '' ? {} : { title },
      ...cwd === undefined ? {} : { cwd },
      ...firstPrompt === undefined ? {} : { firstPrompt },
      ...createdAt === undefined ? {} : { createdAt },
    }
  },
}

/** Fold one `gemini` message into the open assistant run. */
function pushGemini(entry: Record<string, unknown>, state: AdapterState, options: ConvertOptions): void {
  if (typeof entry['content'] === 'string') pushAssistant(state, entry['content'])

  if (options.includeThinking && Array.isArray(entry['thoughts'])) {
    for (const thought of entry['thoughts']) {
      const it = asRecord(thought)
      if (it === undefined) continue
      const parts = [it['subject'], it['description']].filter((v): v is string => typeof v === 'string' && v !== '')
      if (parts.length > 0) pushAssistant(state, parts.join('：'))
    }
  }

  if (!Array.isArray(entry['toolCalls'])) return
  for (const call of entry['toolCalls']) {
    const it = asRecord(call)
    if (it === undefined) continue
    pushAssistant(state, renderToolCall(it['name'], it['args'], options.toolCalls, options.toolSummaryChars))
    const output = it['result'] ?? it['output'] ?? it['response']
    if (output !== undefined) pushAssistant(state, renderToolResult(output, options.toolResults, options.toolSummaryChars))
  }
}

/**
 * Flatten a `parts`-style content value to text.
 * @param content - the message's `content`, of unknown shape.
 * @returns the flattened text; empty when nothing readable was found.
 */
function partsText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const entry = asRecord(part)
    const text = entry?.['text']
    if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim())
  }
  return parts.join('\n')
}

/** Narrow an unknown to a plain object, which is the only shape this format uses. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
