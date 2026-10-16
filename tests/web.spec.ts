import { normalize } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ReferenceAnythingRemote } from '../src/host.ts'
import * as web from '../src/web.ts'
import { defaultPickerSettings } from '../src/wire.ts'

describe('external conversation Remote availability', () => {
  it('retains local discovery when the optional scan API is unavailable', async () => {
    const ctx = new Context()
    const listForWorkspace = vi.fn(async () => [{ ref: { id: 'codex:old.jsonl' }, label: 'Existing', provider: 'Codex' }])
    ctx.provide('referenceLocalAgents', { listForWorkspace })
    const remote = new ReferenceAnythingRemote(ctx)
    const signal = new AbortController().signal
    const rows = await remote.agentSearch({ session: { header: { cwd: '/work' } } } as never, { query: 'Existing', limit: 5 }, signal)
    expect(rows).toEqual([{ id: 'codex:old.jsonl', kind: 'codex', label: 'Existing', provider: 'Codex' }])
    expect(listForWorkspace).toHaveBeenCalledWith('Existing', 5, '/work', signal)
  })
  it('uses scan API metadata, preserves reference IDs, and restricts import-only selections to their session', async () => {
    const ctx = new Context()
    const settings = { picker: defaultPickerSettings(), agentDirectories: { codex: '/custom' } }
    ctx.provide('referenceChatHistory', { getSettings: () => settings })
    const setAgentDirectories = vi.fn()
    ctx.provide('referenceLocalAgents', {
      setAgentDirectories,
      discoveryPolicy: () => ({ roots: [{ kind: 'codex', path: '/custom' }], scope: 'workspace' }),
      referenceForDiscovered: async (kind: string) => kind === 'codex' ? 'codex:a.jsonl' : undefined,
    })
    const scanDiscover = vi.fn(async ({ format }: { format: string }) => ({
      sessions: ['codex', 'trae'].includes(format) ? [
        { format, sessionId: 'one', sourcePath: '/custom/a.jsonl', title: 'First', cwd: '/project', lastActiveAt: 2, importStatus: 'partial' },
        { format, sessionId: 'other', sourcePath: '/custom/b.jsonl', cwd: '/elsewhere', importStatus: 'imported' },
      ] : [],
      warnings: format === 'trae' ? [{ format, target: '/broken.db', error: 'Permission denied' }] : [],
    }))
    const importPath = vi.fn(async () => ({ mode: 'single', status: 'imported', sessionId: 'new-session' }))
    ctx.provide('chatImport', { scanDiscover, importPath })
    const remote = new ReferenceAnythingRemote(ctx)
    const agent = { session: { header: { id: 'one', cwd: '/project' } } } as never
    const signal = new AbortController().signal
    const rows = await remote.agentSearch(agent, { query: 'First', limit: 10 }, signal)
    expect(setAgentDirectories).toHaveBeenCalledWith({ codex: '/custom' })
    expect(scanDiscover).toHaveBeenCalledWith({ format: 'codex', path: '/custom', query: 'First' }, signal)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ warning: '/broken.db: Permission denied' })
    expect(rows[1]).toMatchObject({ id: 'codex:a.jsonl', referenceId: 'codex:a.jsonl', importStatus: 'partial' })
    const imported = rows[2]!
    expect(imported).toMatchObject({ importOnly: true, kind: 'trae' })
    expect(imported.id).toMatch(/^scan:/)
    expect(importPath).not.toHaveBeenCalled()
    await expect(remote.agentImport({ session: { header: { id: 'other' } } } as never, { id: imported.id }, signal)).rejects.toThrow('expired')
    await expect(remote.agentImport(agent, { id: imported.id }, signal)).resolves.toBe('new-session')
    expect(importPath).toHaveBeenCalledWith({ format: 'trae', path: '/custom/a.jsonl', sessionIds: ['one'] }, signal)
    settings.picker.agents.showImport = false
    await expect(remote.agentImport(agent, { id: imported.id }, signal)).rejects.toThrow('expired')
  })

  it('reports scan failures, keeps other results, and does not scan new sources when import is disabled', async () => {
    const ctx = new Context()
    const picker = defaultPickerSettings()
    picker.agents.showImport = false
    ctx.provide('referenceChatHistory', { getSettings: () => ({ picker }) })
    ctx.provide('referenceLocalAgents', {
      setAgentDirectories: vi.fn(),
      discoveryPolicy: () => ({ roots: [{ kind: 'codex', path: '/broken' }, { kind: 'codex', path: '/good' }], scope: 'all' }),
      referenceForDiscovered: async () => 'codex:good.jsonl',
    })
    const scanDiscover = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/broken') throw new Error('scan failed')
      return { sessions: [{ format: 'codex', sessionId: 's', sourcePath: '/good/a.jsonl', importStatus: 'not-imported' }], warnings: [] }
    })
    ctx.provide('chatImport', { scanDiscover })
    const remote = new ReferenceAnythingRemote(ctx)
    const rows = await remote.agentSearch({ session: { header: { id: 'one' } } } as never, { query: '', limit: 1 }, new AbortController().signal)
    expect(scanDiscover).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ warning: 'scan failed' })
    expect(rows[1]).toMatchObject({ id: 'codex:good.jsonl' })
  })
  it('counts API-only sources, deduplicates custom roots, and reports unavailable or failed scans', async () => {
    const ctx = new Context()
    ctx.provide('referenceChatHistory', { getSettings: () => ({ agentDirectories: { trae: 'D:/extra' } }) })
    ctx.provide('referenceLocalAgents', { setAgentDirectories: vi.fn(), stats: async () => [{ kind: 'codex', conversations: 2 }] })
    const remote = new ReferenceAnythingRemote(ctx)
    const signal = new AbortController().signal
    expect((await remote.agentStats(signal)).find(row => row.agent === 'trae')).toMatchObject({ unavailable: true })
    const scanDiscover = vi.fn(async ({ format }: { format: string }) => {
      if (format === 'vibe') throw new Error('unreadable')
      return { sessions: [{ format, sessionId: 's', sourcePath: '/same', importStatus: 'imported' }], warnings: [] }
    })
    ctx.provide('chatImport', { scanDiscover })
    const rows = await remote.agentStats(signal)
    expect(rows.find(row => row.agent === 'trae')).toEqual({ agent: 'trae', conversations: 1 })
    expect(rows.find(row => row.agent === 'vibe')).toMatchObject({ error: 'unreadable' })
    expect(scanDiscover).toHaveBeenCalledWith({ format: 'trae', path: normalize('D:/extra') }, signal)
  })

  it('honors enabled API-only sources and their additional directories', async () => {
    const ctx = new Context()
    ctx.provide('referenceChatHistory', { getSettings: () => ({ enabledAgents: ['trae'], agentDirectories: { trae: 'D:/extra' } }) })
    ctx.provide('referenceLocalAgents', { setAgentDirectories: vi.fn(), discoveryPolicy: () => ({ roots: [], scope: 'all' }) })
    const scanDiscover = vi.fn(async (_input: unknown) => ({ sessions: [], warnings: [] }))
    ctx.provide('chatImport', { scanDiscover })
    await new ReferenceAnythingRemote(ctx).agentSearch({ session: { header: { id: 's' } } } as never, { query: '', limit: 6 }, new AbortController().signal)
    expect(scanDiscover.mock.calls.map(call => call[0])).toEqual([{ format: 'trae', query: '' }, { format: 'trae', path: normalize('D:/extra'), query: '' }])
  })

  it('imports a local transcript through chatImport and returns its DSH session', async () => {
    const ctx = new Context()
    const importPath = vi.fn(async (input: unknown) => ({ mode: 'single', status: 'imported', sessionId: 'imported-session', ...(input as object) }))
    ctx.provide('chatImport', { importPath })
    ctx.provide('referenceLocalAgents', { importTarget: vi.fn(async () => ({ format: 'codex', path: 'C:/rollout.jsonl' })) })
    const remote = new ReferenceAnythingRemote(ctx)
    await expect(remote.agentImport({} as never, { id: 'codex:rollout.jsonl' }, new AbortController().signal)).resolves.toBe('imported-session')
    expect(importPath).toHaveBeenCalledWith({ format: 'codex', path: 'C:/rollout.jsonl' }, expect.any(AbortSignal))
  })

  it('starts and searches conversations when the optional cloud-drive source is absent', async () => {
    const ctx = new Context()
    const search = vi.fn(() => [])
    ctx.provide('typert', { register: vi.fn(() => () => undefined) })
    ctx.provide('referenceChatHistory', { search })
    ctx.provide('openListManager', {})
    ctx.provide('references', { registerSource: vi.fn(() => () => undefined) })
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
    ctx.provide('references', { registerSource: vi.fn(() => () => undefined) })
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
