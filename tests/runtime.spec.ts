import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import { ReferenceAnythingError } from '../src/errors.ts'
import type { ReferenceRef, ReferenceSnapshot, ReferenceSource, ReferenceSummary } from '../src/types.ts'

/** Every read in this suite asks for the same window; the shape is not what is under test. */
const WINDOW = { limit: 10 }

function stubSource(id: string, over: Partial<ReferenceSource> = {}): ReferenceSource {
  return {
    id,
    available: () => Promise.resolve(true),
    list: (query: string, limit: number): Promise<ReferenceSummary[]> => Promise.resolve(
      [{ ref: { source: id, id: `${id}-1` }, label: `${id} one` }]
        .filter(entry => query === '' || entry.label.includes(query))
        .slice(0, limit),
    ),
    read: (ref: ReferenceRef): Promise<ReferenceSnapshot> => Promise.resolve({
      ref,
      label: `${id} one`,
      body: {
        kind: 'conversation',
        items: [{ role: 'user', text: 'hi' }],
        startIndex: 0,
        totalTurns: 1,
        hasOlder: false,
      },
      partial: false,
      capturedAt: 0,
    }),
    ...over,
  }
}

let ctx: Context

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(ReferenceRuntime, {})
})

describe('source registry', () => {
  it('registers and reports sources in registration order', () => {
    ctx.references.registerSource(stubSource('b'))
    ctx.references.registerSource(stubSource('a'))
    expect(ctx.references.sourceIds()).toEqual(['b', 'a'])
  })

  it('refuses a duplicate id rather than shadowing the first', () => {
    ctx.references.registerSource(stubSource('dup'))
    expect(() => ctx.references.registerSource(stubSource('dup')))
      .toThrow(expect.objectContaining({ code: 'SOURCE_DUPLICATE' }))
  })

  it('unregisters through the returned disposer', () => {
    const dispose = ctx.references.registerSource(stubSource('temp'))
    expect(ctx.references.sourceIds()).toContain('temp')
    dispose()
    expect(ctx.references.sourceIds()).not.toContain('temp')
  })

  it('unregisters when the contributing fiber is disposed (HMR safety)', async () => {
    const fiber = await ctx.plugin({
      name: 'stub-provider',
      inject: ['references'],
      apply(inner: Context) {
        inner.effect(() => inner.references.registerSource(stubSource('scoped')), 'stub')
      },
    })
    expect(ctx.references.sourceIds()).toContain('scoped')
    await fiber.dispose()
    expect(ctx.references.sourceIds()).not.toContain('scoped')
  })
})

describe('read', () => {
  it('dispatches on the reference’s own source', async () => {
    ctx.references.registerSource(stubSource('a'))
    ctx.references.registerSource(stubSource('b'))
    const snapshot = await ctx.references.read({ source: 'b', id: 'x' }, WINDOW)
    expect(snapshot.label).toBe('b one')
  })

  it('names an unregistered source instead of returning nothing', async () => {
    await expect(ctx.references.read({ source: 'ghost', id: 'x' }, WINDOW))
      .rejects.toThrow(expect.objectContaining({ code: 'SOURCE_UNKNOWN' }))
  })

  it('reports a registered but unusable source distinctly from a missing one', async () => {
    ctx.references.registerSource(stubSource('off', { available: () => Promise.resolve(false) }))
    await expect(ctx.references.read({ source: 'off', id: 'x' }, WINDOW))
      .rejects.toThrow(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }))
  })

  it('wraps a source failure while keeping its cause', async () => {
    const cause = new Error('disk gone')
    ctx.references.registerSource(stubSource('bad', { read: () => Promise.reject(cause) }))
    await expect(ctx.references.read({ source: 'bad', id: 'x' }, WINDOW)).rejects.toMatchObject({
      code: 'REFERENCE_READ_FAILED',
      cause,
    })
  })

  it('passes a package error through unchanged', async () => {
    const own = new ReferenceAnythingError('nope', 'REFERENCE_NOT_FOUND')
    ctx.references.registerSource(stubSource('own', { read: () => Promise.reject(own) }))
    await expect(ctx.references.read({ source: 'own', id: 'x' }, WINDOW)).rejects.toBe(own)
  })

  it('honors an already-aborted signal', async () => {
    ctx.references.registerSource(stubSource('a'))
    await expect(ctx.references.read({ source: 'a', id: 'x' }, WINDOW, AbortSignal.abort()))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_CANCELLED' }))
  })
})

describe('task-local grants', () => {
  const web = { source: 'web-chat', id: 'conversation-1' }
  const NOT_GRANTED = expect.objectContaining({ code: 'CONVERSATION_REFERENCE_NOT_GRANTED' })

  beforeEach(() => {
    ctx.references.registerSource(stubSource('web-chat', { requiresGrant: true }))
    ctx.references.registerSource(stubSource('file', { requiresGrant: false }))
  })

  it('allows only the task that mentioned or discovered the conversation', () => {
    ctx.references.grant('task-a', web)
    expect(() => ctx.references.assertGranted('task-a', web)).not.toThrow()
    expect(() => ctx.references.assertGranted('task-b', web)).toThrow(NOT_GRANTED)
  })

  it('revokes all grants for a completed task', () => {
    ctx.references.grant('task-a', web)
    ctx.references.revoke('task-a')
    expect(() => ctx.references.assertGranted('task-a', web)).toThrow(NOT_GRANTED)
  })

  it('does not impose authorization on a source that opted out', () => {
    expect(() => ctx.references.assertGranted(undefined, { source: 'file', id: 'chat.json' })).not.toThrow()
  })

  it('gates every source that opts in, not only web-chat', () => {
    ctx.references.registerSource(stubSource('local-agent', { requiresGrant: true }))
    const transcript = { source: 'local-agent', id: 'rollout-1' }
    expect(() => ctx.references.assertGranted('task-a', transcript)).toThrow(NOT_GRANTED)
    ctx.references.grant('task-a', transcript)
    expect(() => ctx.references.assertGranted('task-a', transcript)).not.toThrow()
  })

  it('does not let one source’s grant authorize the same id under another', () => {
    ctx.references.registerSource(stubSource('local-agent', { requiresGrant: true }))
    ctx.references.grant('task-a', { source: 'web-chat', id: 'shared-id' })
    expect(() => ctx.references.assertGranted('task-a', { source: 'local-agent', id: 'shared-id' }))
      .toThrow(NOT_GRANTED)
  })

  it('fails closed for an unregistered source rather than trusting it', () => {
    expect(() => ctx.references.assertGranted('task-a', { source: 'ghost', id: 'x' })).toThrow(NOT_GRANTED)
  })
})

describe('list', () => {
  it('returns nothing when no source is registered', async () => {
    await expect(ctx.references.list()).resolves.toEqual([])
  })

  it('skips unavailable sources', async () => {
    ctx.references.registerSource(stubSource('on'))
    ctx.references.registerSource(stubSource('off', { available: () => Promise.resolve(false) }))
    const found = await ctx.references.list()
    expect(found.map(entry => entry.ref.source)).toEqual(['on'])
  })

  it('treats a source whose availability check throws as unavailable', async () => {
    ctx.references.registerSource(stubSource('boom', { available: () => Promise.reject(new Error('x')) }))
    await expect(ctx.references.list()).resolves.toEqual([])
  })

  it('keeps working when one source fails but another succeeds', async () => {
    ctx.references.registerSource(stubSource('ok'))
    ctx.references.registerSource(stubSource('bad', { list: () => Promise.reject(new Error('down')) }))
    const found = await ctx.references.list()
    expect(found.map(entry => entry.ref.source)).toEqual(['ok'])
  })

  it('fails loudly when every available source fails, rather than reporting "none"', async () => {
    ctx.references.registerSource(stubSource('bad1', { list: () => Promise.reject(new Error('down')) }))
    ctx.references.registerSource(stubSource('bad2', { list: () => Promise.reject(new Error('down')) }))
    await expect(ctx.references.list())
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }))
  })

  it('caps the combined result at the requested limit', async () => {
    ctx.references.registerSource(stubSource('a'))
    ctx.references.registerSource(stubSource('b'))
    await expect(ctx.references.list('', 1)).resolves.toHaveLength(1)
  })

  it('applies the configured limit when the caller names none', async () => {
    const scoped = new Context()
    await scoped.plugin(ReferenceRuntime, { listLimit: 1 })
    scoped.references.registerSource(stubSource('a'))
    scoped.references.registerSource(stubSource('b'))
    await expect(scoped.references.list()).resolves.toHaveLength(1)
  })
})
