/**
 * Kimi CLI and Kimi Code: `wire.jsonl` under
 * `~/.kimi/sessions/<workdir-md5>/<session>/` (older) or
 * `~/.kimi-code/sessions/<workspace>/<session>/agents/main/` (newer).
 *
 * Both generations are read here because they are the same product and a user
 * upgrading mid-project leaves both on disk. They are told apart per record:
 * the old wire wraps everything as `{timestamp, message: {type, payload}}`
 * with PascalCase event names, the new one writes `{type, time, …}` flat with
 * dotted ones.
 *
 * What makes Kimi different from every other supported format is that its
 * assistant content is a *stream*: `TextPart` and `content.part` records each
 * carry a fragment of one sentence, split wherever the model's tokens landed.
 * They must be concatenated, not joined — the blank line the shared buffer
 * puts between fragments would fall in the middle of a word. Hence the
 * chunk-accumulating helpers below, which are this adapter's only real logic.
 *
 * A spawned subagent gets its own `wire.jsonl` under `agents/<name>/`, and the
 * main thread additionally mirrors its events as `SubagentEvent`. Listing both
 * would duplicate the work, so only `agents/main/` is accepted from the newer
 * layout and the mirrored events are skipped.
 *
 * @module dsh-reference-anything/local-agent/adapters/kimi
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
  blankToUndefined,
  createSharedState,
  emitUser,
  flushAssistant,
  normalizeTitle,
  objectField,
  parseRecord,
  parseTimestamp,
  pushAssistant,
  renderToolCall,
} from './shared.ts'

/** Marks the tail of `state.pending` as an open run of streamed text. */
const OPEN_TEXT = 'kimi:text'
/** Marks the tail of `state.pending` as an open run of streamed reasoning. */
const OPEN_THINK = 'kimi:think'

/** Reads Kimi CLI and Kimi Code wire logs. */
export const kimiAdapter: TranscriptAdapter = {
  kind: 'kimi',
  displayName: 'Kimi',

  defaultRoots(home: string): readonly string[] {
    return [join(home, '.kimi', 'sessions'), join(home, '.kimi-code', 'sessions')]
  },

  matches(relativePath: string): boolean {
    const path = relativePath.toLowerCase()
    if (!path.endsWith('/wire.jsonl') && path !== 'wire.jsonl') return false
    // The newer layout files every agent under `agents/<name>/`; only the main
    // thread is a session of its own.
    return !path.includes('/agents/') || path.includes('/agents/main/')
  },

  createState(): AdapterState {
    return createSharedState()
  },

  step(line: string, state: AdapterState, options: ConvertOptions): readonly ParsedTurn[] {
    const record = parseRecord(line)
    if (record === undefined) return []
    const legacy = objectField(record, 'message')
    // The old wire's `message` is itself an event envelope; the new wire's is
    // an ordinary chat message. The presence of a `type` inside it decides.
    return typeof legacy?.['type'] === 'string'
      ? stepLegacy(legacy, state, options)
      : stepModern(record, state, options)
  },

  flush(state: AdapterState, _options: ConvertOptions): readonly ParsedTurn[] {
    closeRun(state)
    return flushAssistant(state)
  },

  head(headLines: readonly string[], _tailLines: readonly string[]): TranscriptHead {
    let createdAt: number | undefined
    let firstPrompt: string | undefined

    for (const line of headLines) {
      const record = parseRecord(line)
      if (record === undefined) continue
      createdAt ??= parseTimestamp(record['time'] ?? record['created_at'] ?? record['timestamp'])
      if (firstPrompt !== undefined) continue
      const legacy = objectField(record, 'message')
      if (typeof legacy?.['type'] === 'string') {
        if (legacy['type'] !== 'TurnBegin' && legacy['type'] !== 'SteerInput') continue
        firstPrompt = blankToUndefined(partsText(objectField(legacy, 'payload')?.['user_input']))
        continue
      }
      if (record['type'] === 'turn.prompt') {
        firstPrompt = blankToUndefined(partsText(record['input']))
      } else if (record['type'] === 'context.append_message') {
        const message = objectField(record, 'message')
        if (message?.['role'] === 'user') firstPrompt = blankToUndefined(partsText(message['content']))
      }
    }

    // Kimi keeps a renamed session's title in the sibling `state.json`, which a
    // probe of this file cannot reach, so the opening prompt is the name.
    const title = normalizeTitle(firstPrompt ?? '')
    return {
      ...title === '' ? {} : { title },
      ...firstPrompt === undefined ? {} : { firstPrompt },
      ...createdAt === undefined ? {} : { createdAt },
    }
  },
}

/** Fold one event from the older `{timestamp, message: {type, payload}}` wire. */
function stepLegacy(
  message: Record<string, unknown>,
  state: AdapterState,
  options: ConvertOptions,
): readonly ParsedTurn[] {
  const payload = objectField(message, 'payload') ?? {}
  switch (message['type']) {
    case 'TurnBegin':
    case 'SteerInput': {
      // `SteerInput` is text typed while the agent was already working. It is
      // still the user speaking, so it opens a turn like any other prompt.
      const text = blankToUndefined(partsText(payload['user_input']))
      if (text === undefined) return []
      closeRun(state)
      return emitUser(state, text)
    }
    case 'TextPart':
      appendChunk(state, OPEN_TEXT, payload['text'])
      return []
    case 'ThinkPart':
      if (options.includeThinking) appendChunk(state, OPEN_THINK, payload['think'])
      return []
    case 'ToolCall': {
      closeRun(state)
      const fn = objectField(payload, 'function') ?? {}
      pushAssistant(state, renderToolCall(
        fn['name'], fn['arguments'], options.toolCalls, options.toolSummaryChars,
      ))
      return []
    }
    case 'StepBegin':
    case 'TurnEnd':
      // A step boundary ends the streamed run without ending the turn: the
      // next fragment starts a new paragraph rather than the same sentence.
      closeRun(state)
      return []
    default:
      // `ToolCallPart` restates arguments the final `ToolCall` already carries,
      // `ToolResult` is plumbing, `SubagentEvent` mirrors another file, and
      // the status events carry no conversation at all.
      return []
  }
}

/** Fold one event from the newer flat `{type, time, …}` wire. */
function stepModern(
  record: Record<string, unknown>,
  state: AdapterState,
  options: ConvertOptions,
): readonly ParsedTurn[] {
  switch (record['type']) {
    case 'turn.prompt': {
      const text = blankToUndefined(partsText(record['input']))
      if (text === undefined) return []
      state.seen.add('kimi:prompted')
      closeRun(state)
      return emitUser(state, text)
    }
    case 'context.append_message': {
      // The same prompt is also appended to the context, so this is a fallback
      // for transcripts that carry no `turn.prompt` — taking both would double
      // every user turn.
      if (state.seen.has('kimi:prompted')) return []
      const message = objectField(record, 'message')
      if (message?.['role'] !== 'user') return []
      const text = blankToUndefined(partsText(message['content']))
      if (text === undefined) return []
      closeRun(state)
      return emitUser(state, text)
    }
    case 'context.append_loop_event':
      return stepLoopEvent(objectField(record, 'event') ?? {}, state, options)
    case 'turn.ended':
      closeRun(state)
      return []
    default:
      return []
  }
}

/** Fold one `context.append_loop_event`, where the newer wire keeps assistant content. */
function stepLoopEvent(
  event: Record<string, unknown>,
  state: AdapterState,
  options: ConvertOptions,
): readonly ParsedTurn[] {
  switch (event['type']) {
    case 'content.part': {
      const part = objectField(event, 'part') ?? {}
      if (part['type'] === 'text') appendChunk(state, OPEN_TEXT, part['text'])
      else if (part['type'] === 'think' && options.includeThinking) appendChunk(state, OPEN_THINK, part['think'])
      return []
    }
    case 'tool.call':
      closeRun(state)
      pushAssistant(state, renderToolCall(
        event['name'], event['args'], options.toolCalls, options.toolSummaryChars,
      ))
      return []
    case 'step.begin':
    case 'step.end':
      closeRun(state)
      return []
    default:
      // `tool.result` is plumbing; everything else is internal bookkeeping.
      return []
  }
}

/**
 * Concatenate one streamed fragment onto the run of the same kind.
 *
 * Appends in place when a run of this kind is already open, because the
 * fragments are halves of one sentence. Anything else — a different kind, a
 * tool call, a step boundary — closes the run first, so the shared buffer's
 * blank-line join only ever falls between things that really are separate.
 * @param state - fold state, mutated in place.
 * @param kind - which run this fragment belongs to.
 * @param value - the fragment, of unknown type.
 */
function appendChunk(state: AdapterState, kind: string, value: unknown): void {
  if (typeof value !== 'string' || value === '') return
  const last = state.pending.length - 1
  if (last >= 0 && state.seen.has(kind)) {
    state.pending[last] = `${state.pending[last] ?? ''}${value}`
    return
  }
  closeRun(state)
  state.pending.push(value)
  state.seen.add(kind)
}

/** End any open streamed run, so the next fragment starts its own entry. */
function closeRun(state: AdapterState): void {
  state.seen.delete(OPEN_TEXT)
  state.seen.delete(OPEN_THINK)
}

/**
 * Flatten a Kimi `ContentPart` value to text.
 *
 * A prompt is a string on some builds and an array of `{text}` parts on
 * others. Parts are joined without a separator: they are fragments of one
 * message, not a list of messages.
 * @param input - the raw value, of unknown shape.
 * @returns the flattened text; empty when nothing readable was found.
 */
function partsText(input: unknown): string {
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) return ''
  const parts: string[] = []
  for (const part of input) {
    if (typeof part === 'string') parts.push(part)
    else if (typeof part === 'object' && part !== null) {
      const text = (part as Record<string, unknown>)['text']
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('')
}
