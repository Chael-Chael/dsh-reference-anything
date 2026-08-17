/**
 * Expands reference mentions in a user's prompt into untrusted background.
 *
 * This runs at the loop's pre-step boundary rather than at prompt submission,
 * because submission is owned by each host and has no extension point, while
 * pre-step is shared by every surface — Web, headless, ACP, scheduled runs,
 * and subagents all pass through it. Whatever this listener returns is what
 * the loop durably appends, so injected material is logged by construction and
 * a replay reconstructs the request exactly.
 *
 * Two schemes are expanded. `dsh-ref:` names material outside the harness and
 * is resolved through `ctx.references`. `dsh-session:` names another harness
 * session and is delegated to `ctx.sessionReferenceResolver`, which owns
 * session-surface semantics — compaction folding, shadowed events, cited event
 * seqs — that do not generalize to an outside conversation.
 *
 * @module dsh-reference-anything/reference
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_REFERENCE_SCHEME,
  parseSessionReferenceText,
  type SessionReferenceInput,
} from '@deepseek-ai/dsh-session-reference'
import { ReferenceAnythingError } from './errors.ts'
import { renderReferences, type RenderInput } from './render.ts'
import type { ReferenceContextSource, ReferenceInput } from './types.ts'
import { mayContainReference, parseReferenceText } from './uri.ts'
import type {} from './index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'reference-mention'

/** The registry this expander reads through. */
export const inject = ['references']

/** Upper bound on distinct references in one message, whatever the config says. */
export const MAX_REFERENCES = 3

/** Serialized byte budget applied to each reference when none is configured. */
export const DEFAULT_MAX_REFERENCE_BYTES = 65_536

/** Turns previewed per reference when none is configured. */
export const DEFAULT_PREVIEW_TURNS = 10

/** Deployment settings for mention expansion. */
export interface Config {
  /**
   * Distinct `dsh-ref:` references honored in one message. Capped at
   * {@link MAX_REFERENCES}: past a few sources the background stops being
   * background, and the byte budget multiplies by the same factor.
   */
  maxReferences?: number
  /** Serialized byte budget for each reference, applied independently. */
  maxReferenceBytes?: number
  /**
   * Turns previewed per reference, counting back from the newest. The rest
   * stay reachable through `reference_read`, so this trades prompt size
   * against how often the model has to ask for more.
   */
  previewTurns?: number
  /**
   * Also expand `dsh-session:` mentions. Deployments that deliberately do not
   * mount the cross-session resolver set this false, so such a mention is
   * refused as unsupported rather than probed for on every message.
   */
  serveSessionScheme?: boolean
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  maxReferences: z.number().step(1).min(1).max(MAX_REFERENCES).default(MAX_REFERENCES),
  maxReferenceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REFERENCE_BYTES),
  previewTurns: z.number().step(1).min(1).default(DEFAULT_PREVIEW_TURNS),
  serveSessionScheme: z.boolean().default(true),
})

/** One message with its mentions made readable, and what they named. */
interface ParsedMessage {
  readonly message: UserMessage
  readonly references: readonly ReferenceInput[]
  readonly sessionReferences: readonly SessionReferenceInput[]
}

/**
 * Register the pre-step mention expander.
 * @param ctx - the mounting context.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxReferences = Math.min(config.maxReferences ?? MAX_REFERENCES, MAX_REFERENCES)
  const maxReferenceBytes = config.maxReferenceBytes ?? DEFAULT_MAX_REFERENCE_BYTES
  const previewTurns = config.previewTurns ?? DEFAULT_PREVIEW_TURNS
  const serveSessionScheme = config.serveSessionScheme ?? true

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    // The overwhelmingly common case is a prompt with no mentions at all, and
    // this runs on every step of every turn. Screening with substring scans
    // before any parsing keeps that case free.
    const target = decision.messages.findIndex(candidate =>
      candidate.source.kind === 'user' && messageText(candidate).some(text => mentions(text, serveSessionScheme)))
    if (target < 0) return decision

    const original = decision.messages[target]
    if (original === undefined) return decision

    let parsed: ParsedMessage
    try {
      parsed = parseMessage(original, serveSessionScheme)
    } catch (error: unknown) {
      // A malformed URI inside an explicit mention is the user asking for
      // something that does not exist. Saying so beats sending a prompt whose
      // reference silently resolves to nothing.
      return entered(decision, target, [notice(describe(error))], original)
    }

    if (parsed.references.length === 0 && parsed.sessionReferences.length === 0) return decision

    let contexts: UserMessage[]
    try {
      contexts = await resolve(
        ctx,
        agent,
        parsed,
        { maxReferences, maxReferenceBytes, previewTurns, serveSessionScheme },
        signal,
      )
    } catch (error: unknown) {
      if (signal.aborted) return decision
      contexts = [notice(describe(error))]
    }
    if (signal.aborted) return decision

    return entered(decision, target, contexts, parsed.message)
  }, { prepend: true })
}

interface Limits {
  readonly maxReferences: number
  readonly maxReferenceBytes: number
  readonly previewTurns: number
  readonly serveSessionScheme: boolean
}

/**
 * Read a preview of everything the message named and render it as background.
 *
 * Every named reference appears in the block, whether or not its preview could
 * be read — one that silently vanished would leave the model answering from
 * material the user believes it already has. A reference whose read failed
 * appears with a null preview and the reason, still carrying the uri that
 * fetches it later.
 */
async function resolve(
  ctx: Context,
  agent: Agent,
  parsed: ParsedMessage,
  limits: Limits,
  signal: AbortSignal,
): Promise<UserMessage[]> {
  const contexts: UserMessage[] = []

  if (parsed.sessionReferences.length > 0) {
    const resolver = ctx.get('sessionReferenceResolver')
    if (resolver === undefined) {
      throw new ReferenceAnythingError(
        'this deployment cannot reference other harness sessions: the cross-session resolver is not mounted',
        'SOURCE_UNAVAILABLE',
      )
    }
    const prepared = await resolver.prepare(agent, contentOf(parsed.message), [...parsed.sessionReferences], signal)
    if (prepared.additionalContext !== undefined) contexts.push(prepared.additionalContext)
  }

  if (parsed.references.length > 0) {
    const inputs = dedupe(parsed.references)
    if (inputs.length > limits.maxReferences) {
      throw new ReferenceAnythingError(
        `a message may reference at most ${limits.maxReferences} outside conversation`
        + `${limits.maxReferences === 1 ? '' : 's'}; this one named ${inputs.length}`,
        'REFERENCE_TOO_MANY',
      )
    }
    for (const input of inputs) ctx.references.grant(String(agent.session.id), input.ref)
    const rendered = renderReferences(await readAll(ctx, inputs, limits, signal), limits.maxReferenceBytes)
    contexts.push(createUserMessage({
      content: [{ type: 'text', text: rendered.text }],
      source: {
        kind: 'reference-anything',
        form: 'recall',
        version: 1,
        references: rendered.provenance,
      } satisfies ReferenceContextSource,
    }))
  }

  return contexts
}

/**
 * Read a preview of every named reference.
 *
 * Settled per reference rather than all-or-nothing: a browser that is closed
 * right now should cost the model that one preview, not the whole message. The
 * entry still carries its uri and says why the preview is missing, so the
 * model can fetch it with the tool once the source is back.
 */
async function readAll(
  ctx: Context,
  inputs: readonly ReferenceInput[],
  limits: Limits,
  signal: AbortSignal,
): Promise<RenderInput[]> {
  const settled = await Promise.allSettled(
    inputs.map(input => ctx.references.read(input.ref, { limit: limits.previewTurns }, signal)),
  )
  return settled.map((result, index) => {
    const input = inputs[index]
    /* c8 ignore next -- settled has exactly one entry per input, by construction. */
    if (input === undefined) throw new Error('reference input disappeared while reading')
    return result.status === 'fulfilled'
      ? input.label === undefined
        ? { snapshot: result.value }
        : { snapshot: result.value, label: input.label }
      : input.label === undefined
        ? { ref: input.ref, unavailable: describe(result.reason) }
        : { ref: input.ref, label: input.label, unavailable: describe(result.reason) }
  })
}

/**
 * Replace the claimed message and place the background immediately before it.
 *
 * Adjacency is the point: background is only meaningful next to the prompt
 * that named it, and the prompt stays last so it sits closest to the model's
 * answer.
 */
function entered(
  decision: Extract<PreStepDecision, { kind: 'enter' }>,
  target: number,
  contexts: UserMessage[],
  message: UserMessage,
): PreStepDecision {
  const replaced = decision.messages.with(target, message)
  return { kind: 'enter', messages: replaced.toSpliced(target, 0, ...contexts) }
}

/** Rewrite both schemes' mentions to readable text, preserving message identity. */
function parseMessage(message: UserMessage, serveSessionScheme: boolean): ParsedMessage {
  const references: ReferenceInput[] = []
  const sessionReferences: SessionReferenceInput[] = []
  let changed = false
  const content: ContentBlock[] = message.content.map((block) => {
    if (block.type !== 'text') return block
    const own = parseReferenceText(block.text)
    references.push(...own.references)
    let text = own.text
    if (serveSessionScheme && text.includes(SESSION_REFERENCE_SCHEME)) {
      const session = parseSessionReferenceText(text)
      sessionReferences.push(...session.references)
      text = session.text
    }
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  // freezeMessage keeps the existing identity: the loop claimed this message
  // by id, so minting a new one would log something the inbox never claimed.
  return {
    message: changed ? freezeMessage({ ...message, content }) : message,
    references,
    sessionReferences,
  }
}

/** First-appearance order, one entry per distinct reference. */
function dedupe(references: readonly ReferenceInput[]): ReferenceInput[] {
  const seen = new Set<string>()
  const unique: ReferenceInput[] = []
  for (const reference of references) {
    const key = JSON.stringify([reference.ref.source, reference.ref.id])
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(reference)
  }
  return unique
}

function mentions(text: string, serveSessionScheme: boolean): boolean {
  return mayContainReference(text) || (serveSessionScheme && text.includes(SESSION_REFERENCE_SCHEME))
}

function messageText(message: UserMessage): string[] {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
}

function contentOf(message: UserMessage): ContentBlock[] {
  return message.content.map(block => ({ ...block }))
}

function notice(summary: string): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: `A conversation reference in the previous message could not be resolved: ${summary}`,
    }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: boundContextSummary(summary),
    },
  })
}

/**
 * Flatten an error and its causes into one line for the user.
 *
 * The outer error names which reference failed; the cause names why, and why
 * is the actionable half — "the browser is closed" tells someone what to do
 * where "failed to read chat.json" does not. Bounded in depth so a long
 * provider chain cannot crowd out the message.
 */
function describe(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current instanceof Error && !seen.has(current) && parts.length < 3) {
    seen.add(current)
    const code = current instanceof ReferenceAnythingError ? `${current.code} — ` : ''
    parts.push(`${code}${current.message}`)
    current = current.cause
  }
  return parts.length === 0 ? String(error) : parts.join(': ')
}
