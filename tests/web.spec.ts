import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ReferenceAnythingRemote } from '../src/host.ts'
import * as web from '../src/web.ts'

describe('external conversation Remote availability', () => {
  it('starts and searches conversations when the optional cloud-drive source is absent', async () => {
    const ctx = new Context()
    const search = vi.fn(() => [])
    ctx.provide('typert', { register: vi.fn(() => () => undefined) })
    ctx.provide('referenceChatHistory', { search })
    ctx.provide('openListManager', {})
    const fiber = await ctx.plugin(web)
    try {
      const remote = ctx.get('referenceAnything') as ReferenceAnythingRemote | undefined
      expect(remote).toBeDefined()
      const signal = new AbortController().signal
      expect(remote!.search({ query: 'cache', limit: 10 }, signal)).toEqual([])
      expect(search).toHaveBeenCalledWith('cache', undefined, 10, signal)
      await expect(remote!.driveSearch({ query: '', limit: 10 }, signal)).resolves.toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps cloud-drive lookup available without making it a startup dependency', async () => {
    const ctx = new Context()
    ctx.provide('typert', { register: vi.fn(() => () => undefined) })
    ctx.provide('referenceChatHistory', { search: () => [] })
    ctx.provide('openListManager', {})
    const pickerList = vi.fn(async () => [{ ref: { source: 'cloud-drive', id: 'drive-1' }, label: 'notes.md', provider: 'OpenList' }])
    const disposeDrive = ctx.provide('referenceCloudDrive', { pickerList })
    const fiber = await ctx.plugin(web)
    try {
      const remote = ctx.get('referenceAnything') as ReferenceAnythingRemote
      const signal = new AbortController().signal
      await expect(remote.driveSearch({ query: 'notes', limit: 10 }, signal))
        .resolves.toEqual([{ id: 'drive-1', label: 'notes.md', provider: 'OpenList' }])
      expect(pickerList).toHaveBeenCalledWith('notes', 10, signal)
      disposeDrive()
      expect(ctx.get('referenceAnything')).toBeDefined()
      expect(remote.search({ query: '', limit: 10 }, signal)).toEqual([])
      await expect(remote.driveSearch({ query: '', limit: 10 }, signal)).resolves.toEqual([])
    } finally {
      await fiber.dispose()
    }
  })
})
