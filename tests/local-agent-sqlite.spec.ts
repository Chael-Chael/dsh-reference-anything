/**
 * The three database-backed formats, against real SQLite files.
 *
 * Every other adapter is exercised by handing its converter an array of lines,
 * because that is exactly what the line-local seam consumes. These three answer
 * to queries instead, so a fixture that stubbed the reader would be testing the
 * stub: the interesting behaviour is which columns exist, what the `ORDER BY`
 * returns, and how a schema one column short degrades. So the fixtures here are
 * genuine databases written with `node:sqlite`, built to the schemas extracted
 * from opencode, mimocode, and zcode.
 *
 * None of the three is installed on the machine this was written on, which is
 * the honest limit of this suite: it pins the adapters against the schema as
 * documented, not against a corpus.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import { COMPACTION_MARKER } from '../src/sources/local-agent/adapters/shared.ts'
import { isBackgroundSession } from '../src/sources/local-agent/adapters/opencode.ts'
import * as localAgent from '../src/sources/local-agent/index.ts'
import { LOCAL_AGENT_SOURCE_ID, splitSession } from '../src/sources/local-agent/index.ts'
import type { Config } from '../src/sources/local-agent/index.ts'
import type { ReferenceSnapshot } from '../src/types.ts'

/** Wide enough for every fixture here; clamping has its own test elsewhere. */
const WINDOW = { limit: 100 }

/** In-memory stand-in for one domain table. */
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

/** A storage facility backed by maps; these tests only need it to exist. */
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
        async close() {},
      } as unknown as Domain<DomainSpec>)
    },
  }
}

/** Epoch milliseconds, past the second/millisecond threshold `parseTimestamp` uses. */
const T0 = 1_760_000_000_000

/** One `session` row, with only the fields these adapters read. */
interface SessionSpec {
  readonly id: string
  readonly title: string
  readonly directory?: string
  readonly created?: number
  readonly updated?: number
  /** Present only when the fixture declares a `parent_id` column. */
  readonly parent?: string
}

/** One `message` row and the `part` rows beneath it. */
interface MessageSpec {
  readonly id: string
  readonly session: string
  /** Merged into the message's JSON payload; `role` belongs here. */
  readonly data: Record<string, unknown>
  readonly parts?: readonly Record<string, unknown>[]
  /** Written verbatim into `data` instead of JSON, for the malformed-row cases. */
  readonly raw?: string
  /** Part payloads written verbatim, same purpose. */
  readonly rawParts?: readonly string[]
}

/** What columns the fixture's `session` table has beyond the universal ones. */
interface Shape {
  readonly parentId?: boolean
  /** Whether `time_updated` exists; when it does not, adapters fall back to `time_created`. */
  readonly updated?: boolean
}

/**
 * Write a database matching the schema all three agents share.
 * @param path - where to create it.
 * @param spec - the rows, and which optional columns to declare.
 */
function writeDatabase(path: string, spec: {
  shape?: Shape
  sessions: readonly SessionSpec[]
  messages?: readonly MessageSpec[]
}): void {
  const shape = { updated: true, ...spec.shape }
  const db = new DatabaseSync(path)
  try {
    const columns = [
      'id TEXT PRIMARY KEY',
      'title TEXT',
      'directory TEXT',
      'time_created INTEGER',
      ...shape.updated === false ? [] : ['time_updated INTEGER'],
      ...shape.parentId === true ? ['parent_id TEXT'] : [],
    ]
    db.exec(`CREATE TABLE session (${columns.join(', ')})`)
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)')

    for (const [index, session] of spec.sessions.entries()) {
      const created = session.created ?? T0 + index * 1000
      const values: (string | number | null)[] = [
        session.id,
        session.title,
        session.directory ?? '',
        created,
        ...shape.updated === false ? [] : [session.updated ?? created],
        ...shape.parentId === true ? [session.parent ?? null] : [],
      ]
      db.prepare(`INSERT INTO session VALUES (${values.map(() => '?').join(', ')})`).run(...values)
    }

    let partId = 0
    for (const [index, message] of (spec.messages ?? []).entries()) {
      const at = T0 + index * 1000
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
        .run(message.id, message.session, at, message.raw ?? JSON.stringify(message.data))
      const payloads = [
        ...(message.parts ?? []).map(part => JSON.stringify(part)),
        ...message.rawParts ?? [],
      ]
      for (const payload of payloads) {
        db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(`p${++partId}`, message.id, partId, payload)
      }
    }
  } finally {
    db.close()
  }
}

/** A user message carrying one text part, which is the only shape that yields a turn. */
function user(id: string, session: string, text: string): MessageSpec {
  return { id, session, data: { role: 'user' }, parts: [{ type: 'text', text }] }
}

/** An assistant message and its parts, verbatim. */
function assistant(
  id: string,
  session: string,
  parts: readonly Record<string, unknown>[],
  data: Record<string, unknown> = {},
): MessageSpec {
  return { id, session, data: { role: 'assistant', ...data }, parts }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-sqlite-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * Mount the runtime over one database root.
 * @param kind - which of the three formats the root holds.
 * @param over - configuration overrides for the case under test.
 * @returns the context and a teardown.
 */
async function mount(
  kind: 'opencode' | 'mimocode' | 'zcode',
  over: Config = {},
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  ctx.provide('storageDomain', memoryStorage())
  await ctx.plugin(ReferenceRuntime, {})
  const fiber = await ctx.plugin(localAgent, {
    agents: [],
    extraRoots: [{ kind, path: root }],
    scope: 'all',
    directoryTtlMs: 0,
    ...over,
  })
  return { ctx, dispose: () => fiber.dispose() }
}

/** The reference id for one conversation inside one database. */
function ref(kind: string, file: string, session: string): { source: string; id: string } {
  return { source: LOCAL_AGENT_SOURCE_ID, id: `${kind}:${file}#${session}` }
}

function turns(snapshot: ReferenceSnapshot): { role: string; text: string }[] {
  return snapshot.body.items.map(item => ({ role: item.role, text: item.text }))
}

describe('discovery', () => {
  it('offers one candidate per conversation, newest first', async () => {
    writeDatabase(join(root, 'opencode.db'), {
      sessions: [
        { id: 'ses_old', title: 'Cache design', updated: T0 + 1000 },
        { id: 'ses_new', title: 'Parser rewrite', updated: T0 + 9000 },
      ],
    })
    const { ctx, dispose } = await mount('opencode')
    const found = await ctx.references.list('', 10)
    expect(found.map(entry => entry.ref.id)).toEqual([
      'opencode:opencode.db#ses_new',
      'opencode:opencode.db#ses_old',
    ])
    expect(found.map(entry => entry.label)).toEqual(['Parser rewrite', 'Cache design'])
    expect(found[0]?.provider).toBe('opencode')
    await dispose()
  })

  it('orders by the session’s own recency, not the file’s', async () => {
    // Every session in one database shares a file mtime, so ordering on it
    // would leave the menu in whatever order the rows happened to come back in.
    writeDatabase(join(root, 'opencode.db'), {
      sessions: [
        { id: 'a', title: 'first', updated: T0 + 1 },
        { id: 'b', title: 'second', updated: T0 + 2 },
        { id: 'c', title: 'third', updated: T0 + 3 },
      ],
    })
    const { ctx, dispose } = await mount('opencode')
    const found = await ctx.references.list('', 10)
    expect(found.map(entry => entry.updatedAt)).toEqual([T0 + 3, T0 + 2, T0 + 1])
    await dispose()
  })

  it('falls back to time_created on a build with no time_updated column', async () => {
    writeDatabase(join(root, 'opencode.db'), {
      shape: { updated: false },
      sessions: [
        { id: 'a', title: 'older', created: T0 + 1000 },
        { id: 'b', title: 'newer', created: T0 + 5000 },
      ],
    })
    const { ctx, dispose } = await mount('opencode')
    expect((await ctx.references.list('', 10)).map(entry => entry.label)).toEqual(['newer', 'older'])
    await dispose()
  })

  it('ignores the write-ahead log and shared-memory files beside the database', async () => {
    writeDatabase(join(root, 'opencode.db'), { sessions: [{ id: 'a', title: 'real' }] })
    await writeFile(join(root, 'opencode.db-wal'), 'not a database')
    await writeFile(join(root, 'opencode.db-shm'), 'not a database')
    const { ctx, dispose } = await mount('opencode')
    expect((await ctx.references.list('', 10)).map(entry => entry.ref.id)).toEqual(['opencode:opencode.db#a'])
    await dispose()
  })

  it('treats a file that is not a database as an empty one rather than an error', async () => {
    // A user of a different agent may well have a file by this name; it must
    // not take the whole `@` menu down.
    await writeFile(join(root, 'opencode.db'), 'plain text pretending to be SQLite')
    const { ctx, dispose } = await mount('opencode')
    await expect(ctx.references.list('', 10)).resolves.toEqual([])
    await dispose()
  })

  it('lists nothing at all when sqlite is switched off', async () => {
    writeDatabase(join(root, 'opencode.db'), { sessions: [{ id: 'a', title: 'real' }] })
    const { ctx, dispose } = await mount('opencode', { sqlite: false })
    await expect(ctx.references.list('', 10)).resolves.toEqual([])
    await dispose()
  })

  it('matches the query against the session title', async () => {
    writeDatabase(join(root, 'opencode.db'), {
      sessions: [{ id: 'a', title: 'Cache design' }, { id: 'b', title: 'Parser rewrite' }],
    })
    const { ctx, dispose } = await mount('opencode')
    expect((await ctx.references.list('CACHE', 10)).map(entry => entry.ref.id)).toEqual(['opencode:opencode.db#a'])
    expect(await ctx.references.list('nothing like this', 10)).toEqual([])
    await dispose()
  })

  it('scopes to the workspace using the directory the session recorded', async () => {
    writeDatabase(join(root, 'opencode.db'), {
      sessions: [
        { id: 'here', title: 'in the workspace', directory: '/w/app' },
        { id: 'there', title: 'somewhere else', directory: '/w/other' },
      ],
    })
    const { ctx, dispose } = await mount('opencode', { scope: 'workspace' })
    const source = ctx.get('referenceLocalAgents')!
    const found = await source.listForWorkspace('', 10, '/w/app')
    expect(found.map(entry => entry.ref.id)).toEqual(['opencode:opencode.db#here'])
    await dispose()
  })
})

describe('mimocode background sessions', () => {
  it('recognizes the titles MiMo gives its own machinery', () => {
    expect(isBackgroundSession('checkpoint-writer 42')).toBe(true)
    expect(isBackgroundSession('  Checkpoint_Writer run')).toBe(true)
    expect(isBackgroundSession('auto-dream nightly')).toBe(true)
    expect(isBackgroundSession('auto distill')).toBe(true)
    expect(isBackgroundSession('checkpointing the parser')).toBe(false)
    expect(isBackgroundSession('Write a checkpoint')).toBe(false)
  })

  it('keeps them out of the menu, over-fetching until enough real ones survive', async () => {
    const sessions: SessionSpec[] = []
    for (let index = 0; index < 40; index += 1) {
      sessions.push({ id: `bg${index}`, title: `checkpoint-writer ${index}`, updated: T0 + 1000 + index })
    }
    // Oldest of all, so only over-fetching past the background traffic reaches it.
    sessions.push({ id: 'real', title: 'Fix the tokenizer', updated: T0 })
    writeDatabase(join(root, 'mimocode.db'), { sessions })
    const { ctx, dispose } = await mount('mimocode')
    expect((await ctx.references.list('', 10)).map(entry => entry.ref.id)).toEqual(['mimocode:mimocode.db#real'])
    await dispose()
  })

  it('does not filter the same titles out of opencode, which has no such traffic', async () => {
    writeDatabase(join(root, 'opencode.db'), { sessions: [{ id: 'a', title: 'checkpoint-writer 1' }] })
    const { ctx, dispose } = await mount('opencode')
    expect((await ctx.references.list('', 10)).map(entry => entry.ref.id)).toEqual(['opencode:opencode.db#a'])
    await dispose()
  })
})

describe('reading a conversation', () => {
  /** One session with every part type the projection has an opinion about. */
  function conversation(): void {
    writeDatabase(join(root, 'opencode.db'), {
      sessions: [{ id: 'ses_a', title: 'Cache design', directory: '/w/app' }],
      messages: [
        user('m01', 'ses_a', 'how does the cache work?'),
        assistant('m02', 'ses_a', [
          { type: 'text', text: 'It memoizes by key.' },
          { type: 'tool', tool: 'Bash', state: { input: { command: 'ls' } } },
        ]),
        user('m03', 'ses_a', 'and eviction?'),
        assistant('m04', 'ses_a', [
          { type: 'reasoning', text: 'weighing LRU against LFU' },
          { type: 'text', text: 'LRU.' },
        ]),
      ],
    })
  }

  it('folds messages and parts into alternating turns', async () => {
    conversation()
    const { ctx, dispose } = await mount('opencode')
    const snapshot = await ctx.references.read(ref('opencode', 'opencode.db', 'ses_a'), WINDOW)
    expect(turns(snapshot)).toEqual([
      { role: 'user', text: 'how does the cache work?' },
      { role: 'assistant', text: 'It memoizes by key.\n\n[tool: Bash]' },
      { role: 'user', text: 'and eviction?' },
      { role: 'assistant', text: 'LRU.' },
    ])
    expect(snapshot.body.totalTurns).toBe(4)
    expect(snapshot.body.hasOlder).toBe(false)
    expect(snapshot.partial).toBe(false)
    expect(snapshot.label).toBe('Cache design')
    await dispose()
  })

  it('includes reasoning parts only when asked', async () => {
    conversation()
    const { ctx, dispose } = await mount('opencode', { includeThinking: true })
    const snapshot = await ctx.references.read(ref('opencode', 'opencode.db', 'ses_a'), WINDOW)
    expect(turns(snapshot).at(-1)?.text).toBe('weighing LRU against LFU\n\nLRU.')
    await dispose()
  })

  it('strips harness material injected through the user role', async () => {
    // These agents append reminders to a real question rather than sending
    // them separately, so the same stripping the JSONL formats get applies.
    writeDatabase(join(root, 'opencode.db'), {
      sessions: [{ id: 's', title: 'Injected' }],
      messages: [
        user('m01', 's', 'what changed?\n<system-reminder>do not mention this</system-reminder>'),
        assistant('m02', 's', [{ type: 'text', text: 'the parser' }]),
      ],
    })
    const { ctx, dispose } = await mount('opencode')
    const snapshot = await ctx.references.read(ref('opencode', 'opencode.db', 's'), WINDOW)
    expect(turns(snapshot)[0]).toEqual({ role: 'user', text: 'what changed?' })
    expect(JSON.stringify(snapshot)).not.toContain('system-reminder')
    await dispose()
  })

  it('pages backwards through the conversation', async () => {
    conversation()
    const { ctx, dispose } = await mount('opencode')
    const tail = await ctx.references.read(ref('opencode', 'opencode.db', 'ses_a'), { limit: 2 })
    expect(turns(tail).map(turn => turn.text)).toEqual(['and eviction?', 'LRU.'])
    expect(tail.body.startIndex).toBe(2)
    expect(tail.body.hasOlder).toBe(true)
    const head = await ctx.references.read(ref('opencode', 'opencode.db', 'ses_a'), { limit: 2, before: 2 })
    expect(turns(head).map(turn => turn.text)).toEqual(['how does the cache work?', 'It memoizes by key.\n\n[tool: Bash]'])
    expect(head.body.hasOlder).toBe(false)
    await dispose()
  })

  it('reads past a row whose payload is not JSON', async () => {
    writeDatabase(join(root, 'opencode.db'), {
      sessions: [{ id: 's', title: 'Dirty' }],
      messages: [
        user('m01', 's', 'first'),
        { id: 'm02', session: 's', data: {}, raw: '{not json at all' },
        { id: 'm03', session: 's', data: { role: 'assistant' }, rawParts: ['also not json'] },
        user('m04', 's', 'second'),
      ],
    })
    const { ctx, dispose } = await mount('opencode')
    const snapshot = await ctx.references.read(ref('opencode', 'opencode.db', 's'), WINDOW)
    expect(turns(snapshot)).toEqual([
      { role: 'user', text: 'first' },
      { role: 'user', text: 'second' },
    ])
    await dispose()
  })

  it('keeps only the newest messages once the record cap is reached, and says so', async () => {
    conversation()
    const { ctx, dispose } = await mount('opencode', { maxSessionRecords: 2 })
    const snapshot = await ctx.references.read(ref('opencode', 'opencode.db', 'ses_a'), WINDOW)
    expect(turns(snapshot)).toEqual([
      { role: 'user', text: 'and eviction?' },
      { role: 'assistant', text: 'LRU.' },
    ])
    // A capped read never saw the beginning, so it may not claim a total.
    expect(snapshot.body.totalTurns).toBeUndefined()
    expect(snapshot.body.hasOlder).toBe(true)
    expect(snapshot.partial).toBe(true)
    await dispose()
  })
})

describe('opencode compaction', () => {
  /** A session the agent compacted, with the discarded turns still in the table. */
  function compacted(tailStart: string): void {
    writeDatabase(join(root, 'opencode.db'), {
      sessions: [{ id: 'c', title: 'Long session' }],
      messages: [
        user('m01', 'c', 'the original question'),
        assistant('m02', 'c', [{ type: 'text', text: 'the original answer' }]),
        assistant('m03', 'c', [
          { type: 'text', text: 'Earlier: we designed the cache.' },
          { type: 'compaction', tail_start_id: tailStart },
        ], { mode: 'compaction' }),
        user('m04', 'c', 'what next?'),
        assistant('m05', 'c', [{ type: 'text', text: 'ship it' }]),
      ],
    })
  }

  it('replaces the discarded turns with the summary that stands for them', async () => {
    compacted('m04')
    const { ctx, dispose } = await mount('opencode')
    const snapshot = await ctx.references.read(ref('opencode', 'opencode.db', 'c'), WINDOW)
    expect(turns(snapshot)).toEqual([
      { role: 'assistant', text: `${COMPACTION_MARKER}\n\nEarlier: we designed the cache.` },
      { role: 'user', text: 'what next?' },
      { role: 'assistant', text: 'ship it' },
    ])
    // Turns the other agent decided to forget are turns nobody here can reach.
    expect(snapshot.partial).toBe(true)
    await dispose()
  })

  it('keeps the tail it does have when the boundary points at a message it never read', async () => {
    compacted('m99')
    const { ctx, dispose } = await mount('opencode')
    const snapshot = await ctx.references.read(ref('opencode', 'opencode.db', 'c'), WINDOW)
    expect(turns(snapshot).map(turn => turn.text)).toContain('ship it')
    expect(snapshot.partial).toBe(true)
    await dispose()
  })
})

describe('zcode', () => {
  it('hides the sessions zcode spawned for itself', async () => {
    writeDatabase(join(root, 'db.sqlite'), {
      shape: { parentId: true },
      sessions: [
        { id: 'main', title: 'Ship the router' },
        { id: 'sub', title: 'search the codebase', parent: 'main' },
      ],
    })
    const { ctx, dispose } = await mount('zcode')
    expect((await ctx.references.list('', 10)).map(entry => entry.ref.id)).toEqual(['zcode:db.sqlite#main'])
    await dispose()
  })

  it('lists everything on a build that predates the parent_id column', async () => {
    writeDatabase(join(root, 'db.sqlite'), {
      sessions: [{ id: 'a', title: 'one' }, { id: 'b', title: 'two' }],
    })
    const { ctx, dispose } = await mount('zcode')
    expect((await ctx.references.list('', 10)).map(entry => entry.ref.id).sort())
      .toEqual(['zcode:db.sqlite#a', 'zcode:db.sqlite#b'])
    await dispose()
  })

  it('drops the system prompt it stores beside the conversation', async () => {
    writeDatabase(join(root, 'db.sqlite'), {
      sessions: [{ id: 's', title: 'Zed session' }],
      messages: [
        { id: 'm01', session: 's', data: { role: 'system' }, parts: [{ type: 'text', text: 'You are zcode.' }] },
        user('m02', 's', 'hello'),
        assistant('m03', 's', [{ type: 'text', text: 'hi there' }]),
      ],
    })
    const { ctx, dispose } = await mount('zcode')
    const snapshot = await ctx.references.read(ref('zcode', 'db.sqlite', 's'), WINDOW)
    expect(turns(snapshot)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ])
    expect(snapshot.partial).toBe(false)
    await dispose()
  })

  it('recovers a summary from a compaction part while keeping the message around it', async () => {
    writeDatabase(join(root, 'db.sqlite'), {
      sessions: [{ id: 's', title: 'Part shape' }],
      messages: [
        assistant('m01', 's', [
          { type: 'compaction', summary: { body: 'Earlier we set up the repo.' } },
          { type: 'text', text: 'and now we continue' },
        ]),
        user('m02', 's', 'ok'),
      ],
    })
    const { ctx, dispose } = await mount('zcode')
    const snapshot = await ctx.references.read(ref('zcode', 'db.sqlite', 's'), WINDOW)
    expect(turns(snapshot)).toEqual([
      { role: 'assistant', text: `${COMPACTION_MARKER}\n\nEarlier we set up the repo.` },
      { role: 'assistant', text: 'and now we continue' },
      { role: 'user', text: 'ok' },
    ])
    expect(snapshot.partial).toBe(true)
    await dispose()
  })

  it('drops the whole message when an older build hung the summary on it', async () => {
    writeDatabase(join(root, 'db.sqlite'), {
      sessions: [{ id: 's', title: 'Message shape' }],
      messages: [
        user('m01', 's', 'first'),
        assistant('m02', 's',
          [{ type: 'text', text: 'lead-in that should vanish' }],
          { summary: { body: 'Summary of the earlier session.' } }),
        user('m03', 's', 'second'),
      ],
    })
    const { ctx, dispose } = await mount('zcode')
    const snapshot = await ctx.references.read(ref('zcode', 'db.sqlite', 's'), WINDOW)
    expect(turns(snapshot)).toEqual([
      { role: 'assistant', text: `${COMPACTION_MARKER}\n\nSummary of the earlier session.` },
      { role: 'user', text: 'first' },
      { role: 'user', text: 'second' },
    ])
    await dispose()
  })

  it('keeps the newest summary when a session was compacted twice', async () => {
    // An older summary describes history the newer one has already folded in.
    writeDatabase(join(root, 'db.sqlite'), {
      sessions: [{ id: 's', title: 'Twice' }],
      messages: [
        assistant('m01', 's', [{ type: 'compaction', summary: { body: 'the first summary' } }]),
        user('m02', 's', 'carry on'),
        assistant('m03', 's', [{ type: 'compaction', summary: { body: 'the second summary' } }]),
        user('m04', 's', 'and again'),
      ],
    })
    const { ctx, dispose } = await mount('zcode')
    const snapshot = await ctx.references.read(ref('zcode', 'db.sqlite', 's'), WINDOW)
    expect(turns(snapshot)[0]?.text).toBe(`${COMPACTION_MARKER}\n\nthe second summary`)
    expect(JSON.stringify(snapshot)).not.toContain('the first summary')
    await dispose()
  })
})

describe('reference ids', () => {
  it('splits on the last separator, so a database whose name holds one still resolves', () => {
    expect(splitSession('opencode.db#ses_a')).toEqual({ relPath: 'opencode.db', sessionId: 'ses_a' })
    expect(splitSession('backup#2/opencode.db#ses_a'))
      .toEqual({ relPath: 'backup#2/opencode.db', sessionId: 'ses_a' })
    expect(splitSession('opencode.db')).toBeUndefined()
  })

  it('round-trips the id a listing produced', async () => {
    writeDatabase(join(root, 'opencode.db'), {
      sessions: [{ id: 'ses_a', title: 'Cache design' }],
      messages: [user('m01', 'ses_a', 'a question')],
    })
    const { ctx, dispose } = await mount('opencode')
    const [entry] = await ctx.references.list('', 10)
    const snapshot = await ctx.references.read(entry!.ref, WINDOW)
    expect(turns(snapshot)).toEqual([{ role: 'user', text: 'a question' }])
    await dispose()
  })

  it('rejects an id that names a database but no conversation inside it', async () => {
    writeDatabase(join(root, 'opencode.db'), { sessions: [{ id: 'a', title: 'real' }] })
    const { ctx, dispose } = await mount('opencode')
    for (const id of ['opencode:opencode.db', 'opencode:opencode.db#']) {
      await expect(ctx.references.read({ source: LOCAL_AGENT_SOURCE_ID, id }, WINDOW))
        .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }))
    }
    await dispose()
  })

  it('rejects a conversation that is not in the database', async () => {
    writeDatabase(join(root, 'opencode.db'), { sessions: [{ id: 'a', title: 'real' }] })
    const { ctx, dispose } = await mount('opencode')
    await expect(ctx.references.read(ref('opencode', 'opencode.db', 'nope'), WINDOW))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }))
    await dispose()
  })
})
