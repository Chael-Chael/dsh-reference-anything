import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as bootstrap from '../src/chat-import-runtime.ts'

const state = vi.hoisted(() => ({ starts: 0, active: 0, peak: 0 }))
vi.mock('dsh-chat-import', () => ({
  name: 'import-claude',
  inject: [],
  Config: undefined,
  default: undefined,
  apply(ctx: Context) {
    state.starts++
    state.active++
    state.peak = Math.max(state.peak, state.active)
    ctx.provide('chatImport', { scanDiscover: async () => ({ sessions: [] }) })
    ctx.effect(() => async () => { await new Promise(resolve => setTimeout(resolve, 10)); state.active-- })
  },
}))
let ctx: Context
let directory: string
beforeEach(async () => {
  state.starts = state.active = state.peak = 0
  directory = await mkdtemp(join(tmpdir(), 'reference-import-runtime-'))
  ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(directory).href + '/' })
})
afterEach(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

it('loads one fallback and releases it with its owner', async () => {
  const owner = await ctx.plugin(bootstrap)
  await vi.waitFor(() => expect(state.starts).toBe(1))
  await ctx.plugin(bootstrap)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(state.starts).toBe(1)
  await owner.dispose()
  expect(state.active).toBe(0)
  expect(ctx.get('chatImport')).toBeUndefined()
})

it.each([true, false])('does not override an independent configured provider (disabled=%s)', async disabled => {
  const upstream = await import('dsh-chat-import')
  vi.spyOn(ctx.loader, 'import').mockResolvedValue({ ...upstream, inject: ['notReady'] })
  await ctx.loader.root.update([{ id: 'custom-id', name: 'dsh-chat-import', disabled }])
  await ctx.plugin(bootstrap)
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(state.starts).toBe(0)
})

it.each([true, false])('reuses a slow independent provider in either bundle order (bootstrap first=%s)', async first => {
  const upstream = await import('dsh-chat-import')
  vi.spyOn(ctx.loader, 'import').mockImplementation(async name => {
    if (name === 'bootstrap') return bootstrap
    await new Promise(resolve => setTimeout(resolve, 20))
    return upstream
  })
  const rows = [{ id: 'bootstrap', name: 'bootstrap' }, { id: 'external', name: 'dsh-chat-import' }]
  await ctx.loader.root.update(first ? rows : rows.reverse())
  await ctx.loader.await()
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(state.starts).toBe(1)
  expect(state.peak).toBe(1)
})

it('respects a deselected independently installed bundle', async () => {
  await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: { 'dsh-chat-import': '^0.26.0' } }))
  // A package missing from disk must not be silently replaced either.
  await ctx.plugin(bootstrap)
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(state.starts).toBe(0)
})

it('hands off to a later independent module copy without overlapping registrations', async () => {
  const owner = await ctx.plugin(bootstrap)
  await vi.waitFor(() => expect(state.starts).toBe(1))
  const upstream = await import('dsh-chat-import')
  const independent = { name: upstream.name, apply: (ctx: Context) => upstream.apply(ctx as never) }
  const next = ctx.plugin(independent)
  await next
  await vi.waitFor(() => expect(state.starts).toBe(2))
  expect(state.active).toBe(1)
  expect(state.peak).toBe(1)
  await owner.dispose()
  expect(state.active).toBe(1)
})
