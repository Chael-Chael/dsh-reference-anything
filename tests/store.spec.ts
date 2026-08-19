import { describe, expect, it, vi } from 'vitest'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { OpenCliError, type OpenCliRunner } from '../src/opencli.ts'
import { ConversationStore, type ProviderConversationRow, type ProviderTurnRow } from '../src/store/store.ts'
import type { referenceAnythingDomainSpec, SettingsRecord } from '../src/store/spec.ts'
import { ConversationSyncManager } from '../src/sync/index.ts'

class Table<V> implements KvTable<string, V> {
  data = new Map<string, V>()
  get(key: string) { return this.data.get(key) }
  entries() { return new Map(this.data).entries() }
  keys() { return new Map(this.data).keys() }
  get size() { return this.data.size }
  async put(key: string, value: V) { this.data.set(key, value) }
  async delete(key: string) { return this.data.delete(key) }
  async update(key: string, fn: (value: V) => V) { const value = fn(this.data.get(key)!); this.data.set(key, value); return value }
}

function store() {
  const tables = new Map<string, Table<never>>()
  let settings: SettingsRecord = { opencliPath: 'opencli', profile: '', detailConcurrency: 8, autoSync: false, syncOnStartup: false, autoSyncMinutes: 60, historyMode: 'offline-mirror', enabledProviders: ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi'], maxReadTurns: 10, inputRenderMode: 'pill' }
  const domain = {
    name: 'reference_anything',
    global: { get: () => settings, set: async (value: SettingsRecord) => { settings = value } },
    table(name: string) { let table = tables.get(name); if (!table) { table = new Table(); tables.set(name, table) } return table },
    async close() {},
  } as unknown as Domain<typeof referenceAnythingDomainSpec>
  return new ConversationStore(domain)
}

const history: ProviderConversationRow = {
  provider: 'chatgpt', accountScope: '', id: 'conversation-1', title: 'Long chat', url: 'https://chatgpt.com/c/conversation-1',
  createdAt: '2026-01-01', updatedAt: '2026-08-17', messageCount: 61, cursor: '', partial: false,
}
function turns(count: number, prefix = 'old'): ProviderTurnRow[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    conversationId: history.id, ordinal, messageId: String(ordinal), parentId: ordinal ? String(ordinal - 1) : '',
    branchId: 'active', activeBranch: true, role: ordinal % 2 ? 'assistant' : 'user', text: `${prefix}-${ordinal}`,
    createdAt: '', attachmentsJson: '[]', partial: false,
  }))
}

function fakeRunner(overrides: Partial<OpenCliRunner> = {}): OpenCliRunner {
  return {
    whoami: async () => 'account-hash',
    history: async () => [history],
    detail: async () => turns(2),
    ...overrides,
  } as unknown as OpenCliRunner
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for background sync')
}

describe('conversation mirror', () => {
  it('purges persisted bodies without deleting the title index', async () => {
    const db = store()
    const key = await db.putConversation(history, 'scope')
    await db.commitRevision(key, turns(2))
    expect(db.revisions.size).toBe(1)
    await db.clearMirrorContent()
    expect(db.conversations.get(key)?.title).toBe(history.title)
    expect(db.conversations.get(key)?.currentRevision).toBeUndefined()
    expect(db.revisions.size).toBe(0)
    expect(db.chunks.size).toBe(0)
    expect(db.attachments.size).toBe(0)
  })

  it('keeps only the newest revision and expires cursors into the replaced body', async () => {
    const db = store()
    const key = await db.putConversation(history, 'account-hash')
    await db.commitRevision(key, turns(61))
    expect(db.chunks.size).toBe(2)
    const newest = db.read(key, { limit: 10 })
    expect(newest.body.items.map(item => item.text)).toEqual(turns(61).slice(51).map(row => row.text))
    const cursor = newest.body.nextCursor!

    await db.commitRevision(key, turns(70, 'new'))
    expect(db.revisions.size).toBe(1)
    expect(() => db.read(key, { limit: 10, cursor })).toThrow(/expired/u)
  })

  it('does not mix sibling ChatGPT branches into the readable transcript', async () => {
    const db = store(); const key = await db.putConversation(history, 'scope')
    await db.commitRevision(key, [...turns(3), { ...turns(1)[0]!, ordinal: 3, text: 'sibling', activeBranch: false }])
    expect(db.read(key, { limit: 10 }).body.items.map(item => item.text)).not.toContain('sibling')
  })

  it('classifies attachment kinds during ingestion and preserves unavailable status', async () => {
    const db = store(); const key = await db.putConversation(history, 'scope')
    await db.commitRevision(key, [{
      ...turns(1)[0]!, text: '', attachmentsJson: JSON.stringify([
        { attachmentId: 'a', name: 'capture.PNG', mimeType: '', size: 0, status: 'unavailable' },
        { attachmentId: 'b', name: 'notes.txt', mimeType: 'text/plain', size: 5, status: 'available', locator: '/files/b' },
      ]),
    }])
    expect(db.read(key, { limit: 1 }).body.items[0]?.attachments).toEqual([
      { attachmentId: 'a', kind: 'image', name: 'capture.PNG', mimeType: '', size: 0, status: 'unavailable' },
      { attachmentId: 'b', kind: 'file', name: 'notes.txt', mimeType: 'text/plain', size: 5, status: 'available' },
    ])
    expect(db.attachment(key, db.conversations.get(key)!.currentRevision!, 'b')?.locator).toBe('/files/b')
  })

  it('marks remote-missing only after the caller supplies a completed scan set', async () => {
    const db = store(); const key = await db.putConversation(history, 'scope')
    await db.markRemoteMissing('chatgpt', 'scope', new Set())
    expect(db.conversations.get(key)?.remoteMissing).toBe(true)
  })

  it('hides older account scopes from discovery after the active account changes', async () => {
    const db = store()
    await db.putConversation(history, 'old-account')
    const current = { ...history, id: 'current-account-chat', title: 'Current account chat' }
    await db.putConversation(current, 'new-account')

    db.setActiveAccountScope('chatgpt', 'new-account')
    expect(db.list('', 'chatgpt', 10).map(match => match.row.externalId)).toEqual(['current-account-chat'])
  })

  it('uses the latest persisted sync account for discovery after restart', async () => {
    const db = store()
    await db.putConversation(history, 'old-account')
    await db.putConversation({ ...history, id: 'current-account-chat' }, 'new-account')
    await db.syncStates.put('chatgpt:old-account', {
      provider: 'chatgpt', profile: '', accountScope: 'old-account', cursor: '', status: 'idle',
      lastSyncAt: '2026-08-18T00:00:00.000Z', lastCompleteScanAt: '', error: '', completed: 1, total: 1,
      consecutiveFailures: 0, nextEligibleAt: '',
    })
    await db.syncStates.put('chatgpt:new-account', {
      provider: 'chatgpt', profile: '', accountScope: 'new-account', cursor: '', status: 'idle',
      lastSyncAt: '2026-08-19T00:00:00.000Z', lastCompleteScanAt: '', error: '', completed: 1, total: 1,
      consecutiveFailures: 0, nextEligibleAt: '',
    })

    expect(db.list('', 'chatgpt', 10).map(match => match.row.externalId)).toEqual(['current-account-chat'])
  })

  it('counts and permanently clears remote-missing conversations', async () => {
    const db = store()
    const missing = await db.putConversation(history, 'scope')
    await db.putConversation({ ...history, id: 'kept' }, 'scope')
    await db.markRemoteMissing('chatgpt', 'scope', new Set(['kept']))

    expect(db.storageStats().remoteMissing).toBe(1)
    expect(await db.removeRemoteMissing()).toBe(1)
    expect(db.conversations.get(missing)).toBeUndefined()
    expect(db.storageStats().remoteMissing).toBe(0)
  })

  it('counts and clears only conversations belonging to known inactive accounts', async () => {
    const db = store()
    const oldKey = await db.putConversation(history, 'old-account')
    const currentKey = await db.putConversation({ ...history, id: 'current' }, 'current-account')
    const unknownProviderKey = await db.putConversation({ ...history, provider: 'claude', id: 'claude-chat' }, 'claude-account')
    await db.commitRevision(oldKey, turns(2))
    db.setActiveAccountScope('chatgpt', 'current-account')
    await db.syncStates.put('chatgpt:old-account', {
      provider: 'chatgpt', profile: '', accountScope: 'old-account', cursor: '', status: 'idle',
      lastSyncAt: '2026-08-18T00:00:00.000Z', lastCompleteScanAt: '', error: '', completed: 1, total: 1,
      consecutiveFailures: 0, nextEligibleAt: '',
    })
    await db.syncStates.put('chatgpt:current-account', {
      provider: 'chatgpt', profile: '', accountScope: 'current-account', cursor: '', status: 'idle',
      lastSyncAt: '2026-08-19T00:00:00.000Z', lastCompleteScanAt: '', error: '', completed: 1, total: 1,
      consecutiveFailures: 0, nextEligibleAt: '',
    })

    expect(db.storageStats().oldAccountConversations).toBe(1)
    expect(await db.removeOldAccounts()).toBe(1)
    expect(db.conversations.get(oldKey)).toBeUndefined()
    expect(db.conversations.get(currentKey)).toBeDefined()
    expect(db.conversations.get(unknownProviderKey)).toBeDefined()
    expect(db.revisions.size).toBe(0)
    expect(db.syncStates.get('chatgpt:old-account')).toBeUndefined()
    expect(db.syncStates.get('chatgpt:current-account')).toBeDefined()
    expect(db.storageStats().oldAccountConversations).toBe(0)
  })

  it('derives provider statistics from existing local records without a sync-state row', async () => {
    const db = store()
    await db.putConversation(history, 'scope')
    const stats = db.stats(['chatgpt'])[0]
    expect(stats).toMatchObject({ provider: 'chatgpt', conversations: 1, status: 'ready' })
    expect(stats?.lastSyncedAt).not.toBe('')
  })

  it('uses a valid local conversation timestamp when another timestamp field is malformed', async () => {
    const db = store()
    await db.conversations.put('chatgpt:scope:legacy', {
      provider: 'chatgpt', accountScope: 'scope', externalId: 'legacy', title: 'Legacy chat', url: '',
      createdAt: '', updatedAt: '2026-08-18T08:30:00.000Z', messageCount: 1, partial: true,
      remoteMissing: false, syncedAt: 'not-a-date',
    })

    expect(db.stats(['chatgpt'])[0]?.lastSyncedAt).toBe('2026-08-18T08:30:00.000Z')
  })

  it('chooses the newest valid successful sync state regardless of insertion order', async () => {
    const db = store()
    await db.syncStates.put('chatgpt:broken', {
      provider: 'chatgpt', profile: '', accountScope: 'broken', cursor: '', status: 'idle',
      lastSyncAt: 'not-a-date', lastCompleteScanAt: '', error: '', completed: 0, total: 0,
      consecutiveFailures: 0, nextEligibleAt: '',
    })
    await db.syncStates.put('chatgpt:valid', {
      provider: 'chatgpt', profile: '', accountScope: 'valid', cursor: '', status: 'idle',
      lastSyncAt: '2026-08-18T09:00:00.000Z', lastCompleteScanAt: '', error: '', completed: 1, total: 1,
      consecutiveFailures: 0, nextEligibleAt: '',
    })

    expect(db.stats(['chatgpt'])[0]?.lastSyncedAt).toBe('2026-08-18T09:00:00.000Z')
  })

  it('persists a completed incremental sync and its atomic revision', async () => {
    const db = store()
    const manager = new ConversationSyncManager(db, () => fakeRunner())
    const jobId = manager.start(['chatgpt'], 'incremental')
    await waitFor(() => manager.status(jobId)?.status !== 'running')
    expect(manager.status(jobId)?.status).toBe('complete')
    expect(db.syncStates.get('chatgpt:account-hash')?.status).toBe('idle')
    const key = ConversationStore.conversationKey('chatgpt', 'account-hash', history.id)
    expect(db.conversations.get(key)?.currentRevision).toMatch(/^sha256:/)
  })

  it('uses local detail metadata instead of later directory metadata', async () => {
    const db = store()
    const row = { ...history, provider: 'gemini' as const, updatedAt: '', messageCount: 0 }
    const key = await db.putConversation(row, 'account-hash')
    await db.commitRevision(key, turns(2).map((turn, ordinal) => ({ ...turn, createdAt: String((ordinal + 1) * 1_000) })))
    await db.putConversation({ ...row, updatedAt: '2026-08-18T00:00:00.000Z', messageCount: 999 }, 'account-hash')

    expect(db.conversations.get(key)).toMatchObject({ messageCount: 2, updatedAt: '2000' })
  })

  it('falls back to the newest turn date when a provider listing omits its date', async () => {
    const db = store()
    const row = { ...history, provider: 'chatgpt' as const, updatedAt: '', messageCount: 0 }
    const key = await db.putConversation(row, 'account-hash')
    const datedTurns = turns(2).map((turn, ordinal) => ({ ...turn, createdAt: String((ordinal + 1) * 1_000) }))

    await db.commitRevision(key, datedTurns, row)

    expect(db.conversations.get(key)?.updatedAt).toBe('2000')
  })

  it('re-reads an existing local revision when the provider reports a newer timestamp', async () => {
    const db = store()
    const key = await db.putConversation(history, 'account-hash')
    await db.commitRevision(key, turns(2))
    expect(db.needsDetail(key, { ...history, updatedAt: '2026-08-18', messageCount: 999 }, false)).toBe(true)
    expect(db.needsDetail(key, history, true)).toBe(true)
  })

  it('stops sibling workers and persists a non-retryable provider failure', async () => {
    const db = store()
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      detail: async () => { throw new OpenCliError('bad provider config', 'OPENCLI_CONFIGURATION') },
    }))
    const jobId = manager.start(['chatgpt'], 'incremental')
    await waitFor(() => manager.status(jobId)?.status !== 'running')
    // A job may span several providers, so its own error names the one that failed;
    // the provider's durable row already knows which provider it is.
    expect(manager.status(jobId)).toMatchObject({ status: 'failed', error: 'chatgpt: bad provider config' })
    expect(db.syncStates.get('chatgpt:account-hash')).toMatchObject({ status: 'failed', error: 'bad provider config' })
  })

  it('persists cancellation even when account discovery has not completed', async () => {
    const db = store()
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      whoami: async (_provider, signal) => await new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      }),
    }))
    const jobId = manager.start(['chatgpt'], 'incremental')
    expect(manager.cancel(jobId)).toBe(true)
    await waitFor(() => db.syncStates.get('chatgpt:pending')?.status === 'cancelled')
    expect(manager.status(jobId)?.status).toBe('cancelled')
  })

  it('reports whether any job is currently running, for the auto-sync tick to check', async () => {
    const db = store()
    const manager = new ConversationSyncManager(db, () => fakeRunner())
    expect(manager.isRunning()).toBe(false)
    const jobId = manager.start(['chatgpt'], 'incremental')
    expect(manager.isRunning()).toBe(true)
    await waitFor(() => manager.status(jobId)?.status !== 'running')
    expect(manager.isRunning()).toBe(false)
  })

  it('sweeps a finished job off the map once the retention window elapses', async () => {
    const db = store()
    const manager = new ConversationSyncManager(db, () => fakeRunner())
    const firstJobId = manager.start(['chatgpt'], 'incremental')
    await waitFor(() => manager.status(firstJobId)?.status !== 'running')
    expect(manager.status(firstJobId)?.status).toBe('complete')

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000)
      manager.start(['chatgpt'], 'incremental')
      expect(manager.status(firstJobId)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('discovery: ranking and body search', () => {
  /** Seed one conversation, optionally with turns of its own. */
  async function seed(
    db: ConversationStore, id: string, title: string, updatedAt: string, texts: string[] = [],
    provider: ProviderConversationRow['provider'] = 'chatgpt',
  ): Promise<string> {
    const key = await db.putConversation({ ...history, provider, id, title, updatedAt }, 'scope')
    if (texts.length) {
      await db.commitRevision(key, texts.map((text, ordinal) => ({ ...turns(1)[0]!, ordinal, text })))
    }
    return key
  }

  it('returns the most recent conversations for an empty query', async () => {
    const db = store()
    await seed(db, 'c1', 'Older', '2026-08-01')
    const newest = await seed(db, 'c2', 'Newer', '2026-08-17')
    const rows = db.list('', undefined, 1)
    expect(rows.map(match => match.key)).toEqual([newest])
    expect(rows[0]!.via).toBe('recent')
  })

  it('uses provider order only when empty-query recency is tied', async () => {
    const db = store()
    const kimi = await seed(db, 'kimi', 'Kimi chat', '2026-08-17', [], 'kimi')
    const claude = await seed(db, 'claude', 'Claude chat', '2026-08-17', [], 'claude')
    const chatgpt = await seed(db, 'chatgpt', 'ChatGPT chat', '2026-08-17', [], 'chatgpt')

    expect(db.list('', undefined, 10).map(match => match.key)).toEqual([chatgpt, claude, kimi])
  })

  it('ranks by match quality first and recency only within a band', async () => {
    const db = store()
    const buried = await seed(db, 'c1', 'Redesign the cache', '2026-08-17')
    const prefix = await seed(db, 'c2', 'Design docs', '2026-08-01')
    expect(db.list('design', undefined, 10).map(match => match.key)).toEqual([prefix, buried])
  })

  it('ranks equal matches by recency and then provider order', async () => {
    const db = store()
    const older = await seed(db, 'older', 'Design notes', '2026-08-01', [], 'chatgpt')
    const kimi = await seed(db, 'kimi', 'Design notes', '2026-08-17', [], 'kimi')
    const claude = await seed(db, 'claude', 'Design notes', '2026-08-17', [], 'claude')

    expect(db.list('design', undefined, 10).map(match => match.key)).toEqual([claude, kimi, older])
  })

  it('finds a title through a space-free fuzzy query, which is all the @ token allows', async () => {
    const db = store()
    const key = await seed(db, 'c1', 'Cache design notes', '2026-08-17')
    expect(db.list('cachedes', undefined, 10).map(match => match.key)).toEqual([key])
  })

  it('reaches a conversation through its body when the title says nothing', async () => {
    const db = store()
    await seed(db, 'c1', 'Cache design notes', '2026-08-17')
    const untitled = await seed(db, 'c2', 'New chat', '2026-08-16', ['we settled on pgvector for the store'])

    const rows = db.list('pgvector', undefined, 10)
    expect(rows.map(match => match.key)).toEqual([untitled])
    expect(rows[0]!.via).toBe('content')
    expect(rows[0]!.snippet).toContain('pgvector')
  })

  it('orders body hits after every title hit', async () => {
    const db = store()
    const titled = await seed(db, 'c1', 'pgvector notes', '2026-08-01')
    const bodied = await seed(db, 'c2', 'New chat', '2026-08-17', ['we settled on pgvector'])
    expect(db.list('pgvector', undefined, 10).map(match => match.key)).toEqual([titled, bodied])
  })

  it('does not scan bodies when titles already fill the page', async () => {
    const db = store()
    await seed(db, 'c1', 'Cache design', '2026-08-17')
    await seed(db, 'c2', 'New chat', '2026-08-16', ['cache invalidation again'])
    const chunks = vi.spyOn(db.chunks, 'get')

    expect(db.list('cache', undefined, 1).map(match => match.via)).toEqual(['title'])
    expect(chunks).not.toHaveBeenCalled()
  })

  it('does not scan bodies for a query too short to mean anything', async () => {
    const db = store()
    // The title deliberately has no 'q', so only the body could match it.
    await seed(db, 'c1', 'Untitled', '2026-08-16', ['q was the join key'])
    const chunks = vi.spyOn(db.chunks, 'get')

    expect(db.list('q', undefined, 10)).toEqual([])
    expect(chunks).not.toHaveBeenCalled()
  })

  it('keeps a body excerpt in the casing it was written in', async () => {
    const db = store()
    await seed(db, 'c1', 'New chat', '2026-08-16', ['We chose PGVector after benchmarking'])
    expect(db.list('pgvector', undefined, 10)[0]!.snippet).toContain('PGVector')
  })
})

describe('management: browse and delete', () => {
  it('pages through every conversation, including ones list() hides as remote-missing', async () => {
    const db = store()
    const key1 = await db.putConversation(history, 'scope')
    const key2 = await db.putConversation({ ...history, id: 'conversation-2', title: 'Second chat', updatedAt: '2026-08-16' }, 'scope')
    await db.markRemoteMissing('chatgpt', 'scope', new Set(['conversation-2']))

    expect(db.list('', undefined, 10).map(match => match.key)).toEqual([key2])

    const page = db.page('', undefined, 10, 0)
    expect(page.total).toBe(2)
    expect(page.items.map(([key]) => key).sort()).toEqual([key1, key2].sort())
  })

  it('slices the ordered result by offset and limit', async () => {
    const db = store()
    for (let i = 0; i < 5; i++) {
      await db.putConversation({ ...history, id: `c${i}`, updatedAt: `2026-08-1${i}` }, 'scope')
    }
    const first = db.page('', undefined, 2, 0)
    const second = db.page('', undefined, 2, 2)
    expect(first.total).toBe(5)
    expect(second.total).toBe(5)
    expect(first.items).toHaveLength(2)
    expect(second.items).toHaveLength(2)
    expect(first.items.map(([key]) => key)).not.toEqual(second.items.map(([key]) => key))
  })

  it('cascades delete across revisions, chunks, and attachments, and is idempotent', async () => {
    const db = store()
    const key = await db.putConversation(history, 'scope')
    const attachmentTurn = {
      ...turns(1)[0]!, ordinal: 61, text: 'has an attachment',
      attachmentsJson: JSON.stringify([{ attachmentId: 'a1', name: 'file.png', mimeType: 'image/png', size: 10, status: 'available' }]),
    }
    await db.commitRevision(key, [...turns(61), attachmentTurn])
    expect(db.chunks.size).toBe(2)
    expect(db.attachments.size).toBe(1)

    expect(await db.remove(key)).toBe(true)
    expect(db.conversations.get(key)).toBeUndefined()
    expect(db.chunks.size).toBe(0)
    expect(db.revisions.size).toBe(0)
    expect(db.attachments.size).toBe(0)

    expect(await db.remove(key)).toBe(false)
  })

  it('reports approximate storage and clears one provider including its sync state', async () => {
    const db = store()
    const chatgpt = await db.putConversation(history, 'scope')
    await db.commitRevision(chatgpt, turns(2))
    await db.putConversation({ ...history, provider: 'claude', id: 'claude-1' }, 'scope')
    await db.syncStates.put('chatgpt:scope', {
      provider: 'chatgpt', profile: '', accountScope: 'scope', cursor: '', status: 'idle',
      lastSyncAt: '2026-08-17T00:00:00.000Z', lastCompleteScanAt: '2026-08-17T00:00:00.000Z',
      error: '', completed: 1, total: 1, consecutiveFailures: 0, nextEligibleAt: '',
    })
    expect(db.storageStats()).toMatchObject({ conversations: 2 })
    expect(db.storageStats().bytes).toBeGreaterThan(0)
    expect(await db.removeProvider('chatgpt')).toBe(1)
    expect([...db.conversations.entries()].map(([, row]) => row.provider)).toEqual(['claude'])
    expect(db.revisions.size).toBe(0)
    expect(db.syncStates.size).toBe(0)
  })

  it('clears conversations whose last update is older than the requested age', async () => {
    const db = store()
    await db.putConversation({ ...history, id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }, 'scope')
    await db.putConversation({ ...history, id: 'recent', updatedAt: '2026-08-17T00:00:00.000Z' }, 'scope')
    const now = Date.parse('2026-08-18T00:00:00.000Z')
    expect(await db.removeOlderThan(30, now)).toBe(1)
    expect([...db.conversations.entries()].map(([, row]) => row.externalId)).toEqual(['recent'])
  })

  it('summarizes per-provider sync state from the freshest attempt, without losing an older complete-scan time', async () => {
    const db = store()
    await db.syncStates.put('chatgpt:scope-old', {
      provider: 'chatgpt', profile: '', accountScope: 'scope-old', cursor: '',
      status: 'idle', lastSyncAt: '2026-08-10T00:00:00.000Z', lastCompleteScanAt: '2026-08-10T00:00:00.000Z',
      error: '', completed: 5, total: 5, consecutiveFailures: 0, nextEligibleAt: '',
    })
    await db.syncStates.put('chatgpt:pending', {
      provider: 'chatgpt', profile: '', accountScope: '', cursor: '',
      status: 'failed', lastSyncAt: '2026-08-17T00:00:00.000Z', lastCompleteScanAt: '',
      error: 'session expired', completed: 0, total: 0, consecutiveFailures: 1, nextEligibleAt: '',
    })
    const summary = db.syncStateSummary()
    expect(summary).toEqual([{
      provider: 'chatgpt', status: 'failed', lastSyncAt: '2026-08-17T00:00:00.000Z',
      lastCompleteScanAt: '2026-08-10T00:00:00.000Z', error: 'session expired',
    }])
  })
})
