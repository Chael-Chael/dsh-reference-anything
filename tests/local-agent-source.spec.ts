import { appendFile, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import * as localAgent from '../src/sources/local-agent/index.ts'
import { LOCAL_AGENT_SOURCE_ID, referenceId } from '../src/sources/local-agent/index.ts'
import type { Config } from '../src/sources/local-agent/index.ts'
import type { ReferenceSnapshot } from '../src/types.ts'
import { encodeReferenceUri } from '../src/uri.ts'

/** Wide enough for every fixture here; clamping has its own test. */
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

/**
 * A storage facility backed by maps.
 *
 * The real one needs a storage hub and a backend, neither of which is a
 * dependency of this package. What these tests need from it is only that a
 * bookmark written during `list()` is visible to the next call.
 */
function memoryStorage(): { open(spec: DomainSpec): Promise<Domain<DomainSpec>> } {
  const open = new Set<string>()
  return {
    open(spec: DomainSpec) {
      if (open.has(spec.name)) throw new Error(`already-open: ${spec.name}`)
      open.add(spec.name)
      const tables = new Map<string, Table<unknown>>()
      return Promise.resolve({
        name: spec.name,
        table(name: string) {
          let table = tables.get(name)
          if (table === undefined) { table = new Table(); tables.set(name, table) }
          return table
        },
        async close() { open.delete(spec.name) },
      } as unknown as Domain<DomainSpec>)
    },
  }
}

let root: string
let outside: string
let claudeRoot: string
let codexRoot: string

/** A Claude Code session: `pairs` exchanges, then the title record it re-emits. */
function claudeTranscript(pairs: number, options: { cwd: string; title?: string }): string {
  const lines: string[] = []
  for (let index = 0; index < pairs; index += 1) {
    lines.push(JSON.stringify({
      type: 'user',
      cwd: options.cwd,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      message: { role: 'user', content: `prompt ${index}` },
    }))
    // Two records for one reply, so the merge rule is exercised by every fixture.
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `reply ${index}` }] },
    }))
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    }))
  }
  if (options.title !== undefined) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: options.title }))
  return `${lines.join('\n')}\n`
}

/** A Codex rollout with its session_meta header. */
function codexTranscript(pairs: number, options: { cwd: string; prompt: string }): string {
  const lines = [JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'session_meta',
    payload: { cwd: options.cwd, timestamp: '2026-01-01T00:00:00.000Z' },
  })]
  for (let index = 0; index < pairs; index += 1) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: index === 0 ? options.prompt : `follow up ${index}` }] },
    }))
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `codex reply ${index}` }] },
    }))
  }
  return `${lines.join('\n')}\n`
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-root-'))
  outside = await mkdtemp(join(tmpdir(), 'dsh-agent-outside-'))
  claudeRoot = join(root, 'claude')
  codexRoot = join(root, 'codex')
  await mkdir(join(claudeRoot, 'project-a'), { recursive: true })
  await mkdir(codexRoot, { recursive: true })
  await writeFile(
    join(claudeRoot, 'project-a', 'session.jsonl'),
    claudeTranscript(3, { cwd: '/w/app', title: 'Cache design' }),
    'utf8',
  )
  await writeFile(
    join(codexRoot, 'rollout-1.jsonl'),
    codexTranscript(2, { cwd: '/w/app', prompt: 'wire up the parser' }),
    'utf8',
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

/**
 * Mount the runtime and the source over the fixture roots.
 *
 * `agents: []` is deliberate: the defaults point at the developer's own
 * `~/.claude` and `~/.codex`, and a suite that reads those is neither fast nor
 * the same twice.
 */
async function mount(over: Config = {}, enabledAgents?: readonly string[]): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  ctx.provide('storageDomain', memoryStorage())
  if (enabledAgents !== undefined) ctx.provide('referenceChatHistory', { store: { settings: { enabledAgents } } } as never)
  await ctx.plugin(ReferenceRuntime, {})
  const fiber = await ctx.plugin(localAgent, {
    agents: [],
    extraRoots: [{ kind: 'claude-code', path: claudeRoot }, { kind: 'codex', path: codexRoot }],
    directoryTtlMs: 0,
    ...over,
  })
  return { ctx, dispose: () => fiber.dispose() }
}

const CLAUDE_REF = { source: LOCAL_AGENT_SOURCE_ID, id: 'claude-code:project-a/session.jsonl' }

function texts(snapshot: ReferenceSnapshot): string[] {
  return snapshot.body.items.map(item => item.text)
}

/** The single turn the fixture's two assistant records fold into. */
function reply(index: number): string {
  return `reply ${index}\n\n[tool: Bash] {"command":"ls"}`
}

describe('discovery', () => {
  it('counts recognized conversations by Agent', async () => {
    const { ctx, dispose } = await mount()
    await expect(ctx.get('referenceLocalAgents')!.stats()).resolves.toEqual(expect.arrayContaining([
      { kind: 'claude-code', conversations: 1 },
      { kind: 'codex', conversations: 1 },
    ]))
    await dispose()
  })
  it('filters disabled kinds at the ReferenceSource boundary before applying limit', async () => {
    const { ctx, dispose } = await mount({}, ['codex'])
    const found = await ctx.references.list('', 1)
    expect(found.map(entry => entry.ref.id)).toEqual(['codex:rollout-1.jsonl'])
    // The read path intentionally remains available for a previously granted ref.
    ctx.references.grant('task-existing', CLAUDE_REF)
    await expect(ctx.references.read(CLAUDE_REF, WINDOW)).resolves.toMatchObject({ ref: CLAUDE_REF })
    await dispose()
  })
  it('lists transcripts from every configured root', async () => {
    const { ctx, dispose } = await mount()
    const found = await ctx.references.list('', 10)
    expect(found.map(entry => entry.ref.id).sort()).toEqual([
      'claude-code:project-a/session.jsonl',
      'codex:rollout-1.jsonl',
    ])
    await dispose()
  })

  it('names a Claude session by the title it wrote and a rollout by its prompt', async () => {
    const { ctx, dispose } = await mount()
    const byId = new Map((await ctx.references.list('', 10)).map(entry => [entry.ref.id, entry]))
    expect(byId.get('claude-code:project-a/session.jsonl')?.label).toBe('Cache design')
    expect(byId.get('codex:rollout-1.jsonl')?.label).toBe('wire up the parser')
    await dispose()
  })

  it('does not offer an aborted session, whose every record is CLI plumbing', async () => {
    // A window opened and immediately `/clear`ed: a caveat the CLI attributes
    // to the user, and the command record itself. Measured at 12 of 249 real
    // transcripts, and picking one could only ever fail.
    await writeFile(join(claudeRoot, 'project-a', 'cleared.jsonl'), `${[
      JSON.stringify({ type: 'mode', mode: 'normal' }),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        cwd: '/w/app',
        message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>' },
      }),
      JSON.stringify({
        type: 'user',
        cwd: '/w/app',
        message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' },
      }),
    ].join('\n')}\n`)
    const { ctx, dispose } = await mount()
    const ids = (await ctx.references.list('', 10)).map(entry => entry.ref.id)
    expect(ids).not.toContain('claude-code:project-a/cleared.jsonl')
    expect(ids).toContain('claude-code:project-a/session.jsonl')
    await dispose()
  })

  it('still offers a transcript too large for the probe to read out', async () => {
    // The filter keys on a *complete* read folding to nothing. A file whose
    // head window falls short is unknown, not empty, and hiding it would drop
    // exactly the long sessions worth referencing.
    const padding = 'x'.repeat(48 * 1024)
    await writeFile(join(claudeRoot, 'project-a', 'huge.jsonl'), `${[
      JSON.stringify({ type: 'file-history-snapshot', note: padding }),
      JSON.stringify({ type: 'user', cwd: '/w/app', message: { role: 'user', content: 'a real question' } }),
    ].join('\n')}\n`)
    const { ctx, dispose } = await mount({ maxProbeBytes: 32 * 1024 })
    const ids = (await ctx.references.list('', 10)).map(entry => entry.ref.id)
    expect(ids).toContain('claude-code:project-a/huge.jsonl')
    await dispose()
  })

  it('reports which agent wrote each transcript', async () => {
    const { ctx, dispose } = await mount()
    const providers = (await ctx.references.list('', 10)).map(entry => entry.provider).sort()
    expect(providers).toEqual(['Claude Code', 'Codex'])
    await dispose()
  })

  it('matches the query against the title and the opening prompt', async () => {
    const { ctx, dispose } = await mount()
    expect((await ctx.references.list('CACHE', 10)).map(entry => entry.ref.id)).toEqual([CLAUDE_REF.id])
    expect((await ctx.references.list('parser', 10)).map(entry => entry.ref.id)).toEqual(['codex:rollout-1.jsonl'])
    expect(await ctx.references.list('nothing like this', 10)).toEqual([])
    await dispose()
  })

  it('does not match against the conversation body', async () => {
    // `reply 0` is in both transcripts and in neither title: ranking on it
    // would mean reading every candidate on a keystroke, and would put an
    // excerpt of an unnamed conversation in front of the model.
    const { ctx, dispose } = await mount()
    expect(await ctx.references.list('reply 0', 10)).toEqual([])
    await dispose()
  })

  it('honors the limit and prefers the newest when nothing is typed', async () => {
    const { ctx, dispose } = await mount()
    const found = await ctx.references.list('', 1)
    expect(found).toHaveLength(1)
    await dispose()
  })

  it('lists only this workspace under the default scope', async () => {
    await writeFile(
      join(claudeRoot, 'project-a', 'here.jsonl'),
      claudeTranscript(1, { cwd: process.cwd(), title: 'Local work' }),
      'utf8',
    )
    const { ctx, dispose } = await mount({ scope: 'workspace' })
    expect((await ctx.references.list('', 10)).map(entry => entry.label)).toEqual(['Local work'])
    await dispose()
  })

  it('is unavailable when no configured root exists', async () => {
    const { ctx, dispose } = await mount({ extraRoots: [{ kind: 'codex', path: join(root, 'missing') }] })
    expect(await ctx.references.list('', 10)).toEqual([])
    await dispose()
  })

  it('ignores files whose name no adapter claims', async () => {
    await writeFile(join(codexRoot, 'notes.txt'), 'not a transcript', 'utf8')
    const { ctx, dispose } = await mount()
    expect(await ctx.references.list('', 10)).toHaveLength(2)
    await dispose()
  })
})

describe('reading', () => {
  it('layers tool detail per read', async () => {
    const { ctx, dispose } = await mount()
    const summary = texts(await ctx.references.read(CLAUDE_REF, { ...WINDOW, detail: 'summary' })).join('\n')
    const full = texts(await ctx.references.read(CLAUDE_REF, { ...WINDOW, detail: 'full' })).join('\n')
    expect(summary).toContain('[tool: Bash]')
    expect(summary).not.toContain('{"command":"ls"}')
    expect(full).toContain('[tool: Bash] {"command":"ls"}')
    await dispose()
  })

  it('merges an assistant run into one turn and counts turns exactly', async () => {
    const { ctx, dispose } = await mount()
    const snapshot = await ctx.references.read(CLAUDE_REF, WINDOW)
    expect(texts(snapshot)).toEqual([
      'prompt 0', reply(0),
      'prompt 1', reply(1),
      'prompt 2', reply(2),
    ])
    expect(snapshot.body).toMatchObject({ startIndex: 0, totalTurns: 6, hasOlder: false })
    expect(snapshot.body.nextCursor).toBeUndefined()
    expect(snapshot.partial).toBe(false)
    await dispose()
  })

  it('returns the newest turns and says older ones exist', async () => {
    const { ctx, dispose } = await mount()
    const snapshot = await ctx.references.read(CLAUDE_REF, { limit: 2 })
    expect(texts(snapshot)).toEqual(['prompt 2', reply(2)])
    expect(snapshot.body).toMatchObject({ startIndex: 4, totalTurns: 6, hasOlder: true })
    expect(snapshot.body.nextCursor).toEqual(expect.any(String))
    await dispose()
  })

  it('pages backwards through a cursor without skipping or repeating a turn', async () => {
    await writeFile(join(claudeRoot, 'project-a', 'long.jsonl'), claudeTranscript(12, { cwd: '/w/app' }), 'utf8')
    const ref = { source: LOCAL_AGENT_SOURCE_ID, id: 'claude-code:project-a/long.jsonl' }
    const { ctx, dispose } = await mount({ maxReadTurns: 24 })
    const collected: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 20; guard += 1) {
      const page: ReferenceSnapshot = await ctx.references.read(ref, { limit: 5, ...cursor === undefined ? {} : { cursor } })
      collected.unshift(...texts(page))
      cursor = page.body.nextCursor
      if (!page.body.hasOlder) break
    }
    const whole = await ctx.references.read(ref, { limit: 24 })
    expect(collected).toEqual(texts(whole))
    expect(new Set(collected).size).toBe(collected.length)
    await dispose()
  })

  it('honors an explicit before bound', async () => {
    const { ctx, dispose } = await mount()
    const snapshot = await ctx.references.read(CLAUDE_REF, { limit: 2, before: 2 })
    expect(texts(snapshot)).toEqual(['prompt 0', reply(0)])
    expect(snapshot.body).toMatchObject({ startIndex: 0, hasOlder: false })
    await dispose()
  })

  it('clamps the window to what the deployment allows', async () => {
    await writeFile(join(claudeRoot, 'project-a', 'long.jsonl'), claudeTranscript(12, { cwd: '/w/app' }), 'utf8')
    const ref = { source: LOCAL_AGENT_SOURCE_ID, id: 'claude-code:project-a/long.jsonl' }
    const { ctx, dispose } = await mount({ maxReadTurns: 4 })
    const snapshot = await ctx.references.read(ref, { limit: 100 })
    // Fewer items than asked for is already legal; what matters is that
    // `hasOlder` is derived from the limit actually used, not the requested one.
    expect(snapshot.body.items).toHaveLength(4)
    expect(snapshot.body).toMatchObject({ startIndex: 20, totalTurns: 24, hasOlder: true })
    await dispose()
  })

  it('projects a Codex rollout without its harness records', async () => {
    const { ctx, dispose } = await mount()
    const snapshot = await ctx.references.read({ source: LOCAL_AGENT_SOURCE_ID, id: 'codex:rollout-1.jsonl' }, WINDOW)
    expect(texts(snapshot)).toEqual(['wire up the parser', 'codex reply 0', 'follow up 1', 'codex reply 1'])
    await dispose()
  })

  it('names a transcript it has already seen, and falls back to its filename otherwise', async () => {
    const { ctx, dispose } = await mount()
    expect((await ctx.references.read(CLAUDE_REF, WINDOW)).label).toBe('session.jsonl')
    await ctx.references.list('', 10)
    expect((await ctx.references.read(CLAUDE_REF, WINDOW)).label).toBe('Cache design')
    await dispose()
  })
})

describe('cursor lifetime', () => {
  it('survives an append, because appending moves no turn a cursor names', async () => {
    const { ctx, dispose } = await mount()
    const first = await ctx.references.read(CLAUDE_REF, { limit: 2 })
    const cursor = first.body.nextCursor!
    await appendFile(join(claudeRoot, 'project-a', 'session.jsonl'), `${JSON.stringify({
      type: 'user', cwd: '/w/app', message: { role: 'user', content: 'prompt 3' },
    })}\n`, 'utf8')
    const older = await ctx.references.read(CLAUDE_REF, { limit: 2, cursor })
    expect(texts(older)).toEqual(['prompt 1', reply(1)])
    await dispose()
  })

  it('expires once the file has shrunk under it', async () => {
    const path = join(claudeRoot, 'project-a', 'session.jsonl')
    const { ctx, dispose } = await mount()
    const first = await ctx.references.read(CLAUDE_REF, { limit: 2 })
    const cursor = first.body.nextCursor!
    await truncate(path, 200)
    await expect(ctx.references.read(CLAUDE_REF, { limit: 2, cursor }))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_CURSOR_EXPIRED' }))
    await dispose()
  })

  it('refuses a cursor minted for a different transcript', async () => {
    const { ctx, dispose } = await mount()
    const borrowed = (await ctx.references.read(CLAUDE_REF, { limit: 2 })).body.nextCursor!
    await expect(ctx.references.read({ source: LOCAL_AGENT_SOURCE_ID, id: 'codex:rollout-1.jsonl' }, { limit: 2, cursor: borrowed }))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_INVALID_CURSOR' }))
    await dispose()
  })

  it('refuses a cursor that is not one', async () => {
    const { ctx, dispose } = await mount()
    await expect(ctx.references.read(CLAUDE_REF, { limit: 2, cursor: 'not-a-cursor' }))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_INVALID_CURSOR' }))
    await dispose()
  })
})

describe('addressing', () => {
  it('names a missing transcript rather than returning an empty conversation', async () => {
    const { ctx, dispose } = await mount()
    await expect(ctx.references.read({ source: LOCAL_AGENT_SOURCE_ID, id: 'claude-code:nope.jsonl' }, WINDOW))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }))
    await dispose()
  })

  it.each([['no kind', 'session.jsonl'], ['an unknown kind', 'cursor:session.jsonl'], ['no path', 'codex:']])(
    'rejects an id with %s',
    async (_label, id) => {
      const { ctx, dispose } = await mount()
      await expect(ctx.references.read({ source: LOCAL_AGENT_SOURCE_ID, id }, WINDOW))
        .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }))
      await dispose()
    },
  )

  it('refuses to escape a root with .. segments', async () => {
    await writeFile(join(outside, 'secret.jsonl'), claudeTranscript(1, { cwd: '/w/app' }), 'utf8')
    const { ctx, dispose } = await mount()
    await expect(ctx.references.read({ source: LOCAL_AGENT_SOURCE_ID, id: `claude-code:../../${join(outside, 'secret.jsonl')}` }, WINDOW))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }))
    await dispose()
  })

  it('refuses to follow a symlink pointing outside a root', async ({ skip }) => {
    await writeFile(join(outside, 'secret.jsonl'), claudeTranscript(1, { cwd: '/w/app' }), 'utf8')
    try {
      await symlink(join(outside, 'secret.jsonl'), join(claudeRoot, 'link.jsonl'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') skip()
      throw error
    }
    // Containment is decided on the resolved real path, so a link inside the
    // root cannot smuggle in a transcript from outside it.
    const { ctx, dispose } = await mount()
    await expect(ctx.references.read({ source: LOCAL_AGENT_SOURCE_ID, id: 'claude-code:link.jsonl' }, WINDOW))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }))
    await dispose()
  })

  it('round-trips a reference id through its two halves', () => {
    expect(referenceId('codex', join('2026', '01', 'rollout.jsonl'))).toBe('codex:2026/01/rollout.jsonl')
  })

  it('fails loudly on a file that parses to nothing', async () => {
    await writeFile(join(codexRoot, 'junk.jsonl'), 'not json\nalso not json\n', 'utf8')
    const { ctx, dispose } = await mount()
    // An empty success is indistinguishable from a broken reader, and the
    // model would answer as though the session had said nothing.
    await expect(ctx.references.read({ source: LOCAL_AGENT_SOURCE_ID, id: 'codex:junk.jsonl' }, WINDOW))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }))
    await dispose()
  })
})

describe('as a mounted plugin', () => {
  it('needs a grant before the model may read a transcript', async () => {
    const { ctx, dispose } = await mount()
    expect(() => ctx.references.assertGranted('task-a', CLAUDE_REF))
      .toThrow(expect.objectContaining({ code: 'CONVERSATION_REFERENCE_NOT_GRANTED' }))
    ctx.references.grant('task-a', CLAUDE_REF)
    expect(() => ctx.references.assertGranted('task-a', CLAUDE_REF)).not.toThrow()
    await dispose()
  })

  it('recovers a grant from a URI mentioned in durable task history', async () => {
    const { ctx, dispose } = await mount()
    const session = Session.create(SessionId('task-history'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `read ${encodeReferenceUri(CLAUDE_REF)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const restored = Session.create(session.id, session.snapshotEvents())
    expect(() => ctx.references.assertSessionGranted(restored, CLAUDE_REF)).not.toThrow()
    expect(() => ctx.references.assertGranted('task-history', CLAUDE_REF)).not.toThrow()
    await dispose()
  })

  it('recovers a grant from a URI returned by a tool', async () => {
    const { ctx, dispose } = await mount()
    const session = Session.create(SessionId('task-tool-result'))
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('reference-list'), isError: false,
        content: [{ type: 'text', text: encodeReferenceUri(CLAUDE_REF) }],
      }),
    }, { surfaceOp: 'append' })
    expect(() => ctx.references.assertSessionGranted(session, CLAUDE_REF)).not.toThrow()
    await dispose()
  })

  it('rejects an unmentioned reference in a real session without granting access', async () => {
    const { ctx, dispose } = await mount()
    const session = Session.create(SessionId('task-no-grant'))
    expect(() => ctx.references.assertSessionGranted(session, CLAUDE_REF))
      .toThrow(expect.objectContaining({ code: 'CONVERSATION_REFERENCE_NOT_GRANTED' }))
    await dispose()
  })

  it('unregisters with its fiber', async () => {
    const { ctx, dispose } = await mount()
    expect(ctx.references.sourceIds()).toContain(LOCAL_AGENT_SOURCE_ID)
    await dispose()
    expect(ctx.references.sourceIds()).not.toContain(LOCAL_AGENT_SOURCE_ID)
  })

  it('refuses to mount with nowhere to look instead of resolving nothing', async () => {
    const ctx = new Context()
    ctx.provide('storageDomain', memoryStorage())
    await ctx.plugin(ReferenceRuntime, {})
    await expect(ctx.plugin(localAgent, { agents: [], extraRoots: [] })).rejects.toThrow(/agents|extraRoots/u)
  })
})
