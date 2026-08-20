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
 * This plugin owns only `dsh-ref:`, which names material outside the harness
 * and is resolved through `ctx.references`. Native file and DSH-session
 * references are owned end-to-end by their official DSH services.
 *
 * @module dsh-reference-anything/reference
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { ReferenceAnythingError } from './errors.ts'
import { renderDeferredReferences } from './render.ts'
import type { ReferenceContextSource, ReferenceInput } from './types.ts'
import { mayContainReference, parseReferenceText } from './uri.ts'
import type {} from './index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'reference-mention'

/** The registry this expander reads through. */
export const inject = ['references']

/** Upper bound on distinct references in one message, whatever the config says. */
export const MAX_REFERENCES = 3

/** Deployment settings for mention expansion. */
export interface Config {
  /**
   * Distinct `dsh-ref:` references honored in one message. Capped at
   * {@link MAX_REFERENCES}: past a few sources the background stops being
   * background, and the byte budget multiplies by the same factor.
   */
  maxReferences?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  maxReferences: z.number().step(1).min(1).max(MAX_REFERENCES).default(MAX_REFERENCES),
})

/** One message with its mentions made readable, and what they named. */
interface ParsedMessage {
  readonly message: UserMessage
  readonly references: readonly ReferenceInput[]
}

/**
 * Register the pre-step mention expander.
 * @param ctx - the mounting context.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxReferences = Math.min(config.maxReferences ?? MAX_REFERENCES, MAX_REFERENCES)

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    // The overwhelmingly common case is a prompt with no mentions at all, and
    // this runs on every step of every turn. Screening with substring scans
    // before any parsing keeps that case free.
    const target = decision.messages.findIndex(candidate =>
      candidate.source.kind === 'user' && messageText(candidate).some(mayContainReference))
    if (target < 0) return decision

    const original = decision.messages[target]
    if (original === undefined) return decision

    let parsed: ParsedMessage
    try {
      parsed = parseMessage(original)
    } catch (error: unknown) {
      // A malformed URI inside an explicit mention is the user asking for
      // something that does not exist. Saying so beats sending a prompt whose
      // reference silently resolves to nothing.
      return entered(decision, target, [notice(describe(error))], original)
    }

    if (parsed.references.length === 0) return decision

    let contexts: UserMessage[]
    try {
      contexts = await resolve(
        ctx,
        agent,
        parsed,
        maxReferences,
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

/**
 * Authorize and render the named references without reading their bodies.
 * The agent decides whether the current request warrants `reference_read`.
 */
async function resolve(
  ctx: Context,
  agent: Agent,
  parsed: ParsedMessage,
  maxReferences: number,
  signal: AbortSignal,
): Promise<UserMessage[]> {
  const contexts: UserMessage[] = []

  if (parsed.references.length > 0) {
    const inputs = dedupe(parsed.references)
    if (inputs.length > maxReferences) {
      throw new ReferenceAnythingError(
        `a message may reference at most ${maxReferences} outside conversation`
        + `${maxReferences === 1 ? '' : 's'}; this one named ${inputs.length}`,
        'REFERENCE_TOO_MANY',
      )
    }
    for (const input of inputs) ctx.references.grant(String(agent.session.id), input.ref)
    const rendered = renderDeferredReferences(inputs)
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

/** Rewrite external-conversation mentions to readable text, preserving message identity. */
function parseMessage(message: UserMessage): ParsedMessage {
  const references: ReferenceInput[] = []
  let changed = false
  const content: ContentBlock[] = message.content.map((block) => {
    if (block.type !== 'text') return block
    const own = parseReferenceText(block.text)
    references.push(...own.references)
    const text = own.text
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  // freezeMessage keeps the existing identity: the loop claimed this message
  // by id, so minting a new one would log something the inbox never claimed.
  return {
    message: changed ? freezeMessage({ ...message, content }) : message,
    references,
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

function messageText(message: UserMessage): string[] {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
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
