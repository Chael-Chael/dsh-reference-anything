import { normalize } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ReferenceAnythingRemote } from '../src/host.ts'
import * as web from '../src/web.ts'
import { defaultPickerSettings } from '../src/wire.ts'

describe('external conversation Remote availability', () => {
  function setup() {
    const ctx = new Context()
    const settings = { enabledAgents: ['codex', 'claude-code'], picker: defaultPickerSettings(), agentDirectories: { codex: '/custom' } }
    ctx.provide('referenceChatHistory', { getSettings: () => settings })
    const scanDiscover = vi.fn(async ({ format, path }: { format: string; path?: string }) => ({
      sessions: format === 'codex' ? ['empty', 'read-error', 'readable'].map((id, index) => ({
        format, sessionId: id, title: id, sourcePath: `/test/${id}`, cwd: '/project', lastActiveAt: 3 - index,
      })) : [], warnings: path === '/broken' ? [{ format, target: path, error: 'Permission denied' }] : [],
    }))
    ctx.provide('referenceLocalAgents', {
      scanner: { scanDiscover, clear: vi.fn() }, conversationAvailability: { visible: async ({ sessionId }: { sessionId: string }) => sessionId !== 'empty' },
      setAgentDirectories: vi.fn(), discoveryPolicy: () => ({ roots: [{ kind: 'codex', path: '/custom' }], scope: 'workspace' }),
      referenceForDiscovered: async (kind: string, path: string, id: string) => `${kind}:chat-import:${id}`,
    })
    const remote = new ReferenceAnythingRemote(ctx)
    const signal = new AbortController().signal
    const agent = { session: { header: { id: 'owner', cwd: '/project' } } } as never
    return { ctx, settings, scanDiscover, remote, signal, agent }
  }
  it('scans and counts without Chat Import, hiding only confirmed empty rows', async () => {
    const { remote, signal, agent } = setup()
    const rows = await remote.agentSearch(agent, { query: '', kind: 'codex', limit: 2 }, signal)
    expect(rows.map(row => row.label)).toEqual(['read-error', 'readable'])
    expect(rows.every(row => !row.importStatus && row.referenceId)).toBe(true)
    expect((await remote.agentStats(signal)).find(row => row.agent === 'codex')).toMatchObject({ conversations: 2, readable: true })
  })
  it('rescans only the selected enabled source and returns directory errors alongside counts', async () => {
    const { ctx, settings, scanDiscover, remote, signal } = setup()
    settings.agentDirectories.codex = '/broken'
    const rows = await remote.agentRescan({ kind: 'codex' }, signal)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent: 'codex', conversations: 2, error: '/broken: Permission denied' })
    expect(scanDiscover.mock.calls.map(([input]) => input)).toEqual([{ format: 'codex' }, { format: 'codex', path: '/custom' }, { format: 'codex', path: '/broken' }])
    expect(ctx.get('referenceLocalAgents')!.scanner.clear).toHaveBeenCalledOnce()
    scanDiscover.mockClear()
    await expect(remote.agentRescan({ kind: 'trae' }, signal)).rejects.toThrow('disabled')
    const aborted = AbortSignal.abort(new Error('cancelled'))
    await expect(remote.agentRescan({ kind: 'codex' }, aborted)).rejects.toThrow('cancelled')
    expect(scanDiscover).not.toHaveBeenCalled()
  })
  it('filters category before scanning, deduplicates custom paths and respects disabled sources', async () => {
    const { scanDiscover, remote, signal, agent } = setup()
    await remote.agentSearch(agent, { query: '', kind: 'codex', limit: 2 }, signal)
    expect(scanDiscover.mock.calls.map(([input]) => input)).toEqual([{ format: 'codex', path: '/custom' }, { format: 'codex' }])
    scanDiscover.mockClear()
    expect(await remote.agentSearch(agent, { query: '', kind: 'trae', limit: 2 }, signal)).toEqual([])
    expect(scanDiscover).not.toHaveBeenCalled()
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
