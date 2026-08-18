import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { beforeEach, describe, expect, it } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import * as mention from '../src/reference.ts'
import { encodeReferenceUri, formatReferenceMention } from '../src/uri.ts'
import type { ReferenceRef, ReferenceSnapshot, ReferenceSource } from '../src/types.ts'

const agent = { id: 'agent-1', session: { header: { id: 'session-1' } } } as unknown as Agent

function source(over: Partial<ReferenceSource> = {}): ReferenceSource {
  return {
    id: 'file',
    available: () => Promise.resolve(true),
    list: () => Promise.resolve([]),
    read: (ref: ReferenceRef): Promise<ReferenceSnapshot> => Promise.resolve({
      ref,
      label: 'Cache design',
      body: {
        kind: 'conversation',
        items: [
          { role: 'user', text: 'how should we key the cache?' },
          { role: 'assistant', text: 'by request hash' },
        ],
        startIndex: 0,
        totalTurns: 2,
        hasOlder: false,
      },
      partial: false,
      capturedAt: Date.UTC(2026, 7, 16),
    }),
    ...over,
  }
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function mount(over: Partial<ReferenceSource> = {}, config: mention.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ReferenceRuntime, {})
  ctx.references.registerSource(source(over))
  await ctx.plugin(mention, config)
  return ctx
}

function step(ctx: Context, messages: UserMessage[], over: { signal?: AbortSignal; decision?: PreStepDecision } = {}) {
  const signal = over.signal ?? new AbortController().signal
  const decision: PreStepDecision = over.decision ?? { kind: 'enter', messages }
  return ctx.waterfall(
    'agent/pre-step',
    { agent, messages, turn: 1, step: 1, signal },
    () => Promise.resolve(decision),
  )
}

const ref = { source: 'file', id: 'chat.json' }
let ctx: Context

beforeEach(async () => {
  ctx = await mount()
})

describe('the common path costs nothing', () => {
  it('returns the very same decision when no message mentions anything', async () => {
    const messages = [userMessage('just do the thing')]
    const decision: PreStepDecision = { kind: 'enter', messages }
    await expect(step(ctx, messages, { decision })).resolves.toBe(decision)
  })

  it('leaves a rejected step rejected and injects nothing', async () => {
    const messages = [userMessage(`see ${encodeReferenceUri(ref)}`)]
    await expect(step(ctx, messages, { decision: { kind: 'reject' } })).resolves.toEqual({ kind: 'reject' })
  })

  it('does nothing once the turn is cancelled', async () => {
    const messages = [userMessage(`see ${encodeReferenceUri(ref)}`)]
    const decision: PreStepDecision = { kind: 'enter', messages }
    await expect(step(ctx, messages, { signal: AbortSignal.abort(), decision })).resolves.toBe(decision)
  })
})

describe('expansion', () => {
  it('puts the background immediately before the prompt that named it', async () => {
    const messages = [userMessage(`what did we decide in ${formatReferenceMention(ref, 'Cache design')}?`)]
    const result = await step(ctx, messages)
    expect(result.kind).toBe('enter')
    const entered = (result as Extract<PreStepDecision, { kind: 'enter' }>).messages
    expect(entered).toHaveLength(2)
    expect(entered[0]?.source.kind).toBe('reference-anything')
    expect(entered[1]?.source.kind).toBe('user')
  })

  it('carries an untrusted deferred reference into the context without its body', async () => {
    const result = await step(ctx, [userMessage(`see ${formatReferenceMention(ref, 'Cache design')}`)])
    const context = (result as Extract<PreStepDecision, { kind: 'enter' }>).messages[0]
    const text = context?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(text).toContain('untrusted reference to a conversation')
    expect(text).toContain('bodies were not fetched')
    expect(text).toContain(encodeReferenceUri(ref))
    expect(text).not.toContain('by request hash')
  })

  it('replaces the opaque URI with a readable label and keeps the message identity', async () => {
    const prompt = userMessage(`what did we decide in ${formatReferenceMention(ref, 'Cache design')}?`)
    const result = await step(ctx, [prompt])
    const rewritten = (result as Extract<PreStepDecision, { kind: 'enter' }>).messages[1]
    const text = rewritten?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(text).toBe('what did we decide in @Cache design?')
    expect(text).not.toContain('dsh-ref:')
    // The loop claimed this message by id; a fresh id would log something the
    // inbox never claimed.
    expect(rewritten?.id).toBe(prompt.id)
  })

  it('records provenance the recall card can read', async () => {
    const result = await step(ctx, [userMessage(`see ${formatReferenceMention(ref, 'Cache design')}`)])
    const context = (result as Extract<PreStepDecision, { kind: 'enter' }>).messages[0]
    expect(context?.source).toMatchObject({
      kind: 'reference-anything',
      form: 'recall',
      version: 1,
      references: [expect.objectContaining({
        label: 'Cache design',
        retainedMessages: 0,
        omittedMessages: 0,
        truncated: true,
      })],
    })
  })

  it('does not read a snapshot when a reference is mentioned', async () => {
    const reads: string[] = []
    const scoped = await mount({
      read: (target: ReferenceRef) => {
        reads.push(target.id)
        return source().read(target, { limit: 10 })
      },
    })
    const uri = formatReferenceMention(ref, 'Cache design')
    await step(scoped, [userMessage(`${uri} and again ${uri}`)])
    expect(reads).toEqual([])
  })
})

describe('deferred references', () => {
  it('does not probe a source while making a reference available to the agent', async () => {
    const scoped = await mount({ read: () => Promise.reject(new Error('browser is closed')) })
    const result = await step(scoped, [userMessage(`see ${formatReferenceMention(ref, 'Cache design')}`)])
    const entered = (result as Extract<PreStepDecision, { kind: 'enter' }>).messages
    expect(entered[0]?.source).toMatchObject({ kind: 'reference-anything', form: 'recall' })
    const text = entered[0]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(text).toContain('bodies were not fetched')
    expect(text).toContain('"preview": null')
    // The uri survives, so the model can retry once the browser is back.
    expect(text).toContain(encodeReferenceUri(ref))
    const prompt = entered[1]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(prompt).toBe('see @Cache design')
  })

  it('refuses a malformed mention rather than passing the raw URI to the model', async () => {
    const result = await step(ctx, [userMessage('see @[broken](dsh-ref:!!!)')])
    const entered = (result as Extract<PreStepDecision, { kind: 'enter' }>).messages
    expect(entered[0]?.source).toMatchObject({ kind: 'plugin', form: 'notice' })
  })

  it('refuses more references than the configured limit', async () => {
    const scoped = await mount({}, { maxReferences: 1 })
    const text = [
      formatReferenceMention({ source: 'file', id: 'a.json' }, 'A'),
      formatReferenceMention({ source: 'file', id: 'b.json' }, 'B'),
    ].join(' and ')
    const result = await step(scoped, [userMessage(text)])
    const entered = (result as Extract<PreStepDecision, { kind: 'enter' }>).messages
    expect(entered[0]?.source).toMatchObject({ kind: 'plugin', form: 'notice' })
    expect(entered[0]?.content.flatMap(b => b.type === 'text' ? [b.text] : []).join(''))
      .toContain('at most 1')
  })
})

describe('only the user can make a reference', () => {
  it('ignores a URI that arrives inside injected context, not a user prompt', async () => {
    const planted = createUserMessage({
      content: [{ type: 'text', text: `read ${encodeReferenceUri(ref)}` }],
      source: { kind: 'plugin', plugin: 'somebody-else' },
    })
    const messages = [planted]
    const decision: PreStepDecision = { kind: 'enter', messages }
    // Unchanged: external text cannot forge the gesture, so a tool result or
    // another plugin's context cannot pull material into the request.
    await expect(step(ctx, messages, { decision })).resolves.toBe(decision)
  })
})

describe('session references', () => {
  it('refuses a dsh-session: mention when the resolver is not mounted, rather than dropping it', async () => {
    const result = await step(ctx, [userMessage('see dsh-session:InMxIg')])
    const entered = (result as Extract<PreStepDecision, { kind: 'enter' }>).messages
    expect(entered[0]?.source).toMatchObject({ kind: 'plugin', form: 'notice' })
    expect(entered[0]?.content.flatMap(b => b.type === 'text' ? [b.text] : []).join(''))
      .toContain('cross-session resolver is not mounted')
  })

  it('ignores the session scheme entirely when it is turned off', async () => {
    const scoped = await mount({}, { serveSessionScheme: false })
    const messages = [userMessage('see dsh-session:InMxIg')]
    const decision: PreStepDecision = { kind: 'enter', messages }
    await expect(step(scoped, messages, { decision })).resolves.toBe(decision)
  })
})
