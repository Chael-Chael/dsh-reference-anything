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
  let settings: SettingsRecord = {
    opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false, autoSyncMinutes: 60,
  }
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
  it('writes immutable chunks and keeps an old cursor pinned across a new revision', async () => {
    const db = store()
    const key = await db.putConversation(history, 'account-hash')
    const oldRevision = await db.commitRevision(key, turns(61))
    expect(db.chunks.size).toBe(2)
    const newest = db.read(key, { limit: 10 })
    expect(newest.body.items.map(item => item.text)).toEqual(turns(61).slice(51).map(row => row.text))
    const cursor = newest.body.nextCursor!

    await db.commitRevision(key, turns(70, 'new'))
    const olderOldRevision = db.read(key, { limit: 10, cursor })
    expect(olderOldRevision.revision).toBe(oldRevision)
    expect(olderOldRevision.body.items[0]?.text).toBe('old-41')
  })

  it('does not mix sibling ChatGPT branches into the readable transcript', async () => {
    const db = store(); const key = await db.putConversation(history, 'scope')
    await db.commitRevision(key, [...turns(3), { ...turns(1)[0]!, ordinal: 3, text: 'sibling', activeBranch: false }])
    expect(db.read(key, { limit: 10 }).body.items.map(item => item.text)).not.toContain('sibling')
  })

  it('marks remote-missing only after the caller supplies a completed scan set', async () => {
    const db = store(); const key = await db.putConversation(history, 'scope')
    await db.markRemoteMissing('chatgpt', 'scope', new Set())
    expect(db.conversations.get(key)?.remoteMissing).toBe(true)
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
  ): Promise<string> {
    const key = await db.putConversation({ ...history, id, title, updatedAt }, 'scope')
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

  it('ranks by match quality first and recency only within a band', async () => {
    const db = store()
    const buried = await seed(db, 'c1', 'Redesign the cache', '2026-08-17')
    const prefix = await seed(db, 'c2', 'Design docs', '2026-08-01')
    expect(db.list('design', undefined, 10).map(match => match.key)).toEqual([prefix, buried])
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
