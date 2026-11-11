import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReferenceRuntime from '../src/index.ts'

// A stand-in manager: the real one reads saved credentials and may start a
// managed OpenList process, which a unit test must never do.
const lifecycle = vi.hoisted(() => ({ started: 0, stopped: 0 }))
vi.mock('../src/openlist/index.ts', async () => {
  const { Service: Base } = await import('@deepseek-ai/cordis')
  class OpenListService extends Base {
    static inject: string[] = []
    constructor(ctx: Context) {
      super(ctx, 'openListManager')
      lifecycle.started++
      ctx.effect(() => () => { lifecycle.stopped++ }, 'fake-openlist.stop')
    }
    credentialGeneration() { return 0 }
    async credentials() { return undefined }
  }
  return { OpenListService }
})

const cloudDrive = await import('../src/sources/cloud-drive/index.ts')

afterEach(() => { lifecycle.started = 0; lifecycle.stopped = 0 })

describe('OpenList belongs to the cloud-drive plugin', () => {
  it('starts with the drive source and stops when the drive is switched off', async () => {
    const ctx = new Context()
    await ctx.plugin(ReferenceRuntime, {})
    const fiber = await ctx.plugin(cloudDrive, {})
    await vi.waitFor(() => expect(ctx.references.sourceIds()).toContain('cloud-drive'))
    expect(lifecycle.started).toBe(1)
    expect(ctx.get('openListManager')).toBeDefined()
    await fiber.dispose()
    expect(lifecycle.stopped).toBe(1)
    expect(ctx.get('openListManager')).toBeUndefined()
    expect(ctx.references.sourceIds()).not.toContain('cloud-drive')
  })

  it('keeps a manager the host already provides', async () => {
    const ctx = new Context()
    await ctx.plugin(ReferenceRuntime, {})
    ctx.provide('openListManager', { credentialGeneration: () => 0, credentials: async () => undefined } as never)
    const fiber = await ctx.plugin(cloudDrive, {})
    await vi.waitFor(() => expect(ctx.references.sourceIds()).toContain('cloud-drive'))
    expect(lifecycle.started).toBe(0)
    await fiber.dispose()
  })
})
