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
 * This plugin owns external references and readable local Agent locators
 * resolved through `ctx.references`. Native file and DSH-session
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
import { stringifyTagSafeJson } from './serialize.ts'
import { renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { loadLocalReference, renderLocalPreview, LOCAL_NOTICE } from './local-reference.ts'
import { localLocatorFromId, LOCAL_REFERENCE_OPEN, LOCAL_REFERENCE_CLOSE } from './local-locator.ts'
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
   * background. Local previews share one send-time byte budget.
   */
  maxReferences?: number
  /** Upper bound for all local previews in one message; remaining context may lower it. */
  maxReferenceBytes?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  maxReferenceBytes: z.number().step(1).min(1),
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
  const assemblies = new WeakMap<Agent, PromptAssembly>()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.agent) assemblies.set(context.agent, assembly)
    return assembly
  }, { prepend: true })
  const budget = async (agent: Agent, signal: AbortSignal, pending: UserMessage[], minimal: UserMessage[]) => {
    const assembly = assemblies.get(agent)
    const provider = assembly?.variables.provider ?? agent.options?.provider
    const model = assembly?.variables.model ?? agent.options?.model
    const llm = ctx.get('llm')
    if (!provider || !model || !llm) return 0
    try {
      const info = await llm.resolveModelInfo(provider, model, signal)
      const window = info.context?.contextWindow
      if (!window || !Number.isFinite(window) || window <= 0) return 0
      const history = agent.session.deriveMessages()
      const header = agent.session.requestHeader()
      // Optional public host service: do not bundle a second meter or require it on older hosts.
      const meter = ctx.get('tokenMeter' as never) as { measure(session: Agent['session']): { totalTokens: number; baseline: { kind: string } } } | undefined
      let used = conservativeTokens(history) + conservativeTokens(header?.tools ?? [])
      try {
        const measured = meter?.measure(agent.session)
        if (measured?.baseline.kind === 'usage' && Number.isFinite(measured.totalTokens) && measured.totalTokens >= 0
          && (!header || (header.config.provider === provider && header.config.model === model))) used = measured.totalTokens
      } catch { signal.throwIfAborted() }
      // The current assembly/pending inbox have not reached the session surface yet.
      if (assembly) {
        const system = renderPrompt(assembly)
        if (system && !history.some(message => message.role === 'system' && message.content.some(block => block.type === 'text' && block.text === system))) used += conservativeTokens(system)
        if (JSON.stringify(assembly.tools) !== JSON.stringify(header?.tools ?? [])) used += conservativeTokens(assembly.tools)
      }
      const sameRoute = header?.config.provider === provider && header.config.model === model
      const configuredOutput = agent.options?.maxTokens ?? (sameRoute ? header.config.maxTokens : undefined) ?? info.defaultMaxTokens
      const output = configuredOutput && Number.isFinite(configuredOutput) && configuredOutput > 0
        ? configuredOutput : Math.min(8192, Math.ceil(window * 0.1))
      const safety = Math.max(1024, Math.ceil(window * 0.05))
      const remaining = Math.max(0, Math.floor(window - used - conservativeTokens(pending) - conservativeTokens(minimal) - output - safety))
      const minimalBytes = minimal.reduce((sum, message) => sum + Buffer.byteLength(messageText(message).join('\n')), 0)
      // Charge one UTF-8 byte per token for new reference text, rather than assuming four characters fit.
      return Math.min(config.maxReferenceBytes ?? Math.max(65_536, Math.floor(window * 4 * 0.2)), minimalBytes + remaining)
    } catch { signal.throwIfAborted(); return 0 }
  }
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
        (minimal, external) => budget(agent, signal, [...decision.messages.with(target, parsed.message), ...external], minimal),
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
 * Authorize references; local Agent bodies are projected before the first model step.
 * Other providers keep their existing deferred reading behavior.
 */
async function resolve(
  ctx: Context,
  agent: Agent,
  parsed: ParsedMessage,
  maxReferences: number,
  signal: AbortSignal,
  budget: (minimal: UserMessage[], external: UserMessage[]) => Promise<number>,
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
    const external = inputs.filter(input => input.ref.source !== 'local-agent')
    const rendered = external.length ? renderDeferredReferences(external) : undefined
    const deferred = rendered ? [createUserMessage({ content: [{ type: 'text', text: rendered.text }], source: {
      kind: 'reference-anything', form: 'recall', version: 1, references: rendered.provenance,
    } satisfies ReferenceContextSource })] : []
    const local = inputs.filter(input => input.ref.source === 'local-agent')
    const minimal = local.map(input => notice(`${LOCAL_NOTICE}\nLocal preview deferred: insufficient or unknown remaining context budget. No body or image content is included. Use reference_read with the locator and omit revision to refresh.\n${LOCAL_REFERENCE_OPEN}${stringifyTagSafeJson({ ...localLocatorFromId(input.ref.id), label: input.label })}${LOCAL_REFERENCE_CLOSE}`))
    const minima = minimal.map(message => Buffer.byteLength(messageText(message).join('\n')))
    let remaining = Math.max(0, (local.length ? await budget(minimal, deferred) : 0) - minima.reduce((sum, bytes) => sum + bytes, 0))
    for (const [index, input] of local.entries()) {
      const locator = localLocatorFromId(input.ref.id)
      const share = minima[index]! + Math.floor(remaining / (local.length - index))
      const fallback = minimal[index]!
      // A locator survives even when no body fits; do not spend a parse on an exhausted budget.
      if (remaining === 0 || share < Math.max(2048, Buffer.byteLength(messageText(fallback).join('\n')))) {
        contexts.push(fallback)
        continue
      }
      try {
        const document = await loadLocalReference(ctx, agent, locator, undefined, signal)
        const text = renderLocalPreview(locator, document, share, input.label)
        const data = JSON.parse(text.slice(text.indexOf(LOCAL_REFERENCE_OPEN) + LOCAL_REFERENCE_OPEN.length, text.indexOf(LOCAL_REFERENCE_CLOSE)))
        contexts.push(createUserMessage({ content: [{ type: 'text', text }], source: {
          kind: 'reference-anything', form: 'recall', version: 1, references: [{
            source: 'local-agent', id: input.ref.id, locator, revision: document.revision, label: input.label,
            capturedAt: Date.now(), startIndex: data.messages[0]?.number ?? 0, totalTurns: document.messages.length,
            retainedMessages: data.messages.length, omittedMessages: document.messages.length - data.messages.length,
            omittedBytes: data.omissions.truncatedMessages.reduce((sum: number, row: { omittedTextBytes: number }) => sum + row.omittedTextBytes, 0),
            truncated: data.messages.length < document.messages.length || data.omissions.truncatedMessages.length > 0,
            hasOlder: data.messages.length < document.messages.length, partial: document.partial, inputIndex: inputs.indexOf(input),
          }],
        } as never }))
        remaining = Math.max(0, remaining - Math.max(0, Buffer.byteLength(text) - minima[index]!))
      } catch (error) {
        signal.throwIfAborted()
        const failure = notice(`${describe(error).slice(0, 256)}\n${LOCAL_REFERENCE_OPEN}${stringifyTagSafeJson(locator)}${LOCAL_REFERENCE_CLOSE}`)
        const context = Buffer.byteLength(messageText(failure).join('\n')) <= share ? failure : fallback
        contexts.push(context)
        remaining = Math.max(0, remaining - Math.max(0, Buffer.byteLength(messageText(context).join('\n')) - minima[index]!))
      }
    }
    contexts.push(...deferred)
  }

  return contexts
}

/** Conservative fallback for unknown tokenization, including message and JSON framing. */
function conservativeTokens(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') + 16
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
      kind: 'reference-anything',
      form: 'notice',
      summary: boundContextSummary(summary),
    } as never,
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
