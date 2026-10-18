import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as bootstrap from '../src/chat-import-runtime.ts'
import { chatImportCompatibility, ensureChatImport } from '../src/chat-import-compatibility.ts'
import { resolveLocalPlugins } from '../src/local-plugins.ts'
vi.mock('../src/local-plugins.ts', () => ({ resolveLocalPlugins: vi.fn(async () => []) }))
let ctx: Context
let directory: string
const installBundle = vi.fn()
beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(resolveLocalPlugins).mockResolvedValue([])
  installBundle.mockResolvedValue({ application: 'restart-required' })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'dsh-chat-import', version: '0.26.1' })))
  directory = await mkdtemp(join(tmpdir(), 'reference-import-runtime-'))
  ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(directory).href + '/' })
  ctx.provide('pluginManager', { installBundle } as never)
})
afterEach(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals() })
it('does not install Chat Import when the reference plugin starts', async () => {
  await ctx.plugin(bootstrap)
  await ctx.loader.await()
  expect(installBundle).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})
it.each([true, false])('does not reinstall existing providers (selected=%s)', async selected => {
  await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: { 'dsh-chat-import': '0.25.2' }, dsh: { profile: { bundles: selected ? ['dsh-chat-import'] : [] } } }))
  await ensureChatImport(ctx)
  expect(installBundle).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})
it('reuses a live provider without a profile declaration', async () => {
  ctx.provide('chatImport', { scanDiscover() {}, importPath() {}, resumeSummary() {} } as never)
  await ensureChatImport(ctx)
  expect(installBundle).not.toHaveBeenCalled()
  expect(await chatImportCompatibility(ctx)).toMatchObject({ state: 'ready' })
})
it('reports a failed automatic install and allows explicit retry', async () => {
  installBundle.mockResolvedValueOnce({ application: 'failed', error: { diagnostic: 'network failed' } })
  await expect(ensureChatImport(ctx)).rejects.toThrow('network failed')
  expect(await chatImportCompatibility(ctx)).toMatchObject({ canUpgrade: true, error: 'network failed' })
  await ensureChatImport(ctx, true)
  expect(installBundle).toHaveBeenCalledTimes(2)
})
it('does not mistake activation failure for successful installation', async () => {
  installBundle.mockResolvedValueOnce({ application: 'overridden' })
  await expect(ensureChatImport(ctx)).rejects.toThrow('overridden')
  expect(await chatImportCompatibility(ctx)).not.toMatchObject({ state: 'restart-required' })
})
it('deduplicates startup and a simultaneous manual install', async () => {
  await Promise.all([ensureChatImport(ctx), ensureChatImport(ctx, true)])
  expect(installBundle).toHaveBeenCalledTimes(1)
})
it('does not claim success when the official service is unavailable', async () => {
  const isolated = new Context()
  try {
    await expect(ensureChatImport(isolated)).rejects.toThrow('Plugin Manager is unavailable')
    expect(await chatImportCompatibility(isolated)).toMatchObject({ state: 'unavailable', canUpgrade: false })
    expect(installBundle).not.toHaveBeenCalled()
  } finally { await isolated.fiber.dispose() }
})
it('uses the actual API state after live activation rather than requiring a restart', async () => {
  installBundle.mockImplementationOnce(async () => {
    ctx.provide('chatImport', { scanDiscover() {}, importPath() {}, resumeSummary() {} } as never)
    return { application: 'applied' }
  })
  await ensureChatImport(ctx)
  expect(await chatImportCompatibility(ctx)).toMatchObject({ state: 'ready', canUpgrade: false })
})
it('does not override an installation disabled during the registry lookup', async () => {
  vi.mocked(fetch).mockImplementationOnce(async () => {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: { 'dsh-chat-import': '0.25.2' }, dsh: { profile: { bundles: [] } } }))
    return Response.json({ name: 'dsh-chat-import', version: '0.26.1' })
  })
  await ensureChatImport(ctx)
  expect(installBundle).not.toHaveBeenCalled()
})
