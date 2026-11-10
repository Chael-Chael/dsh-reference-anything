import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import ReferenceRuntime from '../src/index.ts'
import { SourceSettingsRegistry, sourceSettingsDomainSpec } from '../src/settings.ts'
import { localAgentSettingsFromLegacy } from '../src/sources/local-agent/settings.ts'
import { cloudDriveSettingsFromLegacy } from '../src/sources/cloud-drive/settings.ts'
import { localPluginSettingsFromLegacy } from '../src/local-plugin-settings.ts'
import { ALL_LOCAL_AGENTS } from '../src/wire.ts'

/** The table half of a storage domain, which is all the registry uses. */
function memoryDomain() {
  const tables = new Map<string, Map<string, unknown>>()
  return {
    table(name: string) {
      let rows = tables.get(name)
      if (!rows) { rows = new Map(); tables.set(name, rows) }
      const table = rows
      return { get: (key: string) => table.get(key), put: async (key: string, value: unknown) => { table.set(key, value) } }
    },
    async close() {},
  } as never
}

const schema = z.object({ size: z.number().default(1) })
const definition = { schema, defaults: { size: 1 }, fromLegacy: (legacy: Readonly<Record<string, unknown>>) => typeof legacy.size === 'number' ? { size: legacy.size } : undefined }

describe('source settings registry', () => {
  it('migrates once from the legacy object and never overwrites a user save', async () => {
    const domain = memoryDomain()
    const registry = new SourceSettingsRegistry()
    await registry.attach(domain)
    const { handle } = registry.define('a', definition)
    await registry.publishLegacy({ size: 5 })
    expect(handle.get()).toEqual({ size: 5 })
    await handle.update({ size: 7 })
    await registry.publishLegacy({ size: 9 })
    expect(handle.get()).toEqual({ size: 7 })

    // A restart with the same storage: the user value wins, a late source still migrates.
    const restarted = new SourceSettingsRegistry()
    const a = restarted.define('a', definition)
    const b = restarted.define('b', definition)
    await restarted.attach(domain)
    expect(a.handle.get()).toEqual({ size: 7 })
    expect(b.handle.get()).toEqual({ size: 5 })
  })

  it('falls back to defaults for a stored value that no longer parses', async () => {
    const domain = memoryDomain()
    await (domain as { table(name: string): { put(key: string, value: unknown): Promise<void> } }).table('settings').put('a', { origin: 'user', value: { size: 'big' } })
    const registry = new SourceSettingsRegistry()
    await registry.attach(domain)
    const { handle } = registry.define('a', definition)
    await handle.update({ size: 2 }).then(() => undefined)
    expect(handle.get()).toEqual({ size: 2 })
    expect(new SourceSettingsRegistry().define('a', definition).handle.get()).toEqual({ size: 1 })
  })

  it('notifies subscribers and frees the id when the defining plugin unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(ReferenceRuntime, {})
    const seen: number[] = []
    const fiber = await ctx.plugin({ inject: ['references'], apply(scoped: Context) {
      const handle = scoped.references.defineSettings('a', definition)
      scoped.effect(() => handle.subscribe(value => { seen.push(value.size) }))
      void handle.update({ size: 3 })
    } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(seen).toEqual([3])
    expect(ctx.references.settingsIds()).toContain('a')
    await fiber.dispose()
    expect(ctx.references.settingsIds()).not.toContain('a')
    expect(() => ctx.references.defineSettings('a', definition)).not.toThrow()
  })

  it('uses its own storage domain name', () => {
    expect(sourceSettingsDomainSpec.name).toBe('reference_anything_sources')
  })
})

describe('legacy settings mapping', () => {
  it('keeps the agents read gate when the old menu switch had turned agents off', () => {
    expect(localAgentSettingsFromLegacy({ enabledAgents: ['codex'], picker: { agents: { enabled: false, showImport: false } } }))
      .toMatchObject({ enabledAgents: [], showImport: false })
    expect(localAgentSettingsFromLegacy({ enabledAgents: ['codex', 'not-an-agent'], agentDirectories: { codex: '/x' } }))
      .toMatchObject({ enabledAgents: ['codex'], agentDirectories: { codex: '/x' } })
    expect(localAgentSettingsFromLegacy({})?.enabledAgents).toEqual([...ALL_LOCAL_AGENTS])
  })

  it('moves the drive download directory and mounts to the cloud-drive source', () => {
    expect(cloudDriveSettingsFromLegacy({ cloudDriveDownloadDirectory: '/d', enabledDriveMounts: ['/a'] }))
      .toEqual({ downloadDirectory: '/d', enabledMounts: ['/a'] })
    expect(cloudDriveSettingsFromLegacy({})).toEqual({ downloadDirectory: '' })
  })

  it('moves the plugin filters to the local-plugin source', () => {
    expect(localPluginSettingsFromLegacy({ picker: { plugins: { onlyLive: true, showDeepSeek: false } } })).toEqual({ onlyLive: true, showDeepSeek: false })
    expect(localPluginSettingsFromLegacy({})).toBeUndefined()
  })
})
