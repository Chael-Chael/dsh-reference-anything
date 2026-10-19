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
import { renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { loadLocalReference, buildLocalPreview, renderLocalData, localBytes, localError, shortLabel, assertLocalScope, DEFAULT_LOCAL_BYTES, LOCAL_INSTRUCTIONS, type LocalPreview, type LocalDocument } from './local-reference.ts'
import { localLocatorFromId, type LocalLocator } from './local-locator.ts'
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
  /** Upper bound for all local previews in one pre-step batch; remaining context may lower it. */
  maxTextBytes?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  maxTextBytes: z.number().step(1).min(1),
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
  ctx.inject(['systemPrompt'], ctx => { ctx.effect(() => ctx.systemPrompt.section({ name: 'reference-anything:local', order: 110, text: LOCAL_INSTRUCTIONS })) })
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
      return Math.min(config.maxTextBytes ?? DEFAULT_LOCAL_BYTES, minimalBytes + remaining)
    } catch { signal.throwIfAborted(); ctx.logger.warn('Local reference context capacity unavailable; using metadata-only previews.'); return 0 }
  }
  const maxReferences = Math.min(config.maxReferences ?? MAX_REFERENCES, MAX_REFERENCES)

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    type Entry = LocalPreview | { ref: LocalLocator; title: string; notice?: string; error?: { code: string; message: string } }
    const plans: Array<{ index: number; parsed: ParsedMessage; inputs: ReferenceInput[]; entries: Entry[]; external?: ReturnType<typeof renderDeferredReferences>; error?: string }> = []
    for (const [index, original] of decision.messages.entries()) {
      if (original.source.kind !== 'user' || !messageText(original).some(mayContainReference)) continue
      try {
        const parsed = parseMessage(original), inputs = dedupe(parsed.references)
        if (!inputs.length) continue
        if (inputs.length > maxReferences) throw localError('INVALID_ARGUMENT', `at most ${maxReferences} references are allowed per message.`)
        const local = inputs.filter(input => input.ref.source === 'local-agent')
        const external = inputs.filter(input => input.ref.source !== 'local-agent')
        for (const input of external) ctx.references.grant(String(agent.session.id), input.ref)
        const entries: Entry[] = local.map(input => ({ ref: localLocatorFromId(input.ref.id), title: shortLabel(input.label ?? localLocatorFromId(input.ref.id).sessionId),
          notice: 'Preview not loaded: insufficient or unknown context budget. Use reference_read with part="messages" and omit from and revision.' }))
        plans.push({ index, parsed, inputs: local, entries, ...(external.length ? { external: renderDeferredReferences(external) } : {}) })
      } catch (error) {
        plans.push({index,parsed:{message:original,references:[]},inputs:[],entries:[],error:describe(error).slice(0,256)})
      }
    }
    if (!plans.length) return decision
    const contextFor = (plan: typeof plans[number]): UserMessage => {
      if (plan.error) return notice(plan.error)
      const parts = [...(plan.entries.length ? [renderLocalData(plan.entries)] : []), ...(plan.external ? [plan.external.text] : []), ...(plan.error ? [plan.error] : [])]
      const references = plan.entries.map((entry, index) => ({ source: 'local-agent', id: plan.inputs[index]!.ref.id, locator: entry.ref,
        label: entry.title, capturedAt: Date.now(), ...('items' in entry ? { revision: entry.revision, startIndex: entry.items[0]?.messageId ?? 0,
          retainedMessages: entry.items.length, truncated: entry.next !== null || (entry.items[0]?.messageId ?? 1)>1 } : {}) }))
      return createUserMessage({content:[{type:'text',text:parts.join('\n')}],source:{kind:'reference-anything',form:'recall',version:1,
        references:[...references,...(plan.external?.provenance ?? [])]} as never})
    }
    const size = () => plans.reduce((sum,plan) => sum + Buffer.byteLength(messageText(contextFor(plan)).join('\n')),0)
    const cap = config.maxTextBytes ?? DEFAULT_LOCAL_BYTES
    if (size() > cap) throw localError('BUDGET_TOO_SMALL','Reference metadata exceeds the shared preview budget; use fewer references.')
    const pending = decision.messages.map((message,index)=>plans.find(plan=>plan.index===index)?.parsed.message??message)
    const capacity = await budget(agent,signal,pending,plans.map(contextFor))
    let remaining = Math.max(0,capacity-size())
    let left = plans.reduce((sum,plan)=>sum+plan.entries.length,0)
    const captures = new Map<string,Promise<LocalDocument>>()
    for(const plan of plans) for(let i=0;i<plan.entries.length;i++){
      const entry=plan.entries[i]!,share=Math.floor(remaining/left--),before=size()
      try {
        await assertLocalScope(ctx,entry.ref,deadline)
        if(share>0){
          const key=JSON.stringify(entry.ref)
          let capture=captures.get(key)
          if(!capture){capture=loadLocalReference(ctx,agent,entry.ref,undefined,deadline);captures.set(key,capture)}
          const document=await capture
          const preview=buildLocalPreview(entry.ref,document,before+share,entry.title,value=>{
            plan.entries[i]=value;const bytes=size();plan.entries[i]=entry;return bytes
          })
          plan.entries[i]=preview
        }
      } catch(error) {
        signal.throwIfAborted()
        if(error instanceof ReferenceAnythingError && error.code==='BUDGET_TOO_SMALL') plan.entries[i]=entry
        else plan.entries[i]={ref:entry.ref,title:entry.title,error:{code:deadline.aborted?'TIMEOUT':error instanceof ReferenceAnythingError?error.code:'READ_FAILED',
          message:deadline.aborted?'Reference preparation timed out.':error instanceof ReferenceAnythingError?error.message:'Reference source is unavailable.'}}
      }
      remaining=Math.max(0,remaining-(size()-before))
    }
    // Recheck permissions immediately before publishing all prepared contexts.
    for(const plan of plans)for(let i=0;i<plan.entries.length;i++){
      const entry=plan.entries[i]!
      if('error' in entry && entry.error)continue
      try {await assertLocalScope(ctx,entry.ref,deadline)} catch(error){signal.throwIfAborted();plan.entries[i]={ref:entry.ref,title:entry.title,error:{code:deadline.aborted?'TIMEOUT':error instanceof ReferenceAnythingError?error.code:'READ_FAILED',message:'Reference access is no longer available.'}}}
    }
    signal.throwIfAborted()
    if(size()>cap || (capacity>0&&size()>capacity))throw localError('BUDGET_TOO_SMALL','Reference contexts exceed the shared budget.')
    return {...decision,messages:decision.messages.flatMap((message,index)=>{
      const plan=plans.find(plan=>plan.index===index)
      return plan?[plan.parsed.message,contextFor(plan)]:[message]
    })}
  }, { prepend: true })
}

/** Conservative fallback for unknown tokenization, including message and JSON framing. */
function conservativeTokens(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') + 16
}

/** Rewrite external-conversation mentions to readable text, preserving message identity. */
function parseMessage(message: UserMessage): ParsedMessage {
  const references: ReferenceInput[] = []
  let changed = false
  const content: ContentBlock[] = message.content.map((block) => {
    if (block.type !== 'text') return block
    const chunks = block.text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/gu)
    const parsed = chunks.map((text, index) => index % 2 ? { text, references: [] } : parseReferenceText(text))
    const own = { text: parsed.map(part => part.text).join(''), references: parsed.flatMap(part => part.references) }
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
