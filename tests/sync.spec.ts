import { describe, expect, it } from 'vitest'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { OpenCliError, type OpenCliRunner } from '../src/opencli.ts'
import { ConversationStore, type ProviderConversationRow, type ProviderTurnRow } from '../src/store/store.ts'
import type { ChatProvider, referenceAnythingDomainSpec, SettingsRecord } from '../src/store/spec.ts'
import { ConversationSyncManager } from '../src/sync/index.ts'

/** In-memory table that also counts writes, which is what the throttling tests assert on. */
class Table<V> implements KvTable<string, V> {
  data = new Map<string, V>()
  puts = 0
  get(key: string) { return this.data.get(key) }
  entries() { return new Map(this.data).entries() }
  keys() { return new Map(this.data).keys() }
  get size() { return this.data.size }
  async put(key: string, value: V) { this.puts++; this.data.set(key, value) }
  async delete(key: string) { return this.data.delete(key) }
  async update(key: string, fn: (value: V) => V) { const value = fn(this.data.get(key)!); this.data.set(key, value); return value }
}

function store(overrides: Partial<SettingsRecord> = {}) {
  const tables = new Map<string, Table<never>>()
  let settings: SettingsRecord = {
    opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false, autoSyncMinutes: 60, historyMode: 'offline-mirror', ...overrides,
  }
  const domain = {
    name: 'reference_anything',
    global: { get: () => settings, set: async (value: SettingsRecord) => { settings = value } },
    table(name: string) { let table = tables.get(name); if (!table) { table = new Table(); tables.set(name, table) } return table },
    async close() {},
  } as unknown as Domain<typeof referenceAnythingDomainSpec>
  return new ConversationStore(domain)
}

function row(provider: ChatProvider, id: string, updatedAt = '2026-08-17'): ProviderConversationRow {
  return {
    provider, accountScope: '', id, title: `${provider} ${id}`, url: `https://example.test/${id}`,
    createdAt: '2026-01-01', updatedAt, messageCount: 2, cursor: `cursor-${id}`, partial: false,
  }
}

function turns(count: number, prefix = 'turn'): ProviderTurnRow[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    conversationId: 'c', ordinal, messageId: String(ordinal), parentId: ordinal ? String(ordinal - 1) : '',
    branchId: 'active', activeBranch: true, role: ordinal % 2 ? 'assistant' : 'user', text: `${prefix}-${ordinal}`,
    createdAt: '', attachmentsJson: '[]', partial: false,
  } as ProviderTurnRow))
}

function fakeRunner(overrides: Partial<OpenCliRunner> = {}): OpenCliRunner {
  return {
    whoami: async (provider: ChatProvider) => `scope-${provider}`,
    history: async (provider: ChatProvider) => [row(provider, 'c1')],
    detail: async () => turns(2),
    ...overrides,
  } as unknown as OpenCliRunner
}

async function waitFor(predicate: () => boolean, what = 'background sync'): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const settled = (manager: ConversationSyncManager, jobId: string) =>
  waitFor(() => manager.status(jobId)?.status !== 'running')

describe('auto-sync resilience', () => {
  it('starts every selected provider concurrently', async () => {
    const db = store()
    let active = 0
    let peak = 0
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      whoami: async (provider: ChatProvider) => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active--
        return `scope-${provider}`
      },
    }))

    await settled(manager, manager.start(['chatgpt', 'claude', 'gemini'], 'incremental'))
    expect(peak).toBe(3)
  })

  it('reports live per-provider listing and conversation progress', async () => {
    const db = store({ detailConcurrency: 1 })
    let release = (): void => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      history: async () => [row('chatgpt', 'c1'), row('chatgpt', 'c2'), row('chatgpt', 'c3')],
      detail: async () => { await blocked; return turns(2) },
    }))
    const jobId = manager.start(['chatgpt'], 'incremental')
    await waitFor(() => manager.status(jobId)?.total === 3)

    expect(manager.status(jobId)).toMatchObject({
      completed: 0, total: 3,
      providerProgress: [{ provider: 'chatgpt', phase: 'syncing', completed: 0, total: 3 }],
    })
    release()
    await settled(manager, jobId)
    expect(manager.status(jobId)).toMatchObject({
      completed: 3, total: 3,
      providerProgress: [{ provider: 'chatgpt', phase: 'complete', completed: 3, total: 3 }],
    })
  })

  it('uses the combined account-and-history command when the runner provides it', async () => {
    const db = store({ historyMode: 'metadata-only' })
    let combined = 0
    let legacy = 0
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      syncIndex: async provider => {
        combined++
        return { accountScope: `scope-${provider}`, sinceApplied: '', rows: [row(provider, 'c1')] }
      },
      whoami: async () => { legacy++; return 'legacy' },
      history: async () => { legacy++; return [] },
    }))
    await settled(manager, manager.start(['chatgpt'], 'full'))
    expect(combined).toBe(1)
    expect(legacy).toBe(0)
  })

  it('uses a recent listing watermark for incremental sync but not full resync', async () => {
    const db = store()
    const since: string[] = []
    let detailCalls = 0
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      history: async (provider: ChatProvider, _signal?: AbortSignal, watermark?: string) => {
        since.push(watermark ?? '')
        return [row(provider, 'c1')]
      },
      detail: async () => { detailCalls++; return turns(2) },
    }))

    await settled(manager, manager.start(['chatgpt'], 'full'))
    await settled(manager, manager.start(['chatgpt'], 'incremental'))
    await settled(manager, manager.start(['chatgpt'], 'full'))

    expect(since[0]).toBe('')
    expect(since[1]).not.toBe('')
    expect(since[2]).toBe('')
    // Initial full + final full; unchanged incremental skips the body.
    expect(detailCalls).toBe(2)
  })

  it('stores only listing metadata in metadata-only mode', async () => {
    const db = store({ historyMode: 'metadata-only' })
    let detailCalls = 0
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      detail: async () => { detailCalls++; return turns(2) },
    }))
    const jobId = manager.start(['chatgpt'], 'full')
    await settled(manager, jobId)
    expect(detailCalls).toBe(0)
    expect(db.conversations.size).toBe(1)
    expect(db.revisions.size).toBe(0)
    expect([...db.conversations.entries()][0]?.[1].currentRevision).toBeUndefined()
  })

  it('keeps syncing later providers after one of them cannot log in', async () => {
    const db = store()
    const attempted: ChatProvider[] = []
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      whoami: async (provider: ChatProvider) => {
        attempted.push(provider)
        if (provider === 'claude') throw new OpenCliError('not logged in', 'PROVIDER_NOT_LOGGED_IN')
        return `scope-${provider}`
      },
    }))
    const jobId = manager.start(['chatgpt', 'claude', 'gemini'], 'incremental')
    await settled(manager, jobId)

    expect(attempted).toEqual(['chatgpt', 'claude', 'gemini'])
    expect(manager.status(jobId)?.status).toBe('partial')
    expect(manager.status(jobId)?.error).toContain('claude')
    expect(db.syncStates.get('gemini:scope-gemini')?.status).toBe('idle')
  })

  it('re-fetches a conversation whose detail failed, instead of trusting the newer timestamp', async () => {
    const db = store()
    let failDetail = true
    const detailCalls: string[] = []
    const runner = fakeRunner({
      history: async () => [row('chatgpt', 'c1', '2026-08-18')],
      detail: async (_provider: ChatProvider, id: string) => {
        detailCalls.push(id)
        if (failDetail) throw new OpenCliError('transient provider hiccup', 'OPENCLI_OUTPUT_TOO_LARGE')
        return turns(2)
      },
    })
    const manager = new ConversationSyncManager(db, () => runner)
    const key = ConversationStore.conversationKey('chatgpt', 'scope-chatgpt', 'c1')

    // Seed a conversation that already has a committed revision at an older stamp.
    await db.putConversation(row('chatgpt', 'c1', '2026-08-17'), 'scope-chatgpt')
    await db.commitRevision(key, turns(2, 'stale'))
    expect(db.conversations.get(key)?.updatedAt).toBe('2026-08-17')

    await settled(manager, manager.start(['chatgpt'], 'incremental'))
    // The failed fetch must not have advanced the only change signal there is.
    expect(db.conversations.get(key)?.updatedAt).toBe('2026-08-17')

    failDetail = false
    await settled(manager, manager.start(['chatgpt'], 'incremental'))
    expect(detailCalls).toHaveLength(2)
    expect(db.conversations.get(key)?.updatedAt).toBe('2026-08-18')
  })

  it('tolerates a few unreadable conversations but stops dead on a broken adapter', async () => {
    const many = Array.from({ length: 40 }, (_, index) => row('chatgpt', `c${String(index)}`))
    const tolerant = store()
    const tolerantManager = new ConversationSyncManager(tolerant, () => fakeRunner({
      history: async () => many,
      detail: async (_provider: ChatProvider, id: string) => {
        if (id === 'c3') throw new OpenCliError('one bad transcript', 'OPENCLI_OUTPUT_TOO_LARGE')
        return turns(2)
      },
    }))
    const tolerantJob = tolerantManager.start(['chatgpt'], 'incremental')
    await settled(tolerantManager, tolerantJob)
    expect(tolerantManager.status(tolerantJob)?.status).toBe('complete')
    expect(tolerant.syncStates.get('chatgpt:scope-chatgpt')?.error).toContain('1 conversations failed')
    // A pass that could not read everything must not retire anything as remote-missing.
    expect(tolerant.syncStates.get('chatgpt:scope-chatgpt')?.lastCompleteScanAt).toBe('')

    const fatal = store()
    const fatalManager = new ConversationSyncManager(fatal, () => fakeRunner({
      history: async () => many,
      detail: async () => { throw new OpenCliError('bad provider config', 'OPENCLI_CONFIGURATION') },
    }))
    const fatalJob = fatalManager.start(['chatgpt'], 'incremental')
    await settled(fatalManager, fatalJob)
    expect(fatalManager.status(fatalJob)).toMatchObject({ status: 'failed', error: expect.stringContaining('bad provider config') })
  })

  it('aborts a job that outruns its deadline, so later ticks are not gated forever', async () => {
    const db = store()
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      detail: async (_provider: ChatProvider, _id: string, signal?: AbortSignal) => await new Promise<ProviderTurnRow[]>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      }),
    }))
    const jobId = manager.start(['chatgpt'], 'incremental', { deadlineMs: 40 })
    await settled(manager, jobId)
    expect(manager.status(jobId)?.status).toBe('cancelled')
    expect(manager.isRunning()).toBe(false)
  })

  it('still reports itself running between a cancel and the workers actually stopping', async () => {
    const db = store()
    let release = (): void => {}
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      detail: async () => { await new Promise<void>(resolve => { release = resolve }); return turns(2) },
    }))
    const jobId = manager.start(['chatgpt'], 'incremental')
    await waitFor(() => release !== undefined && manager.isRunning(), 'the first detail fetch')

    expect(manager.cancel(jobId)).toBe(true)
    // The delete guard reads this; a cancelled job is still writing at this point.
    expect(manager.isRunning()).toBe(true)
    release()
    await settled(manager, jobId)
    expect(manager.isRunning()).toBe(false)
  })
})

describe('auto-sync scheduling', () => {
  it('backs a failing provider off, and clears the backoff once it succeeds', async () => {
    const db = store()
    let loggedIn = false
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      whoami: async (provider: ChatProvider) => {
        if (!loggedIn) throw new OpenCliError('not logged in', 'PROVIDER_NOT_LOGGED_IN')
        return `scope-${provider}`
      },
    }))

    await settled(manager, manager.start(['chatgpt'], 'incremental'))
    const failed = db.syncStates.get('chatgpt:pending')
    expect(failed?.consecutiveFailures).toBe(1)
    expect(Date.parse(failed?.nextEligibleAt ?? '')).toBeGreaterThan(Date.now())
    expect(manager.eligibleProviders(['chatgpt', 'claude'])).toEqual(['claude'])

    loggedIn = true
    await settled(manager, manager.start(['chatgpt'], 'incremental'))
    expect(db.syncStates.get('chatgpt:scope-chatgpt')).toMatchObject({ consecutiveFailures: 0, nextEligibleAt: '' })
    expect(manager.eligibleProviders(['chatgpt', 'claude'])).toContain('chatgpt')
  })

  it('offers auto-sync only the providers that have completed a scan, once any has', async () => {
    const db = store()
    const manager = new ConversationSyncManager(db, () => fakeRunner())
    // Nothing has ever synced: refusing everything would mean never discovering
    // which providers are usable.
    expect(manager.eligibleProviders(['chatgpt', 'claude'])).toEqual(['chatgpt', 'claude'])

    await settled(manager, manager.start(['chatgpt'], 'incremental'))
    expect(manager.eligibleProviders(['chatgpt', 'claude'])).toEqual(['chatgpt'])
  })
})

describe('sync write volume', () => {
  it('throttles durable progress instead of writing once per conversation', async () => {
    const db = store({ detailConcurrency: 4 })
    const many = Array.from({ length: 120 }, (_, index) => row('chatgpt', `c${String(index)}`))
    const manager = new ConversationSyncManager(db, () => fakeRunner({ history: async () => many }))
    await settled(manager, manager.start(['chatgpt'], 'incremental'))

    expect(db.conversations.size).toBe(120)
    // Every write re-serializes the whole domain on the JSON backend, so the
    // progress counter must not cost one per conversation.
    expect((db.syncStates as unknown as Table<unknown>).puts).toBeLessThan(10)
  })

  it('does not rewrite chunks when a re-fetched transcript is byte-identical', async () => {
    const db = store()
    const key = await db.putConversation(row('chatgpt', 'c1'), 'scope')
    await db.commitRevision(key, turns(120))
    const chunks = db.chunks as unknown as Table<unknown>
    const after = chunks.puts
    expect(after).toBe(3)

    await db.commitRevision(key, turns(120), row('chatgpt', 'c1', '2026-08-19'))
    expect(chunks.puts).toBe(after)
    // The metadata still lands, on the one write the commit is allowed to make.
    expect(db.conversations.get(key)?.updatedAt).toBe('2026-08-19')
  })

  it('skips the conversation write entirely when the listing says nothing changed', async () => {
    const db = store()
    const conversations = db.conversations as unknown as Table<unknown>
    await db.putConversation(row('chatgpt', 'c1'), 'scope')
    const after = conversations.puts

    await db.putConversation(row('chatgpt', 'c1'), 'scope')
    expect(conversations.puts).toBe(after)

    await db.putConversation(row('chatgpt', 'c1', '2026-08-20'), 'scope')
    expect(conversations.puts).toBe(after + 1)
  })
})
