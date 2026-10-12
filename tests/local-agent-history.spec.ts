import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import * as localAgent from '../src/sources/local-agent/index.ts'
import type { AgentSyncStatus } from '../src/sources/local-agent/sync.ts'
import { AgentHistorySyncManager } from '../src/sources/local-agent/sync.ts'
import { claudeCodeAdapter } from '../src/sources/local-agent/adapters/claude-code.ts'
import { DEFAULT_CONVERT_OPTIONS } from '../src/sources/local-agent/adapters/shared.ts'
import { IMPORT_LIMITS, readForImport } from '../src/sources/local-agent/import.ts'
import type { AgentKind } from '../src/sources/local-agent/types.ts'

let directory: string
let transcripts: string
const disposers: Array<() => Promise<void>> = []

/** Real DomainFacility validation and durability ordering over a tiny file-backed KV test adapter. */
function backend(root: string, hooks: { beforePut?: (table: string) => Promise<void>; closed?: () => void } = {}): StorageBackend {
  return {
    kv: {
      async open(descriptor) {
        const path = join(root, `${descriptor.name}.json`)
        let snapshot: { tables: Record<string, Record<string, unknown>>; global: unknown } = await readFile(path, 'utf8')
          .then(text => JSON.parse(text) as { tables: Record<string, Record<string, unknown>>; global: unknown })
          .catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            return { tables: Object.fromEntries(descriptor.tables.map(table => [table, {}])), global: null }
          })
        let closed = false
        const persist = async (next: typeof snapshot) => {
          if (closed) throw new Error('backend closed')
          await writeFile(`${path}.tmp`, JSON.stringify(next), 'utf8')
          await rename(`${path}.tmp`, path)
          snapshot = next
        }
        return {
          async loadAll() { return structuredClone(snapshot) },
          async putRecord(table, key, value) {
            await hooks.beforePut?.(table)
            const next = structuredClone(snapshot)
            next.tables[table]![key] = value
            await persist(next)
          },
          async deleteRecord(table, key) {
            const next = structuredClone(snapshot)
            delete next.tables[table]![key]
            await persist(next)
          },
          async setGlobal(value) { await persist({ ...snapshot, global: value }) },
          async close() { closed = true; hooks.closed?.() },
        }
      },
    },
    async close() {},
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-agent-history-'))
  transcripts = join(directory, 'transcripts')
  await mkdir(transcripts)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
  await rm(directory, { recursive: true, force: true })
})

const question = (text: string, cwd = '/work/app') => ({ type: 'user', cwd, message: { role: 'user', content: text } })
const answer = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const encode = (...rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
async function transcript(name = 'session', options: { title?: string; cwd?: string; answer?: string } = {}) {
  const path = join(transcripts, `${name}.jsonl`)
  await writeFile(path, encode(question(`question ${name}`, options.cwd), answer(options.answer ?? 'historical answer'),
    { type: 'ai-title', aiTitle: options.title ?? `Topic ${name}` }))
  return path
}

async function mount(config: localAgent.Config = {}, hooks: Parameters<typeof backend>[1] = {}) {
  const ctx = new Context()
  const disk = backend(directory, hooks)
  ctx.provide('storage', { backend: { get: () => disk } } as never)
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'test' }))
  const settings = { enabledAgents: ['claude-code', 'codex'] }
  ctx.provide('referenceChatHistory', { store: { settings } } as never)
  await ctx.plugin(ReferenceRuntime, {})
  const fiber = await ctx.plugin(localAgent, {
    agents: [], extraRoots: [{ kind: 'claude-code', path: transcripts }], directoryTtlMs: 0, ...config,
  })
  const dispose = () => fiber.dispose()
  disposers.push(dispose)
  return { ctx, service: ctx.referenceLocalAgents, dispose, settings }
}

async function finish(service: { sync: AgentHistorySyncManager }, mode: 'incremental' | 'full' = 'incremental', agents: AgentKind[] = ['claude-code']): Promise<AgentSyncStatus> {
  const id = service.sync.start(agents, mode)
  await vi.waitFor(() => expect(service.sync.status(id)?.status).not.toBe('running'), { timeout: 5000, interval: 5 })
  return service.sync.status(id)!
}
const REF = { source: 'local-agent', id: 'claude-code:session.jsonl' }

describe('local agent durable history', () => {
  it('preserves Codex index titles and refreshes renamed titles without a changed rollout', async () => {
    const codexRoot = join(directory, 'codex', 'sessions')
    await mkdir(codexRoot, { recursive: true })
    const id = '018fc012-3456-789a-bcde-0123456789ab'
    const file = `rollout-2026-01-01T00-00-00-${id}.jsonl`
    const indexPath = join(directory, 'codex', 'session_index.jsonl')
    await writeFile(join(codexRoot, file), encode(
      { type: 'session_meta', payload: { id, cwd: '/work/app' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original opening prompt' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Preserved answer' }] } },
    ))
    await writeFile(indexPath, encode({ id, thread_name: 'Indexed title' }))
    const config: localAgent.Config = { extraRoots: [{ kind: 'codex', path: codexRoot }] }
    const { service, dispose } = await mount(config)
    const ref = { source: 'local-agent', id: `codex:${file}` }
    expect(await finish(service, 'full', ['codex'])).toMatchObject({ imported: 1, status: 'complete' })
    const original = await service.read(ref, { limit: 20 })
    expect(original.label).toBe('Indexed title')
    expect(await finish(service, 'incremental', ['codex'])).toMatchObject({ imported: 0, skipped: 1 })

    await writeFile(indexPath, encode({ id, thread_name: 'Renamed in Codex' }))
    expect((await service.list('Renamed', 10))[0]?.label).toBe('Renamed in Codex')
    expect(await finish(service, 'incremental', ['codex'])).toMatchObject({ imported: 1, skipped: 0 })
    expect(await service.read(ref, { limit: 20 })).toMatchObject({ label: 'Renamed in Codex', revision: original.revision })
    await dispose()
    await rm(join(directory, 'codex'), { recursive: true, force: true })
    const reopened = await mount(config)
    expect((await reopened.service.list('Renamed', 10))[0]?.label).toBe('Renamed in Codex')
    expect((await reopened.service.read(ref, { limit: 20 })).label).toBe('Renamed in Codex')
  })

  it('imports beyond picker/read caps and remains searchable and readable after reopening without source files', async () => {
    await transcript('session', { answer: 'unique stored body needle' })
    await transcript('older')
    const { ctx, service, dispose } = await mount({ maxTranscripts: 1, maxReadTurns: 1, maxScanBytes: 16, maxLineBytes: 16 })
    expect(service).toBeDefined() // Plugin mounting awaits both domains and service initialization.
    expect(await finish(service)).toMatchObject({ status: 'complete', total: 2, imported: 2, failed: 0 })
    expect(await service.stats()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'claude-code', syncedConversations: 2 })]))
    expect((await service.list('storedbody', 10)).map(row => row.ref.id)).toEqual([])
    expect((await service.list('stored body', 10)).map(row => row.ref.id)).toEqual([REF.id])
    expect(() => ctx.references.assertGranted('task', REF)).toThrow()
    ctx.references.grant('task', REF)
    expect(() => ctx.references.assertGranted('task', REF)).not.toThrow()
    await dispose()
    await rm(transcripts, { recursive: true, force: true })
    const reopened = await mount({ maxReadTurns: 1 })
    expect(await reopened.service.available()).toBe(true)
    expect((await reopened.ctx.references.list('stored body', 5)).map(row => row.ref.id)).toEqual([REF.id])
    const recent = await reopened.ctx.references.read(REF, { limit: 10 })
    expect(recent.body).toMatchObject({ totalTurns: 2, hasOlder: true, startIndex: 1 })
    expect(recent.body.items[0]?.text).toBe('unique stored body needle')
    const older = await reopened.ctx.references.read(REF, { limit: 10, cursor: recent.body.nextCursor })
    expect(older.body.items[0]?.text).toBe('question session')
  })

  it('skips unchanged imports, replaces changed snapshots once, and rejects old revision cursors', async () => {
    const path = await transcript()
    const { service } = await mount()
    expect(await finish(service)).toMatchObject({ imported: 1, skipped: 0 })
    const initial = await service.read(REF, { limit: 1 })
    expect(await finish(service)).toMatchObject({ imported: 0, skipped: 1 })
    await appendFile(path, encode(question('follow-up'), answer('new answer')))
    expect(await finish(service)).toMatchObject({ imported: 1, skipped: 0 })
    expect((await service.read(REF, { limit: 20 })).body.totalTurns).toBe(4)
    await expect(service.read(REF, { limit: 1, cursor: initial.body.nextCursor })).rejects.toMatchObject({ code: 'REFERENCE_CURSOR_EXPIRED' })
    const current = await service.read(REF, { limit: 1 })
    expect(await finish(service, 'full')).toMatchObject({ imported: 1, skipped: 0 })
    expect((await service.read(REF, { limit: 1 })).revision).toBe(current.revision)
  })

  it('keeps summary tool output rules in the mirror and rejects mismatched cursor detail', async () => {
    const path = await transcript()
    await appendFile(path, encode({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'private-argument' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'private-output' }] } }))
    const { service } = await mount()
    await finish(service)
    const full = await service.read(REF, { limit: 1, detail: 'full' })
    expect(full.body.items[0]?.text).toContain('private-argument')
    const summary = await service.read(REF, { limit: 1, detail: 'summary' })
    expect(summary.body.items[0]?.text).not.toContain('private-argument')
    expect(summary.body.items[0]?.text).not.toContain('private-output')
    await expect(service.read(REF, { limit: 1, detail: 'full', cursor: summary.body.nextCursor })).rejects.toMatchObject({ code: 'REFERENCE_INVALID_CURSOR' })
  })

  it('preserves enabled-agent and workspace discovery policies for offline histories', async () => {
    await transcript('session')
    await transcript('elsewhere', { cwd: '/work/other' })
    const { service, settings } = await mount({ scope: 'workspace' })
    await finish(service)
    await rm(transcripts, { recursive: true, force: true })
    expect((await service.listForWorkspace('', 10, '/work/app')).map(row => row.ref.id)).toEqual([REF.id])
    settings.enabledAgents = ['codex']
    expect(await service.listForWorkspace('', 10, '/work/app')).toEqual([])
    // Already granted references remain readable after discovery is disabled.
    expect((await service.read(REF, { limit: 20 })).body.totalTurns).toBe(2)
    expect(await finish(service)).toMatchObject({ agents: [], total: 0, imported: 0 })
  })

  it('does not replace a successful mirror after malformed append or failed durable write', async () => {
    const path = await transcript()
    let rejectWrites = false
    const { service } = await mount({}, { beforePut: async table => { if (rejectWrites && table === 'conversations') throw new Error('disk unavailable') } })
    await finish(service)
    const old = await service.read(REF, { limit: 20 })
    await appendFile(path, '{"type":')
    expect(await finish(service)).toMatchObject({ status: 'failed', failed: 1 })
    expect((await service.read(REF, { limit: 20 })).revision).toBe(old.revision)
    await transcript('session', { answer: 'replacement body' })
    rejectWrites = true
    expect(await finish(service)).toMatchObject({ status: 'failed', failed: 1, error: expect.stringContaining('disk unavailable') })
    expect((await service.read(REF, { limit: 20 })).revision).toBe(old.revision)
  })

  it('detects a source changing during projection and retains the earlier mirror', async () => {
    const path = await transcript()
    const { service } = await mount()
    await finish(service)
    const old = await service.read(REF, { limit: 20 })
    const flush = claudeCodeAdapter.flush
    let appended = false
    vi.spyOn(claudeCodeAdapter, 'flush').mockImplementation((state, options) => {
      if (!appended) { appended = true; appendFileSync(path, encode(question('appended during import'))) }
      return flush(state, options)
    })
    expect(await finish(service, 'full')).toMatchObject({ status: 'failed', error: expect.stringContaining('changed during import') })
    expect((await service.read(REF, { limit: 20 })).revision).toBe(old.revision)
  })

  it('retains root identity when a same-named file appears in a different configured root', async () => {
    const firstPath = await transcript()
    const other = join(directory, 'other-root')
    await mkdir(other)
    await writeFile(join(other, 'session.jsonl'), encode(question('different conversation'), answer('different answer')))
    const { service } = await mount({ extraRoots: [{ kind: 'claude-code', path: transcripts }, { kind: 'claude-code', path: other }] })
    expect(await finish(service)).toMatchObject({ status: 'partial', imported: 1, error: expect.stringContaining('same local agent reference id') })
    await rm(firstPath)
    expect(await finish(service)).toMatchObject({ status: 'failed', error: expect.stringContaining('different configured root') })
    expect((await service.read(REF, { limit: 20 })).body.items[0]?.text).toBe('question session')
  })

  it('awaits an in-flight write before closing domains during teardown', async () => {
    await transcript()
    let started!: () => void
    let release!: () => void
    let closes = 0
    const began = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const { service, dispose } = await mount({}, {
      beforePut: async table => { if (table === 'conversations') { started(); await gate } },
      closed: () => { closes++ },
    })
    const id = service.sync.start(['claude-code'], 'full')
    await began
    const stopping = dispose()
    await Promise.resolve()
    expect(closes).toBe(0)
    release()
    await stopping
    expect(closes).toBe(2)
    expect(service.sync.status(id)?.status).toBe('cancelled')
  })
})

describe('history import budgets', () => {
  it('imports a record larger than the interactive line limit without dropping it', async () => {
    const path = join(transcripts, 'large.jsonl')
    const text = 'x'.repeat(1024 * 1024 + 100)
    const body = encode(question(text), answer('done'))
    await writeFile(path, body)
    const result = await readForImport(path, Buffer.byteLength(body), claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, undefined)
    expect(result.turns[0]?.text).toBe(text)
    expect(result.partial).toBe(false)
  })

  it('fails explicitly at record and projected text budgets instead of returning truncated success', async () => {
    const path = await transcript()
    await expect(readForImport(path, 100, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, undefined, undefined, {
      ...IMPORT_LIMITS, maxLineBytes: 10,
    })).rejects.toMatchObject({ code: 'REFERENCE_TRANSCRIPT_TOO_LARGE' })
    await expect(readForImport(path, 100, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, undefined, undefined, {
      ...IMPORT_LIMITS, maxTextBytes: 10,
    })).rejects.toMatchObject({ code: 'REFERENCE_TRANSCRIPT_TOO_LARGE' })
  })

  it('cancels jobs and rejects overlapping runs without losing completed copies', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const manager = new AgentHistorySyncManager({
      enabled: () => new Set(['claude-code']),
      scan: async () => { await gate; return { entries: [], partial: false } },
      import: async () => ({ imported: true, partial: false }),
    })
    const id = manager.start(['claude-code'], 'full')
    expect(() => manager.start(['claude-code'], 'full')).toThrow(/already running/u)
    expect(manager.cancel(id)).toBe(true)
    release()
    await manager.dispose()
    expect(manager.status(id)?.status).toBe('cancelled')
  })
})
