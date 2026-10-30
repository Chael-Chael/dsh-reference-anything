import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chatImportCompatibility, missingChatImportApis, upgradeChatImport } from '../src/chat-import-compatibility.ts'
const installBundle = vi.fn()
import { resolveLocalPlugins } from '../src/local-plugins.ts'
import { ReferenceAnythingRemote } from '../src/host.ts'

vi.mock('../src/local-plugins.ts', () => ({ resolveLocalPlugins: vi.fn() }))

let ctx: Context
let directory: string
beforeEach(async () => {
  vi.resetAllMocks()
  directory = await mkdtemp(join(tmpdir(), 'chat-import-compatibility-'))
  ctx = new Context()
  ctx.provide('pluginManager', { installBundle } as never)
  installBundle.mockResolvedValue({ application: 'restart-required' })
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(directory).href + '/' })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: { 'dsh-chat-import': '0.25.2' }, dsh: { profile: { bundles: ['dsh-chat-import'] } } }))
  vi.mocked(resolveLocalPlugins).mockResolvedValue([{ id: 'import', name: 'dsh-chat-import', label: 'Chat Import', version: '0.25.2', status: 'live' }])
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'dsh-chat-import', version: '0.26.3' })))
})
afterEach(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals() })

it('checks actual capabilities, including incomplete or absent services', () => {
  expect(missingChatImportApis(undefined)).toEqual(['scanDiscover', 'importPath', 'resumeSummary'])
  expect(missingChatImportApis({ scanDiscover() {}, importPath() {}, resumeSummary: true })).toEqual(['resumeSummary'])
  expect(missingChatImportApis({ scanDiscover() {}, importPath() {}, resumeSummary() {} })).toEqual([])
})
it('reports an old independently loaded plugin and upgrades only its owning profile', async () => {
  expect(await chatImportCompatibility(ctx)).toMatchObject({ state: 'incompatible', version: '0.25.2', canUpgrade: true })
  await upgradeChatImport(ctx)
  expect(installBundle).toHaveBeenCalledWith('dsh-chat-import@0.26.3', { enabled: true })
})
it('never enables a user-disabled bundle or upgrades a bundled-only provider', async () => {
  await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: { 'dsh-chat-import': '0.25.2' }, dsh: { profile: { bundles: [] } } }))
  expect(await chatImportCompatibility(ctx)).toMatchObject({ state: 'disabled', canUpgrade: false })
  await upgradeChatImport(ctx)
  await writeFile(join(directory, 'package.json'), '{}')
  expect(await chatImportCompatibility(ctx)).toMatchObject({ canUpgrade: true })
  expect(installBundle).not.toHaveBeenCalled()
})
it.each(['0.25.2', '0.26.0', '0.26.2'])('rejects registry versions below the minimum: %s', async version => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ name: 'dsh-chat-import', version }))
  await expect(upgradeChatImport(ctx)).rejects.toThrow('0.26.3')
  expect(installBundle).not.toHaveBeenCalled()
})
it('does not downgrade a newer plugin with missing APIs or install an invalid response', async () => {
  vi.mocked(resolveLocalPlugins).mockResolvedValue([{ id: 'import', name: 'dsh-chat-import', label: 'Chat Import', version: '0.27.0', status: 'live' }])
  await expect(upgradeChatImport(ctx)).rejects.toThrow('No newer')
  vi.mocked(fetch).mockResolvedValue(Response.json({ name: 'other-package', version: '0.99.0' }))
  await expect(upgradeChatImport(ctx)).rejects.toThrow('Invalid')
  expect(installBundle).not.toHaveBeenCalled()
})
it('deduplicates upgrade clicks and reports restart only after a successful install', async () => {
  const remote = new ReferenceAnythingRemote(ctx)
  await Promise.all([remote.chatImportUpgradeInstall(new AbortController().signal), remote.chatImportUpgradeInstall(new AbortController().signal)])
  expect(installBundle).toHaveBeenCalledTimes(1)
  expect(await remote.chatImportStatus()).toMatchObject({ state: 'restart-required', canUpgrade: false })
})
it('keeps upgrade retryable after installation failure', async () => {
  vi.mocked(installBundle).mockRejectedValueOnce(new Error('network failed'))
  const remote = new ReferenceAnythingRemote(ctx)
  await expect(remote.chatImportUpgradeInstall(new AbortController().signal)).rejects.toThrow('network failed')
  expect(await remote.chatImportStatus()).toMatchObject({ state: 'incompatible', canUpgrade: true })
  await remote.chatImportUpgradeInstall(new AbortController().signal)
  expect(installBundle).toHaveBeenCalledTimes(2)
})

it('offers an explicit upgrade for an API-ready 0.26.1 provider so omp can be imported', async () => {
  vi.mocked(resolveLocalPlugins).mockResolvedValue([{ id: 'import', name: 'dsh-chat-import', label: 'Chat Import', version: '0.26.1', status: 'live' }])
  ctx.provide('chatImport', { scanDiscover() {}, importPath() {}, resumeSummary() {} } as never)
  expect(await chatImportCompatibility(ctx)).toMatchObject({ state: 'incompatible', canUpgrade: true, missing: [] })
  await upgradeChatImport(ctx)
  expect(installBundle).toHaveBeenCalledWith('dsh-chat-import@0.26.3', { enabled: true })
})
