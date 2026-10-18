import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { readLocalConversation, localConversationRoots } from '../src/local-conversation-reader.ts'
import { chatImportReference, readChatImport } from '../src/chat-import-reader.ts'
import { ALL_LOCAL_AGENTS } from '../src/wire.ts'
import { scanFormat } from '../src/chat-import-discovery.ts'
import { Worker } from 'node:worker_threads'

const dirs: string[] = []
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'reference-reader-')); dirs.push(dir); return dir }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const read = async (format: string, path: string, sessionId = 'sample') => {
  const result = await readLocalConversation({ format, path, sessionId, limit: 100, detail: 'full' })
  const structured = await readLocalConversation({ format, path, sessionId, limit: 100, detail: 'full', structured: true }) as { revision: string; messages: Array<{ number: number }> }
  expect(structured.messages.map(row => row.number)).toEqual(structured.messages.map((_, i) => i + 1))
  const again = await readLocalConversation({ format, path, sessionId, limit: 1, detail: 'summary', structured: true, revision: structured.revision }) as { revision: string }
  expect(again.revision, `${format} projection must be deterministic`).toBe(structured.revision)
  const worker = new Worker(new URL('../vendor/chat-import-reader/availability-worker.mjs', import.meta.url))
  try {
    const state = await new Promise<string>((resolve, reject) => {
      worker.once('message', value => resolve(value.state))
      worker.once('error', reject)
      worker.postMessage({ id: 'test', target: { format, path, sessionId } })
    })
    expect(state, `${format} readable content must not be hidden`).not.toBe('empty')
  } finally { await worker.terminate() }
  return result
}
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n')

it('reports missing Claude Desktop transcript bodies accurately', async () => {
  const directory = await temporary()
  const body = JSON.stringify({ sessionId: 'local_sample', cliSessionId: 'sample', transcriptUnavailable: true, title: 'Desktop chat' })
  const main = join(directory, 'local_sample.json')
  await writeFile(main, body)
  await expect(read('claude', main, 'local_sample')).rejects.toThrow('contains metadata only')
})

it('covers the scan source catalog and ships no mutation entry points', async () => {
  expect(Object.keys(localConversationRoots()).sort()).toEqual(ALL_LOCAL_AGENTS.map(scanFormat).sort())
  const bundle = await readFile(resolve('vendor/chat-import-reader/parsers.mjs'), 'utf8')
  expect(bundle).not.toMatch(/\b(?:writeFile|writeFileSync|mkdir|unlink|rename|createSession|rememberImport)\b/)
})

it.each([
  ['claude', 'sess-simple-001.jsonl'], ['codex', 'codex-simple.jsonl'], ['cursor', 'cursor-simple.jsonl'],
  ['gemini', 'gemini-simple.json'], ['reasonix', 'reasonix-v1.jsonl'], ['qoder', 'qoder-simple.jsonl'],
  ['pi', 'pi-simple.jsonl'], ['chatgpt', 'chatgpt-export.json'],
])('reads the upstream synthetic %s fixture without importing', async (format, fixture) => {
  const path = resolve('tests/fixtures/chat-import-reader', fixture)
  const before = await readFile(path)
  const page = await read(format, path, format === 'chatgpt' ? 'conv-001' : 'sample')
  expect(page).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ content: expect.any(Array) })]) })
  expect(await readFile(path)).toEqual(before)
})

it.each([
  ['antigravity', 'sample.jsonl', jsonl([{ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'hello' }, { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'reply' }])],
  ['workbuddy', 'sample.jsonl', jsonl([{ id: 'u1', type: 'message', role: 'user', sessionId: 'sample', content: [{ type: 'input_text', text: 'hello' }] }, { id: 'a1', type: 'message', role: 'assistant', sessionId: 'sample', content: [{ type: 'output_text', text: 'reply' }] }])],
  ['qwen', 'sample.jsonl', jsonl([{ type: 'user', sessionId: 'sample', humanInput: { text: 'hello', mode: 'prompt' }, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }, { type: 'assistant', sessionId: 'sample', message: { role: 'assistant', content: 'reply' } }])],
  ['continue', 'sample.json', JSON.stringify({ sessionId: 'sample', history: [{ message: { role: 'user', content: 'hello' } }, { message: { role: 'assistant', content: 'reply' } }] })],
  ['cline', 'sample.messages.json', JSON.stringify({ version: 1, sessionId: 'sample', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, { role: 'assistant', content: [{ type: 'text', text: 'reply' }] }] })],
  ['hermes', 'sample.jsonl', jsonl([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'reply' }])],
  ['openclaw', 'sample.jsonl', jsonl([{ type: 'session', id: 'sample', timestamp: '2026-01-01T00:00:00Z' }, { type: 'message', message: { role: 'user', content: 'hello' } }, { type: 'message', message: { role: 'assistant', content: 'reply' } }])],
  ['kimi', 'wire.jsonl', jsonl([{ timestamp: '2026-01-01T00:00:00Z', message: { type: 'TurnBegin', payload: { user_input: 'hello' } } }, { message: { type: 'TextPart', payload: { text: 'reply' } } }, { message: { type: 'TurnEnd', payload: {} } }])],
])('reads %s from its actual source shape', async (format, name, raw) => {
  const path = join(await temporary(), name)
  await writeFile(path, raw)
  expect(JSON.stringify(await read(format, path))).toContain('hello')
  expect(await readFile(path, 'utf8')).toBe(raw)
})

it('reads a Vibe session directory and rejects a source root', async () => {
  const root = await temporary()
  const path = join(root, 'sample'); await mkdir(path)
  await writeFile(join(path, 'meta.json'), JSON.stringify({ session_id: 'sample', title: 'Example', start_time: '2026-01-01T00:00:00Z' }))
  await writeFile(join(path, 'messages.jsonl'), jsonl([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'reply' }]))
  expect(JSON.stringify(await read('vibe', path))).toContain('hello')
  await expect(read('vibe', root)).rejects.toThrow('Select one conversation')
})

it('preserves typed Antigravity tool results and matches their tool names', async () => {
  const generated = join(await temporary(), 'brain', 'sample', '.system_generated')
  await mkdir(join(generated, 'logs'), { recursive: true })
  await mkdir(join(generated, 'messages'))
  const path = join(generated, 'logs', 'transcript.jsonl')
  await writeFile(join(generated, 'messages', 'unrelated.json'), JSON.stringify({ sourceMetadata: { tool: { stepIndex: 4 } }, content: 'unrelated background report' }))
  await writeFile(join(generated, 'messages', 'generic.json'), JSON.stringify({ sourceMetadata: { tool: { stepIndex: 12 } }, content: 'generic full output' }))
  await writeFile(path, jsonl([
    { step_index: 0, type: 'USER_INPUT', content: 'inspect the project' },
    { step_index: 1, type: 'PLANNER_RESPONSE', content: 'Inspecting', tool_calls: [
      { name: 'view_file', args: { AbsolutePath: '/work/main.ts' } },
      { name: 'list_dir', args: { DirectoryPath: '/work' } },
      { name: 'run_command', args: { CommandLine: 'build' } },
    ] },
    { step_index: 2, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'not a tool result' },
    { step_index: 3, type: 'RUN_COMMAND', status: 'RUNNING', content: 'started' },
    { step_index: 4, type: 'LIST_DIRECTORY', status: 'DONE', content: 'main.ts directory entry' },
    { step_index: 5, type: 'VIEW_FILE', status: 'DONE', content: 'export const answer = 42' },
    { step_index: 6, type: 'RUN_COMMAND', status: 'DONE', content: 'build succeeded' },
    { step_index: 7, type: 'PLANNER_RESPONSE', content: 'Editing', tool_calls: [
      { name: 'replace_file_content', args: {} }, { name: 'invoke_subagent', args: {} }, { name: 'grep_search', args: {} },
    ] },
    { step_index: 8, type: 'CODE_ACTION', status: 'DONE', content: 'edit applied' },
    { step_index: 9, type: 'INVOKE_SUBAGENT', status: 'DONE', content: 'subagent findings' },
    { step_index: 10, type: 'GREP_SEARCH', status: 'DONE', content: 'match at line 1' },
    { step_index: 11, type: 'PLANNER_RESPONSE', content: 'Waiting', tool_calls: [{ name: 'custom_tool', args: {} }] },
    { step_index: 12, type: 'GENERIC', status: 'DONE', content: 'generic output' },
    { step_index: 13, type: 'PLANNER_RESPONSE', content: 'Pending', tool_calls: [{ name: 'view_file', args: {} }] },
  ]))
  const result = await readLocalConversation({ format: 'antigravity', path, sessionId: 'sample', limit: 100, detail: 'full', structured: true }) as { tools: Array<{ kind: string; text: string }> }
  expect(result.tools.filter(t => t.kind === 'result').map(t => t.text)).toEqual([
    'export const answer = 42', 'main.ts directory entry', 'build succeeded',
    'edit applied', 'subagent findings', 'match at line 1', 'generic full output',
    '(no output captured — background task, result not in transcript)',
  ])
})

it.each(['opencode', 'mimocode', 'kilocode', 'teleagent', 'zcode'])('isolates the selected %s database conversation', async format => {
  const path = join(await temporary(), 'sessions.db')
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, model TEXT, parent_id TEXT, time_updated INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);')
    for (const id of ['one', 'two']) {
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, NULL, ?)').run(id, id, '/work', 1700000000000, '{}', 1700000000000)
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, id, 1700000000000, '{"role":"user"}')
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(id, id, id, 1700000000000, JSON.stringify({ type: 'text', text: `hello-${id}` }))
    }
  } finally { db.close() }
  const before = await readFile(path)
  const out = await read(format, path, 'two')
  expect(JSON.stringify(out)).toContain('hello-two')
  expect(JSON.stringify(out)).not.toContain('hello-one')
  await expect(read(format, path, 'missing')).rejects.toThrow('could not be read')
  expect(await readFile(path)).toEqual(before)
})

it('reads Grok Build session directories', async () => {
  const path = await temporary()
  await writeFile(join(path, 'summary.json'), JSON.stringify({ id: 'sample', title: 'Example', cwd: path }))
  await writeFile(join(path, 'chat_history.jsonl'), jsonl([{ type: 'user', content: 'hello' }, { type: 'assistant', content: 'reply' }]))
  expect(JSON.stringify(await read('grokbuild', path))).toContain('hello')
})

it.each(['goose', 'crush', 'zed', 'trae'])('reads a selected %s database without modifying it', async format => {
  const path = join(await temporary(), 'history.db')
  const db = new DatabaseSync(path)
  try {
    if (format === 'goose') {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, session_type TEXT, working_dir TEXT, updated_at TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER)')
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('sample', 'Example', 'user', '/work', '2026-01-01 00:00:00')
      db.prepare('INSERT INTO messages VALUES (1, ?, ?, ?, ?)').run('sample', 'user', JSON.stringify([{ type: 'text', text: 'hello' }]), 1700000000)
    } else if (format === 'crush') {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT, updated_at INTEGER, created_at INTEGER); CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, parts TEXT, created_at INTEGER)')
      db.exec('ALTER TABLE sessions ADD COLUMN summary_message_id TEXT; ALTER TABLE sessions ADD COLUMN prompt_tokens INTEGER; ALTER TABLE messages ADD COLUMN is_summary_message INTEGER; ALTER TABLE messages ADD COLUMN finished_at INTEGER; CREATE TABLE read_files (session_id TEXT, path TEXT)')
      db.prepare('INSERT INTO sessions (id, parent_session_id, title, updated_at, created_at) VALUES (?, NULL, ?, ?, ?)').run('sample', 'Example', 1700000000, 1700000000)
      db.prepare('INSERT INTO messages (id, session_id, role, parts, created_at) VALUES (?, ?, ?, ?, ?)').run('m', 'sample', 'user', JSON.stringify([{ type: 'text', data: { text: 'hello' } }]), 1700000000)
    } else if (format === 'zed') {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB)')
      const raw = JSON.stringify({ version: '0.3.0', title: 'Example', messages: [{ User: { id: 'u', content: [{ Text: 'hello' }] } }] })
      db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run('sample', 'Example', '2026-01-01T00:00:00Z', 'zstd', zstdCompressSync(raw))
    } else {
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('memento/icube-ai-agent-storage', JSON.stringify({ list: [{ sessionId: 'sample', title: 'Example', messages: [{ role: 'user', content: 'hello' }] }] }))
    }
  } finally { db.close() }
  const before = await readFile(path)
  expect(JSON.stringify(await read(format, path))).toContain('hello')
  expect(await readFile(path)).toEqual(before)
})

it.each(['dsh', 'dsh4'])('reads multi-frame compressed %s logs', async format => {
  const path = join(await temporary(), format === 'dsh' ? 'session.jsonl.zstd' : 'session.v4.jsonl.zstd')
  const records = [
    { type: 'session', id: 'sample', version: format === 'dsh4' ? 4 : 3, createdAt: 1700000000000 },
    { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1700000000000, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1700000000000, data: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant/message', seq: 3, time: 1700000000001, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } } },
    { type: 'step/end', seq: 4, data: { turn: 1, step: 1 } }, { type: 'turn/end', seq: 5, data: { turn: 1 } },
  ]
  await writeFile(path, Buffer.concat(records.map(record => zstdCompressSync(JSON.stringify(record) + '\n'))))
  expect(JSON.stringify(await read(format, path))).toContain('hello')
})

it.each(['claude', 'codex'])('reads %s image bytes with npm 0.26.1, pages them, and rejects stale cursors', async format => {
  const path = join(await temporary(), 'sample.jsonl')
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDxkAAAAASUVORK5CYII='
  const raw = jsonl(format === 'codex' ? [
    { type: 'session_meta', payload: { id: 'sample', timestamp: '2026-01-01T00:00:00Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: `data:image/png;base64,${png}` }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] } },
  ] : [
    { sessionId: 'sample', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } },
    { sessionId: 'sample', type: 'assistant', message: { role: 'assistant', content: 'reply' } },
  ])
  await writeFile(path, raw)
  const target = { format, path, sessionId: 'sample' }
  const ref = { source: 'local-agent', id: chatImportReference(target) }
  const ctx = new Context()
  const importPath = vi.fn(() => { throw new Error('must not import') })
  ctx.provide('chatImport', { importPath })
  const image = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', width: 1, height: 1, bytes: 68 }
  const saveImage = vi.fn(async () => image)
  ctx.provide('attachments', { saveImage })
  const last = await readChatImport(ctx, ref, target, { limit: 1 })
  expect(last.body.items[0]?.text).toBe('reply')
  const first = await readChatImport(ctx, ref, target, { limit: 1, detail: 'full', cursor: last.body.nextCursor })
  expect(first.body.items[0]?.images).toEqual([image])
  expect(saveImage).toHaveBeenCalledWith({ data: Buffer.from(png, 'base64'), mediaType: 'image/png' })
  expect(importPath).not.toHaveBeenCalled()
  await writeFile(path, raw.replace('look', 'changed'))
  await expect(readChatImport(ctx, ref, target, { limit: 1, cursor: last.body.nextCursor })).rejects.toThrow('changed')
  const ctrl = new AbortController(); ctrl.abort()
  await expect(readLocalConversation({ ...target, limit: 1, detail: 'full' }, ctrl.signal)).rejects.toThrow()
})


it('keeps pagination and revisions stable across summary/full, but rejects changed tool results', async () => {
  const path = join(await temporary(), 'sample.jsonl')
  const raw = jsonl([
    { type: 'session_meta', payload: { id: 'sample' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call1', name: 'read_file', arguments: '{"path":"secret-path"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call1', output: 'secret-output' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } },
  ])
  await writeFile(path, raw)
  const target = { format: 'codex', path, sessionId: 'sample' }
  const ref = { source: 'local-agent', id: chatImportReference(target) }
  const ctx = new Context()
  const summary = await readChatImport(ctx, ref, target, { limit: 1 })
  const full = await readChatImport(ctx, ref, target, { limit: 1, detail: 'full' })
  expect(summary.revision).toBe(full.revision)
  expect(summary.body).toMatchObject({ startIndex: full.body.startIndex, totalTurns: full.body.totalTurns })
  expect(summary.body.nextCursor).toBe(full.body.nextCursor)
  const olderFull = await readChatImport(ctx, ref, target, { limit: 100, detail: 'full', cursor: summary.body.nextCursor })
  const olderSummary = await readChatImport(ctx, ref, target, { limit: 100, cursor: full.body.nextCursor })
  expect(olderSummary.body.totalTurns).toBe(olderFull.body.totalTurns)
  expect(olderSummary.body.items).toHaveLength(olderFull.body.items.length)
  expect(JSON.stringify(olderFull.body.items)).toContain('secret-output')
  expect(JSON.stringify(olderFull.body.items)).toContain('secret-path')
  expect(JSON.stringify(olderSummary.body.items)).not.toContain('secret-output')
  expect(JSON.stringify(olderSummary.body.items)).not.toContain('secret-path')
  expect(olderSummary.body.hasOlder).toBe(false)
  expect(olderFull.body.items[0]?.text).toBe('question')
  expect(olderFull.body.items.at(-1)?.text).not.toBe('answer')
  await writeFile(path, raw.replace('secret-output', 'changed-output'))
  await expect(readChatImport(ctx, ref, target, { limit: 100, cursor: summary.body.nextCursor })).rejects.toThrow('changed')
})


it('keeps Vibe tool IDs generated by the converter out of source revisions', async () => {
  const root = await temporary()
  const path = root
  await writeFile(join(path, 'meta.json'), JSON.stringify({ session_id: 'sample' }))
  await writeFile(join(path, 'messages.jsonl'), jsonl([
    { role: 'user', content: 'inspect' },
    { role: 'assistant', content: 'checking', tool_calls: [{ function: { name: 'read', arguments: '{}' } }] },
  ]))
  await read('vibe', path)
})
