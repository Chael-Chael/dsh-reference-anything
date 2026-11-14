import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, symlink, readFile, mkdir } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ReferenceRuntime from '../src/index.ts'
import * as mention from '../src/reference-prestep.ts'
import * as tool from '../src/tool.ts'
import { encodeLocalLocator, localLocatorId, type LocalLocator } from '../src/local-locator.ts'
import { formatReferenceMention } from '../src/uri.ts'
import { loadLocalReference } from '../src/local-reference.ts'
import { localIdForTarget, localReferencePlugin } from '../src/sources/local-agent/reference.ts'
import { decodeLocalId, encodeLocalId, nameDefaultRoots, type LocalRoot } from '../src/sources/local-agent/ids.ts'
import { readAllText, referenceBytes } from '../src/reference-source.ts'
import { ALL_LOCAL_AGENTS } from '../src/wire.ts'

let mentionFiber: { dispose(): Promise<void> }
let toolFiber: { dispose(): Promise<void> }
let prefs: { enabledAgents: string[]; agentDirectories: Record<string, string> }
let roots: LocalRoot[]
let items: Array<{ locator: LocalLocator; label: string; updatedAt?: number; cwd?: string }>
let warnings: string[]
let root: string, ctx: Context, locator: LocalLocator, agent: Agent, raw: string
const id = 'codex:sample.jsonl'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDxkAAAAASUVORK5CYII='
const message = (role: string, text: string, image = false) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }, ...(image ? [{ type: 'input_image', image_url: `data:image/png;base64,${png}` }] : [])] } })
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-reference-'))
  locator = { source: 'codex', path: join(root, 'sample.jsonl'), sessionId: 'sample' }
  raw = lines({ type: 'session_meta', payload: { id: 'sample' } }, message('user', 'What color is this?', true),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"file":"test"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'secret tool output' } }, message('assistant', 'It is red.'))
  await writeFile(locator.path, raw)
  ctx = new Context()
  await ctx.plugin(ReferenceRuntime, {})
  prefs = { enabledAgents: [...ALL_LOCAL_AGENTS], agentDirectories: {} }
  roots = [{ path: root }]
  items = [{ locator, label: 'Color', updatedAt: 1 }]
  warnings = []
  ctx.provide('referenceLocalAgents', {
    preferences: { get: () => prefs },
    namedRoots: () => roots,
    referenceDirectory: async () => ({ items: items.map(item => ({ ref: { source: 'local-agent', id: localLocatorId(item.locator) }, label: item.label,
      ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}), ...(item.cwd ? { cwd: item.cwd } : {}) })), warnings }),
    discoveryPolicy: () => ({ roots: roots.map(row => ({ kind: 'codex', path: row.path })), scope: 'all' }),
  })
  ctx.references.registerPlugin(localReferencePlugin(ctx))
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  toolFiber = await ctx.plugin(tool, {})
  mentionFiber = await ctx.plugin(mention, {})
  ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }) })
  agent = { session: Session.create(SessionId('local-test')), options: { provider: 'test', model: 'test' } } as Agent
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const text = (result: { content: readonly { type: string; text?: string }[] }) => result.content.filter(row => row.type === 'text').map(row => row.text).join('\n')
const grant = (value = id) => ctx.references.grantPlugin(String(agent.session.id), 'local', value)
const call = (args: unknown) => ctx.tools.execute({ agent, signal: new AbortController().signal, callId: 't' as never, name: 'reference', arguments: JSON.parse(JSON.stringify(args)) })
const unwrap = (result: Awaited<ReturnType<typeof call>>): any => { expect(result.isError, text(result)).not.toBe(true); return result.value }
const failure = (result: Awaited<ReturnType<typeof call>>) => { expect(result.isError).toBe(true); return JSON.parse(text(result).replace(/^Error: /u, '')) }
const read = (args: Record<string, unknown> = {}, target = id) => call({ source: 'local', id: target, op: 'read', args })
const prompt = (target = locator, label = 'Color') => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: formatReferenceMention({ source: 'local-agent', id: localLocatorId(target) }, label) + ' Keep this question.' }] })
const step = async (messages: import('@deepseek-ai/dsh-llm').UserMessage[] = [prompt()]) => {
  const result = await ctx.waterfall('agent/pre-step', { agent, messages, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages }))
  if (result.kind !== 'enter') throw Error('rejected')
  return result.messages
}
const body = (message: any) => JSON.parse(text(message).split('<references>')[1]!.split('</references>')[0]!)

it('encodes local ids reversibly without user names or absolute paths', () => {
  expect(encodeLocalId({ agent: 'codex', relPath: '2026/11/13/rollout-a.jsonl', sessionId: 'uuid-1' })).toBe('codex:2026/11/13/rollout-a.jsonl#uuid-1')
  expect(encodeLocalId({ agent: 'kimi', root: 'kimi-code', relPath: 'a/b.jsonl', sessionId: 'b' })).toBe('kimi@kimi-code:a/b.jsonl')
  expect(encodeLocalId({ agent: 'opencode', relPath: 'opencode.db', sessionId: 'ses_abc123' })).toBe('opencode:opencode.db#ses_abc123')
  expect(decodeLocalId('codex@custom:x%23y.jsonl#s%23t')).toEqual({ agent: 'codex', root: 'custom', relPath: 'x#y.jsonl', sessionId: 's#t' })
  for (const bad of ['nobody:x.jsonl', 'codex:../x.jsonl', 'codex:/etc/x', 'codex:C:/x', 'codex@Bad:x', 'codex:chat-import:abc', 'codex:x#']) expect(decodeLocalId(bad)).toBeUndefined()
  expect(nameDefaultRoots(['/h/.kimi/sessions', '/h/.kimi-code/sessions']).map(row => row.name)).toEqual([undefined, 'kimi-code'])
  expect(nameDefaultRoots(['/h/.codex/sessions', '/h/.codex/archived_sessions']).map(row => row.name)).toEqual([undefined, 'archived-sessions'])
  const issued = localIdForTarget(ctx, 'codex', locator.path, 'sample')!
  expect(issued).toBe(id)
  expect(issued).not.toContain(userInfo().username)
  expect(issued).not.toContain(root)
})

it('reads 118 messages continuously with next and a single canonical body', async () => {
  grant()
  await writeFile(locator.path, lines({ type: 'session_meta', payload: { id: 'sample' } }, ...Array.from({ length: 118 }, (_, i) => message('user', `message ${i + 1}`))))
  const ids: number[] = []
  let next: string | undefined
  do {
    const result = await read({ limit: 50, ...(next ? { next } : {}) })
    const page = unwrap(result)
    ids.push(...page.content.map((item: any) => item.n)); next = page.next ?? undefined
    expect(Object.keys(page).sort()).toEqual(['as', 'content', 'id', 'next', 'source', 'title', 'total'])
    expect(body(result)).toEqual(page)
  } while (next)
  expect(ids).toEqual(Array.from({ length: 118 }, (_, i) => i + 1))
})

it('rechecks the Agent switch for read, search, children, files and @ previews', async () => {
  grant()
  prefs.enabledAgents = ['codex']
  expect(unwrap(await read()).content.length).toBeGreaterThan(0)
  for (const disable of [() => { prefs.enabledAgents = [] }, () => { prefs.enabledAgents = ['claude-code'] }]) {
    disable()
    for (const args of [{ source: 'local', id, op: 'read' }, { source: 'local', id: `${id}>tools`, op: 'read' }, { source: 'local', id, op: 'search', args: { query: 'color' } },
      { source: 'local', id, op: 'list' }, { source: 'local', id: `${id}>1`, op: 'read', args: { as: 'image' } }, { source: 'local', op: 'list', args: { agent: 'codex' } }]) {
      expect(failure(await call(args)).code).toBe('SOURCE_DISABLED')
    }
    expect(body((await step())[1]).references[0].error.code).toBe('SOURCE_DISABLED')
  }
  prefs.enabledAgents = ['codex']
  expect(unwrap(await read()).content.length).toBeGreaterThan(0)
})

it.each(['copilot-cli', 'copilot-vscode', 'doubao'])('reads %s through the reference tool and enforces its switch', async source => {
  const file = source === 'doubao' ? 'doubao.leveldb-log' : source + (source === 'copilot-cli' ? '.jsonl' : '.json')
  const path = source === 'doubao' ? join(root, 'chrome_doubao-chat_0.indexeddb.leveldb') : join(root, file)
  if (source === 'doubao') await mkdir(path)
  await writeFile(source === 'doubao' ? join(path, '000001.log') : path, await readFile(resolve('tests/fixtures/chat-import-reader', file)))
  const target = { source, path, sessionId: source === 'doubao' ? 'conv-1' : source === 'copilot-cli' ? '11111111-2222-3333-4444-555555555555' : 'copilot-example' }
  prefs.enabledAgents = [source]
  ctx.referenceLocalAgents.discoveryPolicy = () => ({ roots: [{ kind: source, path: root }], scope: 'all' }) as never
  const local = localIdForTarget(ctx, source, path, target.sessionId)!
  expect(local.startsWith(`${source}:`)).toBe(true)
  grant(local)
  expect(unwrap(await read({}, local)).content.length).toBeGreaterThan(0)
  prefs.enabledAgents = []
  expect(failure(await read({}, local)).code).toBe('SOURCE_DISABLED')
})

it('lists images and tool records as children and returns image pixels with a file path', async () => {
  grant()
  const page = unwrap(await read())
  expect(page.content[0]).toMatchObject({ n: 1, role: 'user', children: true })
  expect(JSON.stringify(page)).not.toContain('secret tool output')
  const children = unwrap(await call({ source: 'local', id, op: 'list' })).items
  expect(children).toEqual([{ source: 'local', id: `${id}>1`, title: 'image 1', kind: 'image', size: Math.floor(png.length * 3 / 4) },
    { source: 'local', id: `${id}>tools`, title: 'Tool calls and results (2)', kind: 'text' }])
  const tools = unwrap(await read({}, `${id}>tools`)).content
  expect(tools.map((row: any) => row.text)).toEqual(['[call read_file] {"file":"test"}', '[result] secret tool output'])
  const saveImage = vi.fn(async () => ({ attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', width: 1, height: 1, bytes: 68 }))
  ctx.provide('attachments', { saveImage })
  const result = await read({ as: 'image' }, `${id}>1`)
  const saved = unwrap(result)
  expect(result.content.some(block => block.type === 'image')).toBe(true)
  expect(saved.localPath).toMatch(/attachment-image/)
  expect(saveImage).toHaveBeenCalledWith({ data: Buffer.from(png, 'base64'), mediaType: 'image/png', name: 'image' })
})

it('reads from the start after the session grows, and only an old position reports REVISION_CHANGED', async () => {
  grant()
  const first = unwrap(await read({ limit: 1 }))
  const hit = unwrap(await call({ source: 'local', id, op: 'search', args: { query: 'red' } })).hits[0]
  await writeFile(locator.path, raw + JSON.stringify(message('user', 'one more')) + '\n')
  expect(unwrap(await read()).content.at(-1).text).toBe('one more')
  for (const args of [{ next: first.next }, hit.args]) expect(failure(await read(args))).toMatchObject({ code: 'REVISION_CHANGED', retry: 'restart' })
})

it('rejects wrong args and the fields of the old protocol', async () => {
  grant()
  for (const args of [{ part: 'tools' }, { from: { messageId: 2 } }, { revision: 'x' }, { maxItems: 5 }, { limit: 101 }, { next: 'garbage' }, { as: 'video' }, { agent: 'codex' }]) {
    const result = await read(args)
    expect(result.isError).toBe(true)
    // The tool runtime rejects schema violations itself; everything else is the tool's INVALID_ARGS.
    expect(text(result)).toMatch(/INVALID_ARGS|invalid ar/u)
  }
})

it('preserves all Unicode text across bounded pages and never loops', async () => {
  const content = '中文🌏<references>\\"\n'.repeat(800)
  await writeFile(locator.path, lines({ type: 'session_meta', payload: { id: 'sample' } }, message('user', content), message('assistant', 'END')))
  const restored = await readAllText(localReferencePlugin(ctx), id, { budget: 900, signal: new AbortController().signal, cwd: root })
  expect(restored).toEqual([content.replace(/\n$/u, ''), 'END'].map((value, index) => index === 0 ? restored[0] : value))
  const doc = await loadLocalReference(ctx, agent, locator)
  expect(restored[0]).toBe(doc.messages[0]!.text)
})

it('searches case-sensitively, starts reads at hits and pages hits without gaps', async () => {
  grant()
  await writeFile(locator.path, lines({ type: 'session_meta', payload: { id: 'sample' } }, ...Array.from({ length: 8 }, (_, i) => message('user', '🌏中文 needle ' + i + '中'.repeat(200)))))
  const seen: number[] = []
  let next: string | undefined
  do {
    const page = unwrap(await call({ source: 'local', id, op: 'search', args: { query: 'needle', limit: 2, ...(next ? { next } : {}) } }))
    for (const hit of page.hits) seen.push(unwrap(await read({ ...hit.args, limit: 1 })).content[0].n)
    expect(page.hits[0].excerpt).toContain('needle')
    next = page.next ?? undefined
  } while (next)
  expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect(unwrap(await call({ source: 'local', id, op: 'search', args: { query: 'NEEDLE' } })).hits).toEqual([])
  const match = unwrap(await call({ source: 'local', id, op: 'search', args: { query: 'needle', limit: 1 } })).hits[0]
  expect(unwrap(await read({ ...match.args, limit: 1 })).content[0]).toMatchObject({ offset: 4, text: expect.stringMatching(/^needle/u) })
  await writeFile(locator.path, raw)
  expect(unwrap(await call({ source: 'local', id, op: 'search', args: { query: 'secret tool output' } })).hits).toEqual([])
  expect(unwrap(await call({ source: 'local', id: `${id}>tools`, op: 'search', args: { query: 'secret tool output' } })).hits).toHaveLength(1)
})

it('marks source summaries and previews only a continuous tail', async () => {
  grant()
  await writeFile(locator.path, lines({ type: 'session_meta', payload: { id: 'sample' } }, message('user', 'Before'), { type: 'compacted', payload: { message: 'Checkpoint summary' } }, message('assistant', 'After')))
  expect(unwrap(await read()).content.find((row: any) => row.role === 'summary')?.text).toContain('Checkpoint summary')
  await writeFile(locator.path, lines({ type: 'session_meta', payload: { id: 'sample' } }, ...Array.from({ length: 8 }, () => message('user', '中文正文'.repeat(2000)))))
  const preview = await localReferencePlugin(ctx).preview!(id, 3000, { budget: 3000, signal: new AbortController().signal, cwd: root })
  expect(referenceBytes(preview)).toBeLessThanOrEqual(3000)
  expect(preview.content.map(row => row.n)).toEqual([8])
  expect(preview.total).toBe(8)
})

it('previews @ mentions with the local id, grants them, aggregates and does not recurse on replay', async () => {
  const a = prompt(), b = prompt(locator, 'Again')
  const messages = await step([a, b])
  expect(messages).toHaveLength(4); expect(messages[0]?.id).toBe(a.id); expect(messages[2]?.id).toBe(b.id)
  const first = body(messages[1])
  expect(first.references[0]).toMatchObject({ source: 'local', id, title: 'Color' })
  expect(first.references[0].content[0].text).toContain('What color')
  expect(first.sources[0]).toMatchObject({ source: 'local', usage: expect.stringContaining('Local Agent sessions') })
  expect(text(messages[1]!)).not.toContain('secret tool output')
  expect(text(messages[1]!)).not.toContain(root)
  expect(unwrap(await read()).content.length).toBeGreaterThan(0)
  expect(await step([messages[1]!])).toHaveLength(1)
  const combined = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: text(a) + ' ' + text(a) }] })
  expect(body((await step([combined]))[1]).references).toHaveLength(1)
})

it('accepts the older local wire formats from history and from the model', async () => {
  const uri = encodeLocalLocator(locator)
  const fromUri = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `see @[Color](${uri})` }] })
  expect(body((await step([fromUri]))[1]).references[0]).toMatchObject({ source: 'local', id })
  const fresh = Session.create(SessionId('legacy-history'))
  vi.spyOn(fresh, 'snapshotEvents').mockReturnValue([{ type: 'user/message', data: prompt() }] as never)
  agent = { ...agent, session: fresh } as Agent
  expect(unwrap(await read()).content.length).toBeGreaterThan(0)
  const legacy = unwrap(await call({ source: 'local:codex', op: 'read', args: { path: locator.path, sessionId: 'sample' } }))
  expect(legacy).toMatchObject({ source: 'local', id })
})

it('shares one batch budget and gives guidance without bodies when capacity is unknown', async () => {
  await mentionFiber.dispose(); mentionFiber = await ctx.plugin(mention, { maxTextBytes: 5000 })
  await writeFile(locator.path, lines({ type: 'session_meta', payload: { id: 'sample' } }, message('user', '中文🌏'.repeat(4000))))
  const messages = await step([prompt(), prompt()])
  expect([messages[1], messages[3]].reduce((sum, row) => sum + Buffer.byteLength(text(row!)), 0)).toBeLessThanOrEqual(5000)
  expect(body(messages[1]).references[0].content.length).toBeGreaterThan(0)
  ctx.llm.resolveModelInfo = async () => ({ id: 'test', provider: 'test', name: 'test' }) as never
  const delayed = body((await step())[1]).references[0]
  expect(delayed).toHaveProperty('notice'); expect(delayed).not.toHaveProperty('content')
})

it('retains path and identity guards and rejects symlink escapes', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'outside-reference-'))
  try {
    const file = join(outside, 'other.jsonl'); await writeFile(file, raw)
    await expect(loadLocalReference(ctx, agent, { ...locator, path: file })).rejects.toThrow('outside the allowed')
    const link = join(root, 'escape'); await symlink(outside, link, 'junction')
    await expect(loadLocalReference(ctx, agent, { ...locator, path: join(link, 'other.jsonl') })).rejects.toThrow('outside the allowed')
    await expect(loadLocalReference(ctx, agent, { ...locator, sessionId: 'forged' })).rejects.toThrow()
    grant('codex:escape/other.jsonl#sample')
    expect(failure(await read({}, 'codex:escape/other.jsonl#sample')).code).toBe('UNAUTHORIZED')
  } finally { await rm(outside, { recursive: true, force: true }) }
})

it('lists local ids by metadata, newest first, filters by agent and restarts when the listing changes', async () => {
  const other = { ...locator, path: join(root, 'other.jsonl'), sessionId: 'other' }
  await writeFile(other.path, raw.replaceAll('sample', 'other'))
  items = [{ locator, label: 'Color', updatedAt: 1 }, { locator: other, label: 'Other', updatedAt: 2 }]
  const first = unwrap(await call({ source: 'local', op: 'list', args: { limit: 1 } }))
  expect(first.items).toEqual([{ source: 'local', id: 'codex:other.jsonl', title: 'Other', kind: 'codex', updatedAt: 2 }])
  expect(JSON.stringify(first)).not.toContain(root)
  expect(unwrap(await call({ source: 'local', op: 'list', args: { next: first.next } })).items[0].id).toBe(id)
  expect(unwrap(await call({ source: 'local', op: 'list', args: { query: 'color' } })).items).toEqual([])
  expect(unwrap(await call({ source: 'local', op: 'list', args: { agent: 'claude-code' } })).items).toHaveLength(2)
  items = [{ locator, label: 'Color', updatedAt: 1 }]
  expect(failure(await call({ source: 'local', op: 'list', args: { next: first.next } }))).toMatchObject({ code: 'REVISION_CHANGED', retry: 'relist' })
  const titles = unwrap(await call({ source: 'local', op: 'search', args: { query: 'Color' } }))
  expect(titles.hits).toEqual([{ source: 'local', id, args: {}, title: 'Color' }])
})

it('reads a session of the same working directory without an @, and no other', async () => {
  expect(failure(await read()).code).toBe('UNAUTHORIZED')
  items = [{ locator, label: 'Color', cwd: join(root, 'elsewhere') }]
  expect(failure(await read()).code).toBe('UNAUTHORIZED')
  items = [{ locator, label: 'Color', cwd: process.cwd() }]
  expect(unwrap(await read()).content.length).toBeGreaterThan(0)
})

it('finds an id only in its named scan location and falls back only to the same session', async () => {
  const custom = join(root, 'custom-dir'), archived = join(root, 'archived')
  await mkdir(custom); await mkdir(archived)
  await writeFile(join(custom, 'sample.jsonl'), raw.replace('What color is this?', 'Custom copy'))
  await writeFile(join(archived, 'other.jsonl'), raw.replaceAll('sample', 'other'))
  roots = [{ path: join(root, 'default-dir') }, { name: 'custom', path: custom }, { name: 'archived', path: archived }]
  await mkdir(roots[0]!.path)
  await writeFile(join(roots[0]!.path, 'sample.jsonl'), raw)
  // The same relative path in two locations: the id names which one.
  for (const [value, expected] of [['codex:sample.jsonl', 'What color'], ['codex@custom:sample.jsonl', 'Custom copy']] as const) {
    grant(value)
    expect(unwrap(await read({}, value)).content[0].text).toContain(expected)
  }
  // Ids are issued from the default location first.
  expect(localIdForTarget(ctx, 'codex', join(custom, 'sample.jsonl'), 'sample')).toBe('codex@custom:sample.jsonl')
  // The custom directory moved: its references follow it.
  const moved = join(root, 'moved'); await mkdir(moved)
  await writeFile(join(moved, 'sample.jsonl'), raw.replace('What color is this?', 'Moved copy'))
  roots = [roots[0]!, { name: 'custom', path: moved }, roots[2]!]
  expect(unwrap(await read({}, 'codex@custom:sample.jsonl')).content[0].text).toContain('Moved copy')
  // A file missing from its named location is found elsewhere only when it is the same session.
  await rm(join(moved, 'sample.jsonl'))
  expect(unwrap(await read({}, 'codex@custom:sample.jsonl')).content[0].text).toContain('What color')
  grant('codex@archived:sample.jsonl#other')
  await writeFile(join(roots[0]!.path, 'other.jsonl'), raw.replaceAll('sample', 'impostor'))
  await rm(join(archived, 'other.jsonl'))
  expect(failure(await read({}, 'codex@archived:sample.jsonl#other')).code).toBe('NOT_FOUND')
  // A removed location is a clear error.
  roots = [roots[0]!]
  grant('codex@gone:sample.jsonl')
  const gone = failure(await read({}, 'codex@gone:sample.jsonl'))
  expect(gone).toMatchObject({ code: 'NOT_FOUND', retry: 'relist', message: expect.stringContaining('"gone"') })
})

it('respects host post-execute rejection', async () => {
  grant()
  ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'Blocked by host policy' }] }))
  const result = await read(); expect(result.isError).toBe(true); expect(text(result)).toContain('Blocked by host policy')
})

it('does not expand quoted code references and aborts preparation without publishing', async () => {
  const code = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '```text\n' + text(prompt()) + '\n```' }] })
  expect(await step([code])).toEqual([code])
  const controller = new AbortController(); ctx.llm.resolveModelInfo = async () => { controller.abort(); throw Error('cancelled') }
  const messages = [prompt()]
  await expect(ctx.waterfall('agent/pre-step', { agent, messages, turn: 1, step: 1, signal: controller.signal }, async () => ({ kind: 'enter' as const, messages }))).rejects.toThrow()
})

it('reports partial list failures and budgets search results without dropping hits', async () => {
  grant()
  warnings = ['claude: unavailable']
  expect(unwrap(await call({ source: 'local', op: 'list' })).notice).toContain('claude')
  await toolFiber.dispose(); toolFiber = await ctx.plugin(tool, { maxTextBytes: 1400 })
  await writeFile(locator.path, lines({ type: 'session_meta', payload: { id: 'sample' } }, ...Array.from({ length: 6 }, () => message('user', '中'.repeat(100) + 'needle' + '文'.repeat(100)))))
  const ids: number[] = []
  let next: string | undefined
  do {
    const result = await call({ source: 'local', id, op: 'search', args: { query: 'needle', limit: 50, ...(next ? { next } : {}) } })
    const page = unwrap(result)
    expect(referenceBytes(page)).toBeLessThanOrEqual(1400)
    for (const hit of page.hits) ids.push(unwrap(await read({ ...hit.args, limit: 1 })).content[0].n)
    next = page.next ?? undefined
  } while (next)
  expect(ids).toEqual([1, 2, 3, 4, 5, 6])
})
