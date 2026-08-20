import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeCodeAdapter } from '../src/sources/local-agent/adapters/claude-code.ts'
import { codexAdapter } from '../src/sources/local-agent/adapters/codex.ts'
import { geminiCliAdapter } from '../src/sources/local-agent/adapters/gemini-cli.ts'
import { DEFAULT_CONVERT_OPTIONS } from '../src/sources/local-agent/adapters/shared.ts'
import { listTranscripts, probeEnds, readTurns } from '../src/sources/local-agent/scan.ts'
import type { AgentKind, TranscriptAdapter } from '../src/sources/local-agent/types.ts'

/** Both Tier-1 adapters, keyed the way the source assembles them. */
const ADAPTERS = new Map<AgentKind, TranscriptAdapter>([
  ['claude-code', claudeCodeAdapter],
  ['codex', codexAdapter],
])

/** Generous enough that no test here trips the ceiling by accident. */
const PROBE = { headLines: 40, tailLines: 20, maxProbeBytes: 4 * 1024 * 1024 }

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-agent-scan-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write a transcript and return what a directory scan would have learned about it. */
async function write(relPath: string, lines: readonly unknown[]): Promise<{ path: string; size: number }> {
  const path = join(dir, relPath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`)
  return { path, size: (await stat(path)).size }
}

/** A Claude user record with a string body — always a real turn. */
function userRecord(text: string): unknown {
  return { type: 'user', message: { role: 'user', content: text } }
}

describe('listTranscripts', () => {
  it('finds transcripts nested below a root', async () => {
    await write('projects/a/one.jsonl', [userRecord('one')])
    await write('projects/a/deep/two.jsonl', [userRecord('two')])
    const found = await listTranscripts([{ kind: 'claude-code', path: join(dir, 'projects') }], ADAPTERS, 10)
    expect(found.map(entry => entry.relPath).sort()).toEqual([join('a', 'deep', 'two.jsonl'), join('a', 'one.jsonl')])
  })

  it('reports size and mtime without reading the file', async () => {
    await write('p/one.jsonl', [userRecord('hello')])
    const [entry] = await listTranscripts([{ kind: 'claude-code', path: join(dir, 'p') }], ADAPTERS, 10)
    expect(entry?.size).toBeGreaterThan(0)
    expect(entry?.mtimeMs).toBeGreaterThan(0)
    expect(entry?.kind).toBe('claude-code')
  })

  it('skips files the adapter does not claim', async () => {
    await write('p/notes.txt', ['plain text'])
    await write('p/one.jsonl', [userRecord('one')])
    const found = await listTranscripts([{ kind: 'claude-code', path: join(dir, 'p') }], ADAPTERS, 10)
    expect(found.map(entry => entry.relPath)).toEqual(['one.jsonl'])
  })

  it('returns the newest first and caps at the requested count', async () => {
    await write('p/old.jsonl', [userRecord('old')])
    await new Promise(resolve => setTimeout(resolve, 12))
    await write('p/new.jsonl', [userRecord('new')])
    const found = await listTranscripts([{ kind: 'claude-code', path: join(dir, 'p') }], ADAPTERS, 1)
    expect(found.map(entry => entry.relPath)).toEqual(['new.jsonl'])
  })

  it('treats a root that does not exist as an uninstalled agent, not an error', async () => {
    await expect(listTranscripts(
      [{ kind: 'codex', path: join(dir, 'never-installed') }],
      ADAPTERS,
      10,
    )).resolves.toEqual([])
  })

  it('keeps each root’s transcripts under that root’s own agent kind', async () => {
    await write('claude/one.jsonl', [userRecord('c')])
    await write('codex/two.jsonl', [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }])
    const found = await listTranscripts([
      { kind: 'claude-code', path: join(dir, 'claude') },
      { kind: 'codex', path: join(dir, 'codex') },
    ], ADAPTERS, 10)
    expect(new Map(found.map(entry => [entry.relPath, entry.kind])))
      .toEqual(new Map([['one.jsonl', 'claude-code'], ['two.jsonl', 'codex']]))
  })
})

describe('probeEnds', () => {
  it('recovers complete records from both ends', async () => {
    const { path, size } = await write('p/one.jsonl', [userRecord('first'), userRecord('middle'), userRecord('last')])
    const { headLines, tailLines } = await probeEnds(path, size, PROBE)
    expect(JSON.parse(headLines[0] ?? '{}').message.content).toBe('first')
    expect(JSON.parse(tailLines[tailLines.length - 1] ?? '{}').message.content).toBe('last')
  })

  it('escalates past a record larger than the first probe window', async () => {
    // A 32 KiB window recovers no complete line here, which is exactly the case
    // that used to degrade a whole format to filename labels.
    const { path, size } = await write('p/big.jsonl', [
      userRecord('x'.repeat(200_000)),
      userRecord('the real question'),
    ])
    const { headLines } = await probeEnds(path, size, PROBE)
    expect(headLines.length).toBeGreaterThanOrEqual(2)
    expect(JSON.parse(headLines[1] ?? '{}').message.content).toBe('the real question')
  })

  it('gives up at maxProbeBytes rather than reading a huge file whole', async () => {
    const { path, size } = await write('p/huge.jsonl', [userRecord('y'.repeat(200_000)), userRecord('unreachable')])
    const { headLines } = await probeEnds(path, size, { ...PROBE, maxProbeBytes: 1024 })
    // One kilobyte holds no complete record, and the probe stops rather than escalating.
    expect(headLines).toEqual([])
  })

  it('keeps the last records when the tail window lands mid-record', async () => {
    const { path, size } = await write('p/tail.jsonl', [
      userRecord('z'.repeat(100_000)),
      userRecord('penultimate'),
      userRecord('final'),
    ])
    const { tailLines } = await probeEnds(path, size, PROBE)
    expect(tailLines.map(line => JSON.parse(line).message.content)).toContain('final')
    // The truncated leading record must not surface as a bogus line.
    expect(tailLines.every(line => line.trim().startsWith('{'))).toBe(true)
  })

  it('reports nothing for an empty transcript instead of failing', async () => {
    const { path } = await write('p/empty.jsonl', [])
    await expect(probeEnds(path, 0, PROBE))
      .resolves.toEqual({ headLines: [], tailLines: [], complete: true })
  })

  it('reports a small file as completely read, and returns it whole', async () => {
    // Sixty records is past `headLines`, so a clipped head would hide the tail
    // of a short session — and with it any basis for calling one empty.
    const lines = Array.from({ length: 60 }, (_, index) => ({ type: 'user', message: { role: 'user', content: `m${index}` } }))
    const { path, size } = await write('p/short.jsonl', lines)
    const ends = await probeEnds(path, size, PROBE)
    expect(ends.complete).toBe(true)
    expect(ends.headLines).toHaveLength(60)
  })

  it('does not claim completeness when the window fell short of the file', async () => {
    // One 40 KiB record pushes the file past the first probe step, so the head
    // window covers a prefix and nothing may be concluded from what it lacks.
    const lines = [{ type: 'user', message: { role: 'user', content: 'x'.repeat(40 * 1024) } },
      { type: 'user', message: { role: 'user', content: 'second' } }]
    const { path, size } = await write('p/long.jsonl', lines)
    const ends = await probeEnds(path, size, { ...PROBE, maxProbeBytes: 32 * 1024 })
    expect(ends.complete).toBe(false)
  })
})

describe('readTurns', () => {
  /** One Gemini CLI chat file, the smallest document-mode fixture there is. */
  const chat = {
    sessionId: 's1',
    startTime: '2026-08-09T13:00:00.000Z',
    directories: ['/w/app'],
    messages: [
      { type: 'user', content: 'explain the router' },
      { type: 'gemini', content: 'It maps paths to handlers.' },
    ],
  }

  it('reads a document-mode transcript whole', async () => {
    const { path, size } = await write('h/chats/s1.json', [chat])
    const page = await readTurns(
      path, size, geminiCliAdapter, DEFAULT_CONVERT_OPTIONS,
      { limit: 10 }, { maxScanBytes: 1024 * 1024, maxLineBytes: 1024 * 1024 },
    )
    expect(page.items).toEqual([
      { role: 'user', text: 'explain the router' },
      { role: 'assistant', text: 'It maps paths to handlers.' },
    ])
    expect(page.totalTurns).toBe(2)
    expect(page.anchored).toBe(false)
  })

  it('refuses an oversized document rather than folding a byte region to zero turns', async () => {
    // The tail-anchored path would hand this adapter half a JSON object, which
    // parses as nothing — and an empty page reads as "this session was empty"
    // rather than as "this file is too large to read".
    const { path, size } = await write('h/chats/big.json', [chat])
    await expect(readTurns(
      path, size, geminiCliAdapter, DEFAULT_CONVERT_OPTIONS,
      { limit: 10 }, { maxScanBytes: 32, maxLineBytes: 1024 * 1024 },
    )).rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_TRANSCRIPT_TOO_LARGE' }))
  })

  it('still anchors a line-local transcript to its tail when it is too large to scan', async () => {
    const lines = Array.from({ length: 40 }, (_, index) => userRecord(`m${index}`))
    const { path, size } = await write('p/long.jsonl', lines)
    const page = await readTurns(
      path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS,
      { limit: 3 }, { maxScanBytes: 64, maxLineBytes: 1024 * 1024 },
    )
    expect(page.anchored).toBe(true)
    expect(page.items[page.items.length - 1]).toEqual({ role: 'user', text: 'm39' })
  })
})
