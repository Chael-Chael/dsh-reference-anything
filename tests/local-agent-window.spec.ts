import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeCodeAdapter } from '../src/sources/local-agent/adapters/claude-code.ts'
import { DEFAULT_CONVERT_OPTIONS } from '../src/sources/local-agent/adapters/shared.ts'
import { readTurns } from '../src/sources/local-agent/scan.ts'
import type { ParsedTurn } from '../src/sources/local-agent/types.ts'

/** Large enough that every test opting into the exact branch gets it. */
const WHOLE_FILE = { maxScanBytes: 32 * 1024 * 1024, maxLineBytes: 1024 * 1024 }

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-agent-window-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(relPath: string, lines: readonly unknown[]): Promise<{ path: string; size: number }> {
  const path = join(dir, relPath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`)
  return { path, size: (await stat(path)).size }
}

/** A transcript of `pairs` alternating user/assistant turns, numbered for identity. */
function alternating(pairs: number): unknown[] {
  const lines: unknown[] = []
  for (let index = 0; index < pairs; index += 1) {
    lines.push({ type: 'user', message: { role: 'user', content: `ask ${index}` } })
    lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: `reply ${index}` }] } })
  }
  return lines
}

/** The text of every turn, for order and identity assertions. */
function texts(items: readonly ParsedTurn[]): string[] {
  return items.map(item => item.text)
}

describe('readTurns over the whole file', () => {
  it('returns the newest turns and counts the rest exactly', async () => {
    const { path, size } = await write('t.jsonl', alternating(50))
    const page = await readTurns(path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, { limit: 4 }, WHOLE_FILE)
    expect(page.totalTurns).toBe(100)
    expect(page.startIndex).toBe(96)
    expect(page.hasOlder).toBe(true)
    expect(page.anchored).toBe(false)
    expect(texts(page.items)).toEqual(['ask 48', 'reply 48', 'ask 49', 'reply 49'])
  })

  it('pages backwards with before, without skipping or repeating a turn', async () => {
    const { path, size } = await write('t.jsonl', alternating(10))
    const seen: string[] = []
    let before: number | undefined
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await readTurns(
        path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS,
        { limit: 3, ...before === undefined ? {} : { before } }, WHOLE_FILE,
      )
      seen.unshift(...texts(page.items))
      if (!page.hasOlder) break
      before = page.startIndex
    }
    expect(seen).toEqual(texts(
      (await readTurns(path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, { limit: 100 }, WHOLE_FILE)).items,
    ))
    expect(seen).toHaveLength(20)
    expect(new Set(seen).size).toBe(20)
  })

  it('reports the first page as having nothing older', async () => {
    const { path, size } = await write('t.jsonl', alternating(3))
    const page = await readTurns(
      path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, { limit: 3, before: 3 }, WHOLE_FILE,
    )
    expect(page.startIndex).toBe(0)
    expect(page.hasOlder).toBe(false)
    expect(texts(page.items)).toEqual(['ask 0', 'reply 0', 'ask 1'])
  })

  it('holds only the window in memory across a long transcript', async () => {
    const { path, size } = await write('t.jsonl', alternating(1000))
    const page = await readTurns(path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, { limit: 2 }, WHOLE_FILE)
    expect(page.totalTurns).toBe(2000)
    expect(page.items).toHaveLength(2)
    expect(texts(page.items)).toEqual(['ask 999', 'reply 999'])
  })

  it('skips a record longer than the line cap instead of materializing it', async () => {
    const { path, size } = await write('t.jsonl', [
      { type: 'user', message: { role: 'user', content: 'q'.repeat(50_000) } },
      { type: 'user', message: { role: 'user', content: 'short' } },
    ])
    const page = await readTurns(
      path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, { limit: 10 },
      { ...WHOLE_FILE, maxLineBytes: 1024 },
    )
    expect(texts(page.items)).toEqual(['short'])
  })

  it('carries the compaction flag out of the stream', async () => {
    const { path, size } = await write('t.jsonl', [
      { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'earlier work' } },
      { type: 'user', message: { role: 'user', content: 'carry on' } },
    ])
    const page = await readTurns(path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, { limit: 10 }, WHOLE_FILE)
    expect(page.compacted).toBe(true)
  })

  it('returns an empty page rather than failing on a transcript with no turns', async () => {
    const { path, size } = await write('t.jsonl', [{ type: 'system', message: {} }])
    const page = await readTurns(path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, { limit: 5 }, WHOLE_FILE)
    expect(page.items).toEqual([])
    expect(page.totalTurns).toBe(0)
    expect(page.hasOlder).toBe(false)
  })
})

describe('readTurns anchored to the tail', () => {
  /** Forces the anchored branch deterministically, with no giant fixture. */
  const TINY = { maxScanBytes: 2048, maxLineBytes: 1024 * 1024 }

  it('admits it cannot see the beginning of an oversized transcript', async () => {
    const { path, size } = await write('t.jsonl', alternating(200))
    const page = await readTurns(path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, { limit: 4 }, TINY)
    expect(page.anchored).toBe(true)
    expect(page.totalTurns).toBeUndefined()
    expect(page.hasOlder).toBe(true)
    expect(page.startIndex).toBe(0)
    expect(page.startOffset).toBeGreaterThan(0)
    expect(texts(page.items)).toEqual(['ask 198', 'reply 198', 'ask 199', 'reply 199'])
  })

  it('walks back to the beginning by byte offset without duplicating or skipping', async () => {
    const { path, size } = await write('t.jsonl', alternating(60))
    const seen: string[] = []
    let beforeOffset: number | undefined
    for (let guard = 0; guard < 200; guard += 1) {
      const page = await readTurns(
        path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS,
        { limit: 5, ...beforeOffset === undefined ? {} : { beforeOffset } }, TINY,
      )
      seen.unshift(...texts(page.items))
      if (!page.hasOlder) break
      expect(page.startOffset).toBeDefined()
      expect(page.startOffset).toBeLessThan(beforeOffset ?? size)
      beforeOffset = page.startOffset
    }
    const whole = await readTurns(path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, { limit: 500 }, WHOLE_FILE)
    expect(seen).toEqual(texts(whole.items))
  })

  it('reports exact totals after all when walking back reaches offset zero', async () => {
    const { path, size } = await write('t.jsonl', alternating(2))
    const page = await readTurns(path, size, claudeCodeAdapter, DEFAULT_CONVERT_OPTIONS, { limit: 10 }, TINY)
    expect(page.anchored).toBe(false)
    expect(page.totalTurns).toBe(4)
    expect(page.hasOlder).toBe(false)
  })
})
