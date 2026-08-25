/**
 * Codex CLI rollouts: `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`.
 *
 * Each line is an envelope `{timestamp, ordinal?, type, payload}`. Measured
 * across 170 rollouts, seven envelope types occur — `response_item`,
 * `event_msg`, `session_meta`, `turn_context`, `world_state`, `compacted`, and
 * `inter_agent_communication_metadata` — but only `response_item` carries
 * conversation.
 *
 * `event_msg` is the trap. Its `agent_message` and `user_message` payloads look
 * like the assistant and the user speaking, and they are: they restate what
 * `response_item` already recorded. Counted per file, `event_msg.agent_message`
 * matched `response_item.message` with `role: 'assistant'` one for one across
 * every rollout that had any, so consuming both would double the transcript.
 *
 * @module dsh-reference-anything/local-agent/adapters/codex
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
  renderToolResult,
  stringField,
} from './shared.ts'

/** Reads Codex CLI rollout logs. */
export const codexAdapter: TranscriptAdapter = {
  kind: 'codex',
  displayName: 'Codex',

  defaultRoots(home: string): readonly string[] {
    return [joinLocalPath(home, '.codex', 'sessions')]
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
    const envelope = record['type']
    if (envelope === 'compacted') {
      // Codex's analogue of a compact boundary: `payload.replacement_history`
      // stands in for everything before it, which is no longer in this file.
      state.compacted = true
      return []
    }
    if (envelope !== 'response_item') return []
    const payload = objectField(record, 'payload')
    if (payload === undefined) return []

    switch (payload['type']) {
      case 'message':
        return stepMessage(payload, state, options)
      case 'reasoning':
        if (options.includeThinking) pushAssistant(state, reasoningText(payload))
        return []
      case 'function_call':
        pushAssistant(state, renderToolCall(payload['name'], payload['arguments'], options.toolCalls, options.toolSummaryChars))
        return []
      case 'custom_tool_call':
      case 'local_shell_call':
        pushAssistant(state, renderToolCall(payload['name'], payload['input'], options.toolCalls, options.toolSummaryChars))
        return []
      case 'function_call_output':
      case 'custom_tool_call_output':
        pushAssistant(state, renderToolResult(payload['output'], options.toolResults, options.toolSummaryChars))
        return []
      default:
        // `agent_message` here is not
        // the assistant answering the user — it carries `author` and
        // `recipient` and is one agent dispatching work to another — so it is
        // plumbing too.
        return []
    }
  },

  flush(state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    return flushAssistant(state)
  },

  head(headLines: readonly string[], tailLines: readonly string[]): TranscriptHead {
    let cwd: string | undefined
    let createdAt: number | undefined
    let firstPrompt: string | undefined
    let firstReply: string | undefined

    for (const line of headLines) {
      const record = parseRecord(line)
      if (record === undefined) continue
      const envelope = record['type']
      const payload = objectField(record, 'payload')
      if (envelope === 'session_meta' && payload !== undefined) {
        cwd ??= stringField(payload, 'cwd')
        createdAt ??= parseTimestamp(payload['timestamp'] ?? record['timestamp'])
        continue
      }
      if (envelope === 'turn_context' && payload !== undefined) {
        cwd ??= stringField(payload, 'cwd')
        continue
      }
      if (envelope !== 'response_item' || payload === undefined) continue
      if (firstPrompt === undefined && payload['role'] === 'user') firstPrompt = messageText(payload, true)
      if (firstReply === undefined && payload['role'] === 'assistant') firstReply = messageText(payload, true)
    }
    createdAt ??= parseTimestamp(parseRecord(headLines[0] ?? '')?.['timestamp'])

    // A rollout carries no title of its own, so the opening prompt is the name.
    // The tail can still supply one when the head's probe fell short of the
    // first real prompt — Codex's harness preamble alone can run past a
    // megabyte, and a rollout whose head is all preamble would otherwise show
    // as its filename.
    if (firstPrompt === undefined) {
      for (const line of tailLines) {
        const record = parseRecord(line)
        const payload = objectField(record, 'payload')
        if (record?.['type'] !== 'response_item' || payload?.['role'] !== 'user') continue
        firstPrompt = messageText(payload, true) ?? firstPrompt
        if (firstPrompt !== undefined) break
      }
    }

    // A rollout a parent agent dispatched has no user text at all: its task
    // arrived as an `agent_message` whose payload is encrypted, leaving the
    // injected preamble as the only user-role record. Measured over 25 recent
    // rollouts, 7 were of this kind. The assistant's opening line is then the
    // only readable account of what the session was for, and naming the entry
    // after it beats naming it after its filename.
    const title = normalizeTitle(firstPrompt ?? firstReply ?? '')
    return {
      ...title === '' ? {} : { title },
      ...cwd === undefined ? {} : { cwd },
      ...firstPrompt === undefined ? {} : { firstPrompt },
      ...createdAt === undefined ? {} : { createdAt },
    }
  },
}

/** Fold one `response_item.message`, whose role decides whether it is conversation at all. */
function stepMessage(
  payload: Record<string, unknown>,
  state: AdapterState,
  options: ConvertOptions,
): readonly ParsedTurn[] {
  const role = payload['role']
  if (role === 'user') {
    const text = messageText(payload, options.stripEnvironmentPreamble)
    return text === undefined ? [] : emitUser(state, text)
  }
  if (role === 'assistant') {
    pushAssistant(state, messageText(payload, false))
    return []
  }
  // `developer` is the largest role by count in a modern rollout — skills
  // instructions, tool contracts, environment context. Projecting it would
  // read as though the user had said those things.
  return []
}

/**
 * Flatten a message's content blocks to text.
 * @param payload - a `message` payload.
 * @param stripPreamble - drop the message entirely when it is a harness-injected block.
 * @returns the text, or undefined when the message contributes nothing.
 */
function messageText(payload: Record<string, unknown>, stripPreamble: boolean): string | undefined {
  const blocks = arrayField(payload, 'content')
  if (blocks === undefined) {
    const direct = stringField(payload, 'text')
    return direct === undefined ? undefined : normalizeBody(direct, stripPreamble)
  }
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const entry = block as Record<string, unknown>
    // Assistant blocks arrive as `output_text` and, on some builds, as
    // `input_text`; both were present in the measured corpus.
    if (entry['type'] === 'input_text' || entry['type'] === 'output_text' || entry['type'] === 'text') {
      if (typeof entry['text'] === 'string') parts.push(entry['text'])
    }
  }
  return parts.length === 0 ? undefined : normalizeBody(parts.join('\n'), stripPreamble)
}

/** Apply the preamble rules and collapse an empty result to `undefined`. */
function normalizeBody(text: string, stripPreamble: boolean): string | undefined {
  const cleaned = stripPreamble ? cleanUserText(text) : text.trim()
  return cleaned === '' ? undefined : cleaned
}

/**
 * The visible part of a `reasoning` payload.
 *
 * Codex encrypts its reasoning and leaves `summary` empty in every rollout
 * measured here, so this usually yields nothing — which is why
 * `includeThinking` costs a Codex read almost nothing.
 */
function reasoningText(payload: Record<string, unknown>): string | undefined {
  const summary = arrayField(payload, 'summary') ?? []
  const parts: string[] = []
  for (const block of summary) {
    if (typeof block === 'string') parts.push(block)
    else if (typeof block === 'object' && block !== null) {
      const text = (block as Record<string, unknown>)['text']
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}
