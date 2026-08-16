import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import * as fileSource from '../src/sources/file.ts'
import { FILE_SOURCE_ID, FileReferenceSource, parseExport } from '../src/sources/file.ts'

/** Wide enough to take every fixture whole; windowing has its own suite. */
const WINDOW = { limit: 100 }

const conversation = {
  label: 'Cache design',
  origin: 'https://chat.example.com/c/1',
  updatedAt: Date.UTC(2026, 7, 16),
  messages: [
    { role: 'user', text: 'how should we key the cache?' },
    { role: 'assistant', text: 'by request hash' },
  ],
}

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-ref-root-'))
  outside = await mkdtemp(join(tmpdir(), 'dsh-ref-outside-'))
  await writeFile(join(root, 'cache.json'), JSON.stringify(conversation), 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

function source(): FileReferenceSource {
  return new FileReferenceSource([root], ['.json'])
}

describe('discovery', () => {
  it('is unavailable until a root exists', async () => {
    expect(await new FileReferenceSource([join(root, 'missing')], ['.json']).available()).toBe(false)
    expect(await source().available()).toBe(true)
  })

  it('lists an export with its label', async () => {
    const found = await source().list('', 10)
    expect(found).toEqual([expect.objectContaining({
      ref: { source: FILE_SOURCE_ID, id: 'cache.json' },
      label: 'Cache design',
    })])
  })

  it('finds nested exports and honors the limit', async () => {
    await mkdir(join(root, 'deep'), { recursive: true })
    await writeFile(join(root, 'deep', 'other.json'), JSON.stringify(conversation), 'utf8')
    expect(await source().list('', 10)).toHaveLength(2)
    expect(await source().list('', 1)).toHaveLength(1)
  })

  it('matches the query against label and id, case-insensitively', async () => {
    expect(await source().list('CACHE DESIGN', 10)).toHaveLength(1)
    expect(await source().list('nothing like this', 10)).toEqual([])
  })

  it('ignores files whose extension is not configured', async () => {
    await writeFile(join(root, 'notes.txt'), JSON.stringify(conversation), 'utf8')
    expect(await source().list('', 10)).toHaveLength(1)
  })

  it('skips a malformed export during discovery so one bad file hides nothing', async () => {
    await writeFile(join(root, 'broken.json'), '{ not json', 'utf8')
    const found = await source().list('', 10)
    expect(found.map(entry => entry.ref.id)).toEqual(['cache.json'])
  })

  it('falls back to the filename when an export carries no label', async () => {
    await writeFile(join(root, 'untitled.json'), JSON.stringify({ messages: [] }), 'utf8')
    const found = await source().list('untitled', 10)
    expect(found[0]?.label).toBe('untitled.json')
  })
})

describe('reading', () => {
  it('returns the conversation', async () => {
    const snapshot = await source().read({ source: FILE_SOURCE_ID, id: 'cache.json' }, WINDOW)
    expect(snapshot.label).toBe('Cache design')
    expect(snapshot.partial).toBe(false)
    expect(snapshot.body.items).toEqual(conversation.messages)
    expect(snapshot.body).toMatchObject({ startIndex: 0, totalTurns: 2, hasOlder: false })
  })

  it('names a missing export rather than returning an empty conversation', async () => {
    await expect(source().read({ source: FILE_SOURCE_ID, id: 'nope.json' }, WINDOW))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }))
  })

  it('refuses to escape a root with .. segments', async () => {
    await writeFile(join(outside, 'secret.json'), JSON.stringify(conversation), 'utf8')
    await expect(source().read({ source: FILE_SOURCE_ID, id: `../${join(outside, 'secret.json')}` }, WINDOW))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }))
  })

  it('refuses to follow a symlink pointing outside a root', async () => {
    await writeFile(join(outside, 'secret.json'), JSON.stringify(conversation), 'utf8')
    await symlink(join(outside, 'secret.json'), join(root, 'link.json'))
    // The check runs on the resolved real path, so a link inside the root
    // cannot smuggle a file from outside it.
    await expect(source().read({ source: FILE_SOURCE_ID, id: 'link.json' }, WINDOW))
      .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }))
  })

  it('honors an already-aborted signal', async () => {
    await expect(source().read({ source: FILE_SOURCE_ID, id: 'cache.json' }, WINDOW, AbortSignal.abort()))
      .rejects.toThrow()
  })
})

describe('export validation', () => {
  it.each([
    ['not JSON', '{ nope'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '"hello"'],
    ['missing messages', '{"label":"x"}'],
    ['a non-object message', '{"messages":["hi"]}'],
    ['an unknown role', '{"messages":[{"role":"system","text":"hi"}]}'],
    ['a message with no text', '{"messages":[{"role":"user"}]}'],
    ['a non-string label', '{"label":1,"messages":[]}'],
    ['a non-numeric updatedAt', '{"updatedAt":"soon","messages":[]}'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseExport(raw, '/tmp/x.json'))
      .toThrow(expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }))
  })

  it('accepts a minimal export', () => {
    expect(parseExport('{"messages":[]}', '/tmp/x.json')).toEqual({ messages: [] })
  })
})

describe('as a mounted plugin', () => {
  it('registers itself and unregisters with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(ReferenceRuntime, {})
    const fiber = await ctx.plugin(fileSource, { roots: [root] })
    expect(ctx.references.sourceIds()).toContain(FILE_SOURCE_ID)
    await expect(ctx.references.read({ source: FILE_SOURCE_ID, id: 'cache.json' }, WINDOW))
      .resolves.toMatchObject({ label: 'Cache design' })
    await fiber.dispose()
    expect(ctx.references.sourceIds()).not.toContain(FILE_SOURCE_ID)
  })

  it('refuses to mount with no roots instead of silently resolving nothing', async () => {
    const ctx = new Context()
    await ctx.plugin(ReferenceRuntime, {})
    await expect(ctx.plugin(fileSource, { roots: [] })).rejects.toThrow(/roots/u)
  })
})
