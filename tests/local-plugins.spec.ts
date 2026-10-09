import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { Include, applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ReferenceAnythingRemote } from '../src/host.ts'

describe('local plugin discovery', () => {
  let root: string
  let ctx: Context
  let remote: ReferenceAnythingRemote
  const signal = () => new AbortController().signal

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reference-plugins-'))
    ctx = new Context()
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(root).href + '/' })
    // Imports use small plugins, but composition, effective disables and lifecycle are real Cordis.
    vi.spyOn(ctx.loader, 'import').mockImplementation(async name => name === 'cordis:include' ? Include : ({
      name, inject: name === 'waiting-plugin' ? ['missingService'] : [], apply: () => {},
    }))
    remote = new ReferenceAnythingRemote(ctx)
  })
  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function install(name: string, metadata: Record<string, unknown> = {}, directory = join(root, 'node_modules', name)) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.2.3', ...metadata }))
    return directory
  }

  it('uses composed entries and lifecycle, excludes libraries and includes declared bundles', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { library: '^1', 'installed-plugin': '^1', 'enabled-plugin': '^1' },
      dsh: { profile: { bundles: ['bundle-only'] } },
    }))
    await install('library')
    await install('installed-plugin', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
    await install('bundle-only', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
    await install('enabled-plugin')
    await install('disabled-plugin')
    const entries = applyEntryPatches([], [
      { insert: [{ id: 'first', name: 'enabled-plugin' }] },
      { insert: [{ id: 'second', name: 'disabled-plugin' }, { id: 'waiting', name: 'waiting-plugin' }] },
      { id: 'first', config: { value: 1 } },
      { id: 'second', disabled: true },
      { insert: [{ id: 'duplicate', name: 'enabled-plugin', disabled: true }] },
    ], () => {})
    await ctx.loader.root.update(entries)
    await ctx.loader.await()
    const rows = await remote.localPlugins(signal())
    expect(rows.map(row => [row.name, row.status])).toEqual([
      ['enabled-plugin', 'live'], ['bundle-only', 'inert'], ['installed-plugin', 'inert'],
      ['waiting-plugin', 'inert'], ['disabled-plugin', 'disabled'],
    ])
    expect(rows[0]).toMatchObject({ version: '1.2.3', directory: await realpath(join(root, 'node_modules', 'enabled-plugin')) })
    await ctx.loader.root.update(applyEntryPatches(entries, [{ id: 'second', disabled: false }], () => {}))
    await ctx.loader.await()
    expect((await remote.localPlugins(signal())).find(row => row.name === 'disabled-plugin')?.status).toBe('live')
  })

  it('resolves linked and relative plugin sources outside the profile node_modules', async () => {
    const directory = await install('local-plugin', {}, join(root, 'source with spaces'))
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await symlink(directory, join(root, 'node_modules', 'local-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(directory, 'index.js'), '')
    await ctx.loader.root.update([
      { id: 'linked', name: 'local-plugin' },
      { id: 'relative', name: './source with spaces/index.js', disabled: true },
    ])
    await ctx.loader.await()
    expect(await remote.localPlugins(signal())).toEqual([
      { id: 'linked', name: 'local-plugin', label: 'local-plugin', status: 'live', version: '1.2.3', directory: await realpath(directory) },
    ])
  })

  it('reads nested include entries after multiple patch layers and effective disables', async () => {
    const file = join(root, 'cordis.json')
    const directory = await install('enabled-plugin')
    const entrypoint = join(directory, 'index.mjs')
    await writeFile(entrypoint, 'export function apply() {}')
    await writeFile(file, JSON.stringify([{ id: 'enabled', name: pathToFileURL(entrypoint).href }]))
    await ctx.loader.root.update([{ id: 'include', name: 'cordis:include', config: {
      path: pathToFileURL(file).href,
      patches: [
        { insert: [{ id: 'disabled', name: 'disabled-plugin' }] },
        { id: 'enabled', config: { value: 1 } },
        { id: 'disabled', disabled: true },
      ],
    } }])
    await ctx.loader.await()
    expect((await remote.localPlugins(signal())).map(row => [row.name, row.status])).toEqual([
      ['enabled-plugin', 'live'], ['disabled-plugin', 'disabled'],
    ])
  })

  it('returns no guessed profile without a loader and rejects cancelled requests', async () => {
    const isolated = new Context()
    try { expect(await new ReferenceAnythingRemote(isolated).localPlugins(signal())).toEqual([]) }
    finally { await isolated.fiber.dispose() }
    expect(() => remote.localPlugins(AbortSignal.abort())).toThrow()
  })
})
