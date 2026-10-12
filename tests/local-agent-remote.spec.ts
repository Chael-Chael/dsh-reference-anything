import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ReferenceAnythingRemote } from '../src/host.ts'
import { agentCandidateSchema, agentSyncStartSchema, agentSyncStatusSchema, agentStatsSchema, REFERENCE_ANYTHING_INVOCATIONS } from '../src/contract.ts'
import { settingsRecordSchema } from '../src/wire.ts'

function remoteWithAgents(enabledAgents = ['codex']) {
  const ctx = new Context()
  const local = {
    setAgentDirectories: vi.fn(),
    stats: vi.fn(async () => [{ kind: 'codex', conversations: 4, syncedConversations: 3, lastSyncedAt: 123 }]),
    sync: { start: vi.fn(() => 'local-job'), status: vi.fn(() => undefined), cancel: vi.fn(() => true) },
  }
  const settings = settingsRecordSchema.parse({
    opencliPath: 'unused', profile: '', detailConcurrency: 1, enabledAgents,
    agentDirectories: { codex: 'D:/history' },
  })
  ctx.provide('referenceLocalAgents', local as never)
  ctx.provide('referenceChatHistory', { getSettings: () => settings } as never)
  return { remote: new ReferenceAnythingRemote(ctx), local }
}

describe('local agent history sync Remote', () => {
  it('syncs only enabled agents, deduplicates selections and applies saved roots', () => {
    const { remote, local } = remoteWithAgents()
    expect(remote.agentSyncStart({ agents: ['codex', 'codex', 'claude-code'], mode: 'full' })).toBe('local-job')
    expect(local.setAgentDirectories).toHaveBeenCalledWith({ codex: 'D:/history' })
    expect(local.sync.start).toHaveBeenCalledWith(['codex'], 'full')
  })

  it('rejects an empty enabled selection before starting a job', () => {
    const { remote, local } = remoteWithAgents([])
    expect(() => remote.agentSyncStart({ agents: ['codex'], mode: 'incremental' }))
      .toThrow(expect.objectContaining({ code: 'REFERENCE_INVALID_CONFIG' }))
    expect(local.sync.start).not.toHaveBeenCalled()
  })

  it('reports an absent optional local source without starting web sync', () => {
    const remote = new ReferenceAnythingRemote(new Context())
    expect(() => remote.agentSyncStart({ agents: ['codex'], mode: 'incremental' }))
      .toThrow(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }))
    expect(remote.agentSyncStatus({ jobId: 'missing' })).toBeUndefined()
    expect(remote.agentSyncCancel({ jobId: 'missing' })).toBe(false)
  })

  it('returns mirror statistics and routes status/cancel to the local job', async () => {
    const { remote, local } = remoteWithAgents()
    expect(await remote.agentStats(new AbortController().signal)).toEqual([
      { agent: 'codex', conversations: 4, syncedConversations: 3, lastSyncedAt: 123 },
    ])
    remote.agentSyncStatus({ jobId: 'local-job' })
    expect(local.sync.status).toHaveBeenCalledWith('local-job')
    expect(remote.agentSyncCancel({ jobId: 'local-job' })).toBe(true)
    expect(local.sync.cancel).toHaveBeenCalledWith('local-job')
  })

  it('validates job input and keeps local sync separate from web providers', () => {
    expect(agentSyncStartSchema.safeParse({ agents: ['chatgpt'], mode: 'full' }).success).toBe(false)
    expect(agentSyncStartSchema.safeParse({ agents: [], mode: 'full' }).success).toBe(false)
    expect(agentStatsSchema.parse({ agent: 'codex', conversations: 4 }).syncedConversations).toBe(0)
    expect(agentCandidateSchema.parse({ id: 'codex:session.jsonl', kind: 'codex', label: 'History', provider: 'Codex', searchIncomplete: true }).searchIncomplete).toBe(true)
    expect(agentSyncStatusSchema.parse({
      jobId: 'local-job', status: 'partial', agents: ['codex'], completed: 3, total: 3,
      imported: 1, skipped: 1, failed: 1, error: 'One transcript could not be read.',
    }).status).toBe('partial')
    expect(REFERENCE_ANYTHING_INVOCATIONS.filter(item => item.method.startsWith('agentSync')).map(item => item.method))
      .toEqual(['agentSyncStart', 'agentSyncStatus', 'agentSyncCancel'])
  })
})
