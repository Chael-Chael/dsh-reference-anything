/**
 * Read-only smoke test against whatever transcripts this machine actually has.
 *
 * Every other suite runs on synthetic fixtures, which cannot answer the two
 * questions that made this feature hard: whether the probe recovers a title
 * from records far larger than any window, and whether a multi-gigabyte
 * rollout reads without being materialized. Both were measured from real
 * corpora, so both are checked against real corpora.
 *
 * Opt-in via `DSH_AGENT_CORPUS=1`, because it depends on files the developer
 * happens to have, takes seconds rather than milliseconds, and is not the same
 * twice. It never writes: the storage domain is in memory and the transcripts
 * are only ever opened for reading.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import * as localAgent from '../src/sources/local-agent/index.ts'
import type { Config } from '../src/sources/local-agent/index.ts'

class Table<V> implements KvTable<string, V> {
  private readonly data = new Map<string, V>()
  get(key: string): V | undefined { return this.data.get(key) }
  entries(): IterableIterator<[string, V]> { return new Map(this.data).entries() }
  keys(): IterableIterator<string> { return new Map(this.data).keys() }
  get size(): number { return this.data.size }
  async put(key: string, value: V): Promise<void> { this.data.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.data.delete(key) }
  async update(key: string, fn: (value: V) => V): Promise<V> {
    const next = fn(this.data.get(key)!)
    this.data.set(key, next)
    return next
  }
}

function memoryStorage(): { open(spec: DomainSpec): Promise<Domain<DomainSpec>> } {
  const tables = new Map<string, Table<unknown>>()
  return {
    open(spec: DomainSpec) {
      return Promise.resolve({
        name: spec.name,
        table(name: string) {
          let table = tables.get(name)
          if (table === undefined) { table = new Table(); tables.set(name, table) }
          return table
        },
        async close() { /* nothing to release */ },
      } as unknown as Domain<DomainSpec>)
    },
  }
}

async function mount(over: Config = {}): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  ctx.provide('storageDomain', memoryStorage())
  await ctx.plugin(ReferenceRuntime, {})
  const fiber = await ctx.plugin(localAgent, { scope: 'all', ...over })
  return { ctx, dispose: () => fiber.dispose() }
}

/** Every file below a root, so the largest one can be found without the source. */
async function walk(dir: string): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile()) out.push({ path, size: (await stat(path)).size })
    }
  }
  return out
}

const home = homedir()
const enabled = process.env['DSH_AGENT_CORPUS'] === '1'

describe.skipIf(!enabled)('real corpora on this machine', () => {
  it('reports what it found, so a run that proves nothing says so', async () => {
    for (const [kind, root] of [['claude-code', join(home, '.claude', 'projects')], ['codex', join(home, '.codex', 'sessions')]] as const) {
      const files = await walk(root)
      const bytes = files.reduce((sum, file) => sum + file.size, 0)
      const largest = files.reduce((max, file) => file.size > max ? file.size : max, 0)
      console.log(`${kind}: ${files.length} files, ${(bytes / 1e6).toFixed(0)} MB, largest ${(largest / 1e6).toFixed(1)} MB`)
      expect(files.length).toBeGreaterThan(0)
    }
  })

  it('lists a whole corpus within the @-menu latency budget on a warm cache', async () => {
    const { ctx, dispose } = await mount({ maxTranscripts: 200, directoryTtlMs: 30_000 })
    // The cold call pays for the directory walk and the title backfill; the
    // menu only ever sees the warm one, which is what the budget is about.
    const cold = Date.now()
    const first = await ctx.references.list('', 50)
    const coldMs = Date.now() - cold
    const warm = Date.now()
    const second = await ctx.references.list('', 50)
    const warmMs = Date.now() - warm
    console.log(`list: cold ${coldMs} ms, warm ${warmMs} ms, ${first.length} candidates`)
    expect(first.length).toBeGreaterThan(0)
    expect(second.length).toBe(first.length)
    expect(warmMs).toBeLessThan(300)
    await dispose()
  })

  it('recovers real titles for a whole corpus once the backfill has caught up', async () => {
    // The regression this exists for: one 4 MB record inside a Codex rollout
    // means a fixed-byte window captures no complete line, and the whole
    // format silently degrades to basename labels. The probe escalates past
    // that — but only for the files one `list()` is willing to probe, so this
    // also pins the other half of the design: the rest are picked up by the
    // calls that follow, and a bookmark once written is never re-probed.
    const { ctx, dispose } = await mount({ agents: ['codex'], maxTranscripts: 60, directoryTtlMs: 30_000 })
    const rates: number[] = []
    for (let call = 0; call < 4; call += 1) {
      const rows = await ctx.references.list('', 60)
      rates.push(rows.filter(row => !/^rollout-/u.test(row.label.trim())).length / Math.max(1, rows.length))
    }
    console.log(`codex titles by call: ${rates.map(rate => `${Math.round(rate * 100)}%`).join(' → ')}`)
    // The first call is capped and is *expected* to leave rows unlabelled.
    expect(rates[0]).toBeGreaterThan(0)
    expect(rates.at(-1)).toBeGreaterThan(0.9)
    await dispose()
  })

  it('reads the largest transcript on the machine without materializing it', async () => {
    const files = [...await walk(join(home, '.codex', 'sessions')), ...await walk(join(home, '.claude', 'projects'))]
    const largest = files.sort((a, b) => b.size - a.size)[0]
    if (largest === undefined) return
    const kind = largest.path.includes('.codex') ? 'codex' : 'claude-code'
    const root = kind === 'codex' ? join(home, '.codex', 'sessions') : join(home, '.claude', 'projects')
    const id = `${kind}:${largest.path.slice(root.length + 1)}`
    const { ctx, dispose } = await mount({ agents: [kind], directoryTtlMs: 30_000 })
    global.gc?.()
    const before = process.memoryUsage().heapUsed
    const started = Date.now()
    const snapshot = await ctx.references.read({ source: 'local-agent', id }, { limit: 20 })
    const elapsed = Date.now() - started
    const grew = process.memoryUsage().heapUsed - before
    const chars = snapshot.body.items.reduce((sum, item) => sum + item.text.length, 0)
    console.log(`read ${(largest.size / 1e6).toFixed(0)} MB: ${elapsed} ms, heap +${(grew / 1e6).toFixed(1)} MB, ${snapshot.body.items.length} turns, ${chars} chars, partial=${snapshot.partial}`)
    expect(snapshot.body.items.length).toBeGreaterThan(0)
    // Past `maxScanBytes` the read is anchored to the tail, so it must say so
    // rather than presenting the last page as the whole conversation.
    expect(snapshot.partial).toBe(true)
    expect(snapshot.body.hasOlder).toBe(true)
    expect(snapshot.body.nextCursor).toBeTypeOf('string')
    // A page is bounded by `limit`, so neither the heap nor the projected text
    // may track the file size. Merging makes the second bound the sharper one:
    // an assistant run has no record count of its own, and 32 MiB of elided
    // tool calls fold into a single item.
    expect(grew).toBeLessThan(Math.max(64e6, largest.size / 4))
    expect(chars).toBeLessThan(2e6)
    await dispose()
  })
})
