/**
 * Projection rules every transcript adapter needs, in one place.
 *
 * These are the parts of the fold that are about *conversations* rather than
 * about any one agent's record shape — merging an assistant run, deciding what
 * a tool call looks like, telling a person's words from the harness's. Keeping
 * them here is what makes two adapters agree on what a "turn" is.
 *
 * @module dsh-reference-anything/local-agent/adapters/shared
 */

import type { AdapterState, ConvertOptions, ParsedTurn, ToolCallMode } from '../types.ts'

/**
 * Precedes the text an agent left in place of the turns a compaction discarded.
 *
 * Shared rather than restated per adapter because it is a contract with the
 * reader, not a detail of any one format: four agents compact, and a model that
 * learned what the marker means in one transcript must not meet a different
 * wording in the next.
 */
export const COMPACTION_MARKER = '[compacted summary of the earlier conversation]'

/** Longest title kept; past this a name stops being scannable in a menu row. */
export const TITLE_MAX_CHARS = 80

/** Marks a title that was cut, so a truncated name never reads as the whole one. */
const ELLIPSIS = '…'

/**
 * Collapse a candidate title to one scannable line.
 * @param text - raw title text from any field.
 * @returns the normalized title, or an empty string when nothing survived.
 */
export function normalizeTitle(text: unknown): string {
  const collapsed = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= TITLE_MAX_CHARS) return collapsed
  return collapsed.slice(0, TITLE_MAX_CHARS - ELLIPSIS.length) + ELLIPSIS
}

/**
 * Wrappers a harness is known to inject around, or instead of, a person's words.
 *
 * Listed by name so a single-line one — `<system-reminder>` arrives appended to
 * the end of a real message — is still recognized. Anything not on this list
 * has to look like an injection structurally; see {@link HARNESS_TAG_SHAPE}.
 */
const KNOWN_HARNESS_TAGS = new Set([
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'command-contents',
  'environment_context',
  'user_instructions',
  'skills_instructions',
  'recommended_plugins',
  'turn_aborted',
  'INSTRUCTIONS',
])

/**
 * What an injected tag name looks like when it is not on the list.
 *
 * Harness tags are multi-word identifiers — `recommended_plugins`,
 * `system-reminder` — or shouted ones like `INSTRUCTIONS`. Ordinary markup a
 * person might paste into a question is a single lowercase word: `div`, `p`,
 * `pre`, `code`. Splitting on that shape is what lets an unknown injection be
 * stripped the day it appears without eating a web developer's example.
 */
const HARNESS_TAG_SHAPE = /^(?:[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+|[A-Z][A-Z0-9_]*)$/u

/** A balanced, attribute-free element and the whitespace after it. */
const BLOCK = /<([A-Za-z_][\w.-]*)>[\s\S]*?<\/\1>[ \t]*\n?/gu

/** A residue that is only a heading, left behind when its body was an injection. */
const LONE_HEADING = /^#{1,6}[ \t][^\n]*$/u

/**
 * Remove harness-injected wrappers from a message.
 * @param text - the raw message text.
 * @returns the surviving text, and whether anything was removed.
 */
export function stripHarnessBlocks(text: string): { readonly text: string; readonly stripped: boolean } {
  let stripped = false
  const survived = text.replace(BLOCK, (match: string, tag: string) => {
    // An unknown tag has to be both injection-shaped and multi-line: a
    // one-line `<my-component>x</my-component>` in a question is not markup
    // this package gets to delete.
    if (!KNOWN_HARNESS_TAGS.has(tag) && !(HARNESS_TAG_SHAPE.test(tag) && match.includes('\n'))) return match
    stripped = true
    return ''
  })
  return { text: survived.trim(), stripped }
}

/**
 * Reduce one user message to the words a person actually typed.
 *
 * Codex opens a session by sending the repository's `AGENTS.md` as a user
 * message: a markdown heading naming the file, then the whole file inside an
 * `<INSTRUCTIONS>` block. Measured over 60 rollouts, stripping the block alone
 * leaves exactly that orphaned heading — which then became the rollout's title
 * for 58 of them. So a heading left standing alone by a stripped block goes too.
 * @param text - the raw message text.
 * @returns the user's words, or an empty string when the message was all machinery.
 */
export function cleanUserText(text: string): string {
  const { text: body, stripped } = stripHarnessBlocks(text)
  if (stripped && LONE_HEADING.test(body)) return ''
  return body
}

/**
 * Render one tool call at the configured fidelity.
 * @param name - the tool's name; a missing one still records that a call happened.
 * @param input - the call's arguments, as the transcript recorded them.
 * @param mode - how much detail to keep.
 * @param summaryChars - cap for `'summarize'`.
 * @returns the rendered line, or undefined when the mode drops calls.
 */
export function renderToolCall(
  name: unknown,
  input: unknown,
  mode: ToolCallMode,
  summaryChars: number,
): string | undefined {
  if (mode === 'drop') return undefined
  const label = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'unknown'
  if (mode === 'elide') return `[tool: ${label}]`
  if (mode === 'full') {
    const detail = fullInput(input)
    return detail === '' ? `[tool: ${label}]` : `[tool: ${label}] ${detail}`
  }
  const detail = summarizeInput(input, summaryChars)
  return detail === '' ? `[tool: ${label}]` : `[tool: ${label}] ${detail}`
}

/** Render one tool result with the same fidelity policy as its call. */
export function renderToolResult(output: unknown, mode: ToolCallMode, summaryChars: number): string | undefined {
  if (mode === 'drop') return undefined
  if (mode === 'elide') return '[tool output]'
  const detail = mode === 'full' ? fullInput(output) : summarizeInput(output, summaryChars)
  return detail === '' ? '[tool output]' : `[tool output] ${detail}`
}

/** Append Anthropic-style tool_result blocks attributed to the user role. */
export function pushToolResults(state: AdapterState, blocks: unknown, options: ConvertOptions): void {
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const entry = block as Record<string, unknown>
    if (entry['type'] === 'tool_result') {
      pushAssistant(state, renderToolResult(entry['content'], options.toolResults, options.toolSummaryChars))
    }
  }
}

/** Serialize a call's complete argument payload without truncating or flattening it. */
function fullInput(input: unknown): string {
  if (input === undefined || input === null) return ''
  return typeof input === 'string' ? input : safeStringify(input)
}

/** Flatten a call's arguments to one bounded line. */
function summarizeInput(input: unknown, summaryChars: number): string {
  if (input === undefined || input === null) return ''
  const raw = typeof input === 'string' ? input : safeStringify(input)
  const collapsed = raw.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= summaryChars) return collapsed
  return collapsed.slice(0, Math.max(0, summaryChars - ELLIPSIS.length)) + ELLIPSIS
}

/** JSON that cannot throw: a cyclic or exotic value degrades to its type name. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return `[${typeof value}]`
  }
}

/** Fresh state for one file. */
export function createSharedState(): AdapterState {
  return { pending: [], held: [], seen: new Set(), compacted: false }
}

/**
 * Hold one raw record for a format that cannot fold until the file ends.
 * @param state - fold state, mutated in place.
 * @param line - the raw line, kept verbatim so `flush` can reassemble the document.
 * @returns nothing, always — a held record completes no turn by definition.
 */
export function holdLine(state: AdapterState, line: string): readonly ParsedTurn[] {
  state.held.push(line)
  return []
}

/**
 * Take everything held so far as one document, leaving the state empty.
 * @param state - fold state, mutated in place.
 * @returns the reassembled text, or undefined when nothing was held.
 */
export function takeHeld(state: AdapterState): string | undefined {
  if (state.held.length === 0) return undefined
  const text = state.held.join('\n')
  state.held.length = 0
  return text
}

/**
 * Parse a whole JSON document, tolerating the ways a probe can truncate one.
 * @param text - the document, or a prefix of it.
 * @returns the parsed value, or undefined when it was not complete JSON.
 */
export function parseDocument(text: string | undefined): unknown {
  if (text === undefined) return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // A prefix of a JSON document is not a smaller document. The caller
    // degrades to a filename label rather than guessing at the missing half.
    return undefined
  }
}

/**
 * Fold an Anthropic-style content-block array into the open assistant run.
 *
 * Four of the supported agents adopted the Messages API's block shape
 * verbatim — `{type: 'text' | 'thinking' | 'tool_use' | 'tool_result', …}` —
 * so the projection is shared rather than copied per adapter. Aliases that a
 * particular harness uses for plain text (`input_text`, `output_text`) are
 * accepted here too, because rejecting them would silently drop replies.
 * @param state - fold state, mutated in place.
 * @param blocks - the content array; a non-array is ignored.
 * @param options - projection settings.
 */
export function pushContentBlocks(state: AdapterState, blocks: unknown, options: ConvertOptions): void {
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const entry = block as Record<string, unknown>
    switch (entry['type']) {
      case 'text':
      case 'input_text':
      case 'output_text':
        pushAssistant(state, typeof entry['text'] === 'string' ? entry['text'] : undefined)
        break
      case 'thinking':
      case 'reasoning':
        if (options.includeThinking) {
          const thought = entry['thinking'] ?? entry['text'] ?? entry['reasoning']
          pushAssistant(state, typeof thought === 'string' ? thought : undefined)
        }
        break
      case 'tool_use':
      case 'toolCall':
      case 'function_call':
        pushAssistant(state, renderToolCall(
          entry['name'],
          // Pi names the argument bag `arguments`; the Messages API names it
          // `input`. Accepting both costs one `??` and saves a whole adapter.
          entry['input'] ?? entry['arguments'],
          options.toolCalls,
          options.toolSummaryChars,
        ))
        break
      case 'tool_result':
        pushAssistant(state, renderToolResult(entry['content'], options.toolResults, options.toolSummaryChars))
        break
      default:
        // `redacted_thinking`, images, and whatever a later
        // build adds carry nothing this projection can use. Skipping silently
        // is what keeps a new block type from breaking an old adapter.
        break
    }
  }
}

/**
 * The words a person typed, from an Anthropic-style message content value.
 *
 * A string body is always a real turn. An array body is usually a batch of
 * `tool_result` blocks the harness attributes to the user role — plumbing —
 * but occasionally carries `text` blocks, such as the note left when someone
 * interrupts a tool call. So the discriminator is the block type, not the
 * container type.
 * @param content - the `content` field, of unknown shape.
 * @param clean - whether to strip harness-injected wrappers.
 * @returns the user's words, or undefined when the record is not a turn.
 */
export function contentBlockUserText(content: unknown, clean = true): string | undefined {
  if (typeof content === 'string') return blankToUndefined(content, clean)
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    const entry = block as Record<string, unknown>
    const type = entry['type']
    if (type !== 'text' && type !== 'input_text' && type !== 'output_text') continue
    if (typeof entry['text'] === 'string') parts.push(entry['text'])
  }
  return parts.length === 0 ? undefined : blankToUndefined(parts.join('\n'), clean)
}

/**
 * Normalize a message body and collapse an empty result to `undefined`.
 * @param text - the raw body.
 * @param clean - whether to strip harness-injected wrappers first.
 * @returns the surviving text, or undefined when nothing survived.
 */
export function blankToUndefined(text: string, clean = true): string | undefined {
  const body = (clean ? cleanUserText(text) : text).trim()
  return body === '' ? undefined : body
}

/**
 * Buffer one fragment of the assistant run currently open.
 * @param state - fold state, mutated in place.
 * @param text - the fragment; blank fragments are ignored.
 */
export function pushAssistant(state: AdapterState, text: string | undefined): void {
  const trimmed = text?.trim() ?? ''
  if (trimmed !== '') state.pending.push(trimmed)
}

/**
 * Close the assistant run, if one is open.
 *
 * Agents emit an assistant reply as a run of separate records — text, then
 * reasoning, then one per tool call — so the run is what corresponds to a turn
 * a person would recognize. Joining with a blank line keeps the fragments
 * legible without inventing structure the transcript did not have.
 * @param state - fold state, mutated in place.
 * @returns the completed turn, or nothing when no run was open.
 */
export function flushAssistant(state: AdapterState): readonly ParsedTurn[] {
  if (state.pending.length === 0) return []
  const text = state.pending.join('\n\n').trim()
  state.pending.length = 0
  return text === '' ? [] : [{ role: 'assistant', text }]
}

/**
 * Close any open assistant run and open a user turn after it.
 * @param state - fold state, mutated in place.
 * @param text - the user's words; a blank message yields no turn.
 * @returns the closed assistant run followed by the user turn.
 */
export function emitUser(state: AdapterState, text: string): readonly ParsedTurn[] {
  const closed = flushAssistant(state)
  const trimmed = text.trim()
  return trimmed === '' ? closed : [...closed, { role: 'user', text: trimmed }]
}

/**
 * Parse one JSONL record.
 *
 * A malformed line is an ordinary state, not a failure: the agent that owns
 * the file may be mid-write on its last line while this one reads it.
 * @param line - one raw line.
 * @returns the record, or undefined when the line is not a JSON object.
 */
export function parseRecord(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.charCodeAt(0) !== 0x7b) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/** Read a string field, treating a blank one as absent. */
export function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Read a nested object field. */
export function objectField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Read an array field. */
export function arrayField(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const value = record?.[key]
  return Array.isArray(value) ? value : undefined
}

/**
 * Parse an ISO timestamp to epoch milliseconds.
 * @param value - the raw field, of unknown type.
 * @returns the timestamp, or undefined when it is not a usable date.
 */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds and milliseconds are both in the wild; anything below this
    // threshold is a second count no plausible transcript could mean as ms.
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value)
  }
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Default projection settings, used by tests and by any caller that has no config. */
export const DEFAULT_CONVERT_OPTIONS: ConvertOptions = {
  includeThinking: false,
  toolCalls: 'full',
  toolResults: 'full',
  includeSidechains: false,
  stripEnvironmentPreamble: true,
  toolSummaryChars: 200,
}
