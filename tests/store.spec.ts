import { describe, expect, it } from 'vitest'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { OpenCliError, type OpenCliRunner } from '../src/opencli.ts'
import { ConversationStore, type ProviderConversationRow, type ProviderTurnRow } from '../src/store/store.ts'
import { referenceAnythingDomainSpec, type SettingsRecord } from '../src/store/spec.ts'
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
  let settings: SettingsRecord = { opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false, autoSyncMinutes: 60 }
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

  it('derives provider statistics from existing local records without a sync-state row', async () => {
    const db = store()
    await db.putConversation(history, 'scope')
    const stats = db.stats(['chatgpt'])[0]
    expect(stats).toMatchObject({ provider: 'chatgpt', conversations: 1, status: 'ready' })
    expect(stats?.lastSyncedAt).not.toBe('')
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

  it('does not re-read an existing local revision during incremental sync', async () => {
    const db = store()
    const key = await db.putConversation(history, 'account-hash')
    await db.commitRevision(key, turns(2))
    expect(db.needsDetail(key, { ...history, updatedAt: '2026-08-18', messageCount: 999 }, false)).toBe(false)
    expect(db.needsDetail(key, history, true)).toBe(true)
  })

  it('stops sibling workers and persists a non-retryable provider failure', async () => {
    const db = store()
    const manager = new ConversationSyncManager(db, () => fakeRunner({
      detail: async () => { throw new OpenCliError('bad provider config', 'OPENCLI_CONFIGURATION') },
    }))
    const jobId = manager.start(['chatgpt'], 'incremental')
    await waitFor(() => manager.status(jobId)?.status !== 'running')
    expect(manager.status(jobId)).toMatchObject({ status: 'failed', error: 'bad provider config' })
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
})
