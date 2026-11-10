import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import * as localPlugin from '../src/sources/local-plugin.ts'
import { HOST_GROUPS, createReferenceGroupRegistry, hostSourceLoaded } from '../src/client/source-registry.ts'
import { LOCAL_AGENT_ICON_MARKER, PICKER_ICON_MARKER, PROVIDER_ICON_MARKER } from '../src/client/provider-icons.tsx'
import { readFileSync } from 'node:fs'

const cordisPatch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

describe('reference group registry', () => {
  it('adds, refuses duplicates and built-in ids, and removes groups', () => {
    const registry = createReferenceGroupRegistry(['agents'])
    const listener = vi.fn()
    registry.subscribe(listener)
    const group = { id: 'notes', label: 'Notes', create: () => ({}) as never }
    const dispose = registry.register(group)
    expect(registry.list().map(item => item.id)).toEqual(['notes'])
    expect(() => registry.register(group)).toThrow()
    expect(() => registry.register({ ...group, id: 'agents' })).toThrow()
    dispose()
    expect(registry.list()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('treats an unknown roster as loaded and otherwise follows it', () => {
    expect(hostSourceLoaded('web-chat', undefined)).toBe(true)
    expect(hostSourceLoaded(undefined, [])).toBe(true)
    expect(hostSourceLoaded('web-chat', ['local-agent'])).toBe(false)
  })

  it('names a real plugin row for every host-backed group', () => {
    for (const { row } of Object.values(HOST_GROUPS)) expect(cordisPatch).toContain(`id: ${row}`)
  })
})

describe('icon markers', () => {
  it('never share a codepoint, because the projection matches by codepoint', () => {
    const all = [...Object.values(PICKER_ICON_MARKER), ...Object.values(LOCAL_AGENT_ICON_MARKER), ...Object.values(PROVIDER_ICON_MARKER)].map(String)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('local-plugin source plugin', () => {
  it('owns its source and settings, and takes both with it when switched off', async () => {
    const ctx = new Context()
    await ctx.plugin(ReferenceRuntime, {})
    const fiber = await ctx.plugin(localPlugin)
    expect(ctx.references.sourceIds()).toContain('local-plugin')
    expect(ctx.references.settingsIds()).toContain('local-plugin')
    await fiber.dispose()
    expect(ctx.references.sourceIds()).not.toContain('local-plugin')
    expect(ctx.references.settingsIds()).not.toContain('local-plugin')
  })
})
