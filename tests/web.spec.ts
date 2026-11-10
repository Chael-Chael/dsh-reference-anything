import { normalize } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ReferenceAnythingRemote } from '../src/host.ts'
import { LocalAgentRemote } from '../src/sources/local-agent/remote.ts'
import { CloudDriveRemote } from '../src/sources/cloud-drive/remote.ts'
import { mountRemote } from '../src/remote-mount.ts'
import { DRIVE_TYPERT_MANIFEST } from '../src/typert.ts'
import * as web from '../src/web.ts'
import { memorySettings } from '../src/settings.ts'
import { defaultLocalAgentSettings, localAgentSettingsSchema } from '../src/sources/local-agent/settings.ts'

describe('external conversation Remote availability', () => {
  function setup() {
    const ctx = new Context()
    const preferences = memorySettings(localAgentSettingsSchema, { ...defaultLocalAgentSettings(), enabledAgents: ['codex', 'claude-code'], agentDirectories: { codex: '/custom' } })
    const scanDiscover = vi.fn(async ({ format, path }: { format: string; path?: string }) => ({
      sessions: format === 'codex' ? ['empty', 'read-error', 'readable'].map((id, index) => ({
        format, sessionId: id, title: id, sourcePath: `/test/${id}`, cwd: '/project', lastActiveAt: 3 - index,
      })) : [], warnings: path === '/broken' ? [{ format, target: path, error: 'Permission denied' }] : [],
    }))
    ctx.provide('referenceLocalAgents', {
      preferences, scanner: { scanDiscover }, conversationAvailability: { visible: async ({ sessionId }: { sessionId: string }) => sessionId !== 'empty' },
      setAgentDirectories: vi.fn(), discoveryPolicy: () => ({ roots: [{ kind: 'codex', path: '/custom' }], scope: 'workspace' }),
      referenceForDiscovered: async (kind: string, path: string, id: string) => `${kind}:chat-import:${id}`,
    })
    const remote = new LocalAgentRemote(ctx)
    const signal = new AbortController().signal
    const agent = { session: { header: { id: 'owner', cwd: '/project' } } } as never
    return { ctx, preferences, scanDiscover, remote, signal, agent }
  }
  it('scans and counts without Chat Import, hiding only confirmed empty rows', async () => {
    const { remote, signal, agent } = setup()
    const rows = await remote.agentSearch(agent, { query: '', kind: 'codex', limit: 2 }, signal)
    expect(rows.map(row => row.label)).toEqual(['read-error', 'readable'])
    expect(rows.every(row => !row.importStatus && row.referenceId)).toBe(true)
    expect((await remote.agentStats(signal)).find(row => row.agent === 'codex')).toMatchObject({ conversations: 2, readable: true })
  })
  it('filters category before scanning, deduplicates custom paths and respects disabled sources', async () => {
    const { scanDiscover, remote, signal, agent } = setup()
    await remote.agentSearch(agent, { query: '', kind: 'codex', limit: 2 }, signal)
    expect(scanDiscover.mock.calls.map(([input]) => input)).toEqual([{ format: 'codex', path: '/custom' }, { format: 'codex' }])
    scanDiscover.mockClear()
    expect(await remote.agentSearch(agent, { query: '', kind: 'trae', limit: 2 }, signal)).toEqual([])
    expect(scanDiscover).not.toHaveBeenCalled()
  })
  it('does not rescan import status for formats with no matching references', async () => {
    const { ctx, remote, signal, agent } = setup()
    const scanDiscover = vi.fn(async (_input: { format: string }) => ({ sessions: [], warnings: [] }))
    ctx.provide('chatImport', { scanDiscover })
    expect(await remote.agentSearch(agent, { query: 'no-match/file/', limit: 100 }, signal)).toEqual([])
    expect(scanDiscover).not.toHaveBeenCalled()
    await remote.agentSearch(agent, { query: 'readable', limit: 100 }, signal)
    expect(scanDiscover.mock.calls).toHaveLength(1)
    expect(scanDiscover.mock.calls[0]![0]).toEqual({ format: 'codex', path: '/custom' })
  })
  it('enriches exact local matches from the API and keeps import selection session-bound', async () => {
    const { ctx, remote, signal, agent } = setup()
    const importPath = vi.fn(async () => ({ mode: 'single', status: 'imported', sessionId: 'new-session' }))
    ctx.provide('chatImport', { importPath, scanDiscover: async () => ({ sessions: [
      { format: 'codex', sourcePath: '/test/readable', sessionId: 'readable', importStatus: 'partial' },
      { format: 'codex', sourcePath: '/different/read-error', sessionId: 'read-error', importStatus: 'imported' },
    ], warnings: [] }) })
    const rows = await remote.agentSearch(agent, { query: '', kind: 'codex', limit: 2 }, signal)
    expect(rows[0]!.importStatus).toBeUndefined()
    expect(rows[1]!.importStatus).toBe('partial')
    await expect(remote.agentImport({ session: { header: { id: 'other' } } } as never, { id: rows[1]!.id }, signal)).rejects.toThrow('expired')
    await expect(remote.agentImport(agent, { id: rows[1]!.id }, signal)).resolves.toBe('new-session')
    expect(importPath).toHaveBeenCalledWith({ format: 'codex', path: '/test/readable', sessionIds: ['readable'] }, signal)
  })
  it('keeps references when the optional API fails and surfaces local scan errors', async () => {
    const { ctx, remote, scanDiscover, signal, agent } = setup()
    ctx.provide('chatImport', { scanDiscover: async () => { throw new Error('plugin failed') } })
    expect(await remote.agentSearch(agent, { query: 'readable', kind: 'codex', limit: 2 }, signal)).toHaveLength(1)
    scanDiscover.mockRejectedValue(new Error('Permission denied'))
    const rows = await remote.agentSearch(agent, { query: '', kind: 'codex', limit: 2 }, signal)
    expect(rows.every(row => row.kind === 'scan-warning' && row.warning === 'Permission denied')).toBe(true)
  })

  it('imports a local transcript through chatImport and returns its DSH session', async () => {
    const ctx = new Context()
    const importPath = vi.fn(async (input: unknown) => ({ mode: 'single', status: 'imported', sessionId: 'imported-session', ...(input as object) }))
    ctx.provide('chatImport', { importPath })
    ctx.provide('referenceLocalAgents', { conversationAvailability: { visible: async () => true }, importTarget: vi.fn(async () => ({ format: 'codex', path: 'C:/rollout.jsonl' })) })
    const remote = new LocalAgentRemote(ctx)
    await expect(remote.agentImport({} as never, { id: 'codex:rollout.jsonl' }, new AbortController().signal)).resolves.toBe('imported-session')
    expect(importPath).toHaveBeenCalledWith({ format: 'codex', path: 'C:/rollout.jsonl' }, expect.any(AbortSignal))
  })

  it('mounts the core Remote and settings with every source switched off', async () => {
    const ctx = new Context()
    const register = vi.fn(() => () => undefined)
    ctx.provide('typert', { register })
    ctx.provide('references', { registerSource: vi.fn(() => () => undefined), sourceIds: () => ['local-plugin'], settingsIds: () => ['menu', 'local-plugin'], settingsOf: () => undefined, defineSettings: (_id: string, definition: { schema: never; defaults: never }) => memorySettings(definition.schema, definition.defaults) })
    const fiber = await ctx.plugin(web)
    try {
      const remote = ctx.get('referenceAnything') as ReferenceAnythingRemote | undefined
      expect(remote).toBeDefined()
      const signal = new AbortController().signal
      expect(remote!.sources(signal)).toEqual(['local-plugin', 'menu'])
      expect(remote!.settingsGet().picker?.agents.enabled).toBe(true)
      expect(ctx.get('referenceAnythingWebChat')).toBeUndefined()
      expect(ctx.get('referenceAnythingDrive')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('mounts a source Remote only while Typert and its plugin are present', async () => {
    const ctx = new Context()
    const pickerList = vi.fn(async () => [{ ref: { source: 'cloud-drive', id: 'drive-1' }, label: 'notes.md', provider: 'OpenList' }])
    ctx.provide('referenceCloudDrive', { pickerList })
    const fiber = await ctx.plugin({ apply(scoped: Context) { mountRemote(scoped, scope => new CloudDriveRemote(scope), DRIVE_TYPERT_MANIFEST) } })
    expect(ctx.get('referenceAnythingDrive')).toBeUndefined()
    const disposeTypert = ctx.provide('typert', { register: vi.fn(() => () => undefined) })
    await new Promise(resolve => setTimeout(resolve, 0))
    const remote = ctx.get('referenceAnythingDrive') as CloudDriveRemote
    const signal = new AbortController().signal
    await expect(remote.driveSearch({ query: 'notes', limit: 10 }, signal))
      .resolves.toEqual([{ id: 'drive-1', label: 'notes.md', provider: 'OpenList' }])
    await fiber.dispose()
    expect(ctx.get('referenceAnythingDrive')).toBeUndefined()
    if (typeof disposeTypert === 'function') await disposeTypert()
  })
})
