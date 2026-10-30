import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { LocalConversationScanner } from '../src/local-conversation-scanner.ts'
import { ALL_LOCAL_AGENTS } from '../src/wire.ts'
import { scanFormat } from '../src/chat-import-discovery.ts'
// @ts-expect-error generated JavaScript bundle
import { FORMATS } from '../vendor/chat-import-reader/scanners.mjs'

let scanner = new LocalConversationScanner()
afterEach(() => { scanner.dispose(); scanner = new LocalConversationScanner() })

it('bundles all sources without plugin lifecycle or mutation code', async () => {
  expect([...FORMATS].sort()).toEqual(ALL_LOCAL_AGENTS.map(scanFormat).sort())
  const bundle = await readFile(resolve('vendor/chat-import-reader/scanners.mjs'), 'utf8')
  expect(bundle).not.toMatch(/\b(?:writeFile|writeFileSync|mkdir|unlink|rename|createSession|rememberImport)\b/)
})

it.each([
  ['claude', 'sess-simple-001.jsonl'], ['codex', 'codex-simple.jsonl'], ['cursor', 'cursor-simple.jsonl'],
  ['gemini', 'gemini-simple.json'], ['reasonix', 'reasonix-v1.jsonl'], ['qoder', 'qoder-simple.jsonl'],
  ['pi', 'pi-simple.jsonl'], ['chatgpt', 'chatgpt-export.json'],
  ['copilot-cli', 'copilot-cli.jsonl'], ['copilot-vscode', 'copilot-vscode.json'],
])('scans a real upstream %s fixture without Chat Import', async (format, fixture) => {
  const before = await readFile(resolve('tests/fixtures/chat-import-reader', fixture))
  const dir = await mkdtemp(join(tmpdir(), 'scan-layout-'))
  const layout: Record<string, string> = { 'copilot-vscode': 'workspaceStorage/example/chatSessions/sample.json', 'copilot-cli': 'session-state/11111111-2222-3333-4444-555555555555/events.jsonl', cursor: 'agent-transcripts/sample/sample.jsonl', gemini: 'session-sample.json', reasonix: 'desktop-sample.jsonl', qoder: '.qoder/projects/sample/qoder-simple.jsonl' }
  const path = join(dir, layout[format] ?? fixture)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, before)
    const result = await scanner.scanDiscover({ format, path })
    expect(result.warnings).toEqual([])
    expect(result.sessions.length).toBeGreaterThan(0)
    expect(result.sessions.every(row => row.format === format && row.sessionId && row.sourcePath === path && row.importStatus === undefined)).toBe(true)
    expect(await readFile(path)).toEqual(before)
    if (format.startsWith('copilot-')) expect((await scanner.scanDiscover({ format, path: dir })).sessions.length).toBeGreaterThan(0)
  } finally { await rm(dir, { recursive: true, force: true }) }

})

it('reports database corruption and treats missing roots as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reference-scan-'))
  try {
    const path = join(dir, 'opencode.db')
    await writeFile(path, 'broken database')
    expect((await scanner.scanDiscover({ format: 'opencode', path })).warnings).not.toEqual([])
    expect(await scanner.scanDiscover({ format: 'codex', path: join(dir, 'missing') })).toEqual({ sessions: [], warnings: [] })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('scans cached Doubao sessions from an IndexedDB directory without modifying it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scan-doubao-'))
  try {
    const path = join(root, 'Default', 'IndexedDB', 'chrome_doubao-chat_0.indexeddb.leveldb')
    await mkdir(path, { recursive: true })
    const raw = await readFile(resolve('tests/fixtures/chat-import-reader/doubao.leveldb-log'))
    const file = join(path, '000001.log')
    await writeFile(file, raw)
    const result = await scanner.scanDiscover({ format: 'doubao', path: root })
    expect(result.warnings).toEqual([])
    expect(result.sessions.map(row => row.sessionId).sort()).toEqual(['conv-1', 'conv-2'])
    expect(result.sessions.every(row => row.sourcePath === path)).toBe(true)
    expect(await readFile(file)).toEqual(raw)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('cancellation does not destroy another caller sharing the scan', async () => {
  const input = { format: 'codex', path: resolve('tests/fixtures/chat-import-reader/codex-simple.jsonl') }
  const controller = new AbortController()
  const cancelled = scanner.scanDiscover(input, controller.signal)
  const other = scanner.scanDiscover(input)
  controller.abort(new Error('cancelled'))
  await expect(cancelled).rejects.toThrow('cancelled')
  expect((await other).sessions.length).toBeGreaterThan(0)
})
