import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ReferenceAnythingError } from '../src/errors.ts'
import ReferenceRuntime from '../src/index.ts'
import { DriveCache } from '../src/sources/cloud-drive/cache.ts'
import * as cloudDrive from '../src/sources/cloud-drive/index.ts'
import {
  CLOUD_DRIVE_SOURCE_ID,
  decodeText,
  looksBinary,
  splitBlocks,
} from '../src/sources/cloud-drive/index.ts'
import { DRIVE_PROVIDERS, decodeDriveId, encodeDriveId } from '../src/sources/cloud-drive/registry.ts'
import type { DriveEntry, DriveKind, DriveProvider, DriveReadResult } from '../src/sources/cloud-drive/types.ts'
import type { ReferenceSnapshot } from '../src/types.ts'

/** Wide enough for every fixture here; clamping has its own test. */
const WINDOW = { limit: 100 }

/** One file, with only the fields a test cares about spelled out. */
function entry(over: Partial<DriveEntry> & { id: string, name: string }): DriveEntry {
  return {
    kind: 'baidu',
    path: `/apps/bdpan/${over.name}`,
    size: 64,
    isDirectory: false,
    ...over,
  }
}

/** Everything one stub drive was asked to do, so a test can assert on absence. */
interface Calls {
  readonly list: string[]
  readonly read: string[]
  readonly extracted: string[]
  readonly describe: string[]
}

/** A drive with no network behind it. */
class StubDrive implements DriveProvider {
  readonly kind: DriveKind = 'baidu'
  readonly displayName = 'Stub Drive'
  supportsRange: boolean | undefined = true
  readonly calls: Calls = { list: [], read: [], extracted: [], describe: [] }

  constructor(private readonly options: {
    entries?: readonly DriveEntry[]
    credential?: boolean
    bytes?: Uint8Array
    totalSize?: number
    readFails?: Error
    extracted?: string
  } = {}) {}

  async credentialed(): Promise<boolean> {
    return this.options.credential ?? true
  }

  async list(query: string): Promise<readonly DriveEntry[]> {
    this.calls.list.push(query)
    return this.options.entries ?? []
  }

  async describe(id: string): Promise<DriveEntry | undefined> {
    this.calls.describe.push(id)
    return (this.options.entries ?? []).find(candidate => candidate.id === id)
  }

  async extractedText(id: string): Promise<string | undefined> {
    this.calls.extracted.push(id)
    return this.options.extracted
  }

  async read(id: string, start: number, end: number): Promise<DriveReadResult> {
    this.calls.read.push(`${id}:${start}-${end}`)
    if (this.options.readFails !== undefined) throw this.options.readFails
    const bytes = (this.options.bytes ?? new TextEncoder().encode('hello')).subarray(start, end)
    return {
      bytes,
      ranged: true,
      ...(this.options.totalSize === undefined ? {} : { totalSize: this.options.totalSize }),
    }
  }
}

const originalBaidu = DRIVE_PROVIDERS.baidu

afterEach(() => {
  DRIVE_PROVIDERS.baidu = originalBaidu
})

/**
 * Mount the runtime and the source over a stub drive.
 *
 * The registry is the seam. `CloudDriveService` builds its providers through
 * `providerFor`, so swapping the factory is what lets the service be exercised
 * end to end with no credential, no network, and no real account — and it
 * keeps the transport seams (`fetch`, `configPath`) out of the user-facing
 * config, where a `fetch` could not be expressed in YAML anyway.
 */
async function mount(drive: StubDrive, over: cloudDrive.Config = {}): Promise<{
  ctx: Context
  dispose: () => Promise<void>
}> {
  DRIVE_PROVIDERS.baidu = () => drive
  const ctx = new Context()
  await ctx.plugin(ReferenceRuntime, {})
  const fiber = await ctx.plugin(cloudDrive, { drives: ['baidu'], ...over })
  return { ctx, dispose: () => fiber.dispose() }
}

/** Read one reference through the registry, the way the tool does. */
async function read(ctx: Context, id: string, window = WINDOW): Promise<ReferenceSnapshot> {
  return await ctx.references.read({ source: CLOUD_DRIVE_SOURCE_ID, id }, window)
}

describe('reference ids', () => {
  it('round-trips a drive and a file id', () => {
    expect(decodeDriveId(encodeDriveId('baidu', '1043216524887654321')))
      .toEqual({ kind: 'baidu', fileId: '1043216524887654321' })
  })

  it('keeps a separator inside the provider id, which PDS will need', () => {
    expect(decodeDriveId('pds:drive-7/file-9')).toEqual({ kind: 'pds', fileId: 'drive-7/file-9' })
  })

  it('rejects an id that names no drive', () => {
    expect(() => decodeDriveId('dropbox:9')).toThrow(expect.objectContaining({ code: 'REFERENCE_INVALID_URI' }))
    expect(() => decodeDriveId('baidu:')).toThrow(expect.objectContaining({ code: 'REFERENCE_INVALID_URI' }))
    expect(() => decodeDriveId('1043216524887654321')).toThrow(expect.objectContaining({ code: 'REFERENCE_INVALID_URI' }))
  })
})

describe('listing cache', () => {
  it('reuses a listing until its ttl passes', () => {
    let now = 1000
    const cache = new DriveCache(50, () => now)
    cache.remember('k', [entry({ id: '1', name: 'a.md' })])
    now = 1040
    expect(cache.listing('k')).toHaveLength(1)
    now = 1060
    expect(cache.listing('k')).toBeUndefined()
  })

  it('does not let one drive answer for another drive\'s id', () => {
    const cache = new DriveCache(1000, () => 0)
    cache.remember('k', [entry({ id: 'shared', name: 'a.md' })])
    expect(cache.entry('baidu', 'shared')?.name).toBe('a.md')
    expect(cache.entry('pds', 'shared')).toBeUndefined()
  })

  it('evicts the least recently seen entry past the bound', () => {
    const cache = new DriveCache(1000, () => 0, 2)
    cache.remember('k', [
      entry({ id: '1', name: 'a.md' }),
      entry({ id: '2', name: 'b.md' }),
    ])
    // Touching 1 makes 2 the oldest, so 2 is what the third insert displaces.
    cache.entry('baidu', '1')
    cache.remember('k2', [entry({ id: '3', name: 'c.md' })])
    expect(cache.entry('baidu', '1')).toBeDefined()
    expect(cache.entry('baidu', '2')).toBeUndefined()
    expect(cache.entry('baidu', '3')).toBeDefined()
  })
})

describe('projecting a document', () => {
  it('breaks blocks at line boundaries', () => {
    expect(splitBlocks('alpha\nbeta\ngamma', 12)).toEqual(['alpha\nbeta', 'gamma'])
    // A line that would overflow the budget starts the next block whole,
    // rather than being cut to fill the current one.
    expect(splitBlocks('alpha\nbeta\ngamma', 11)).toEqual(['alpha\nbeta', 'gamma'])
  })

  it('hard-splits a line longer than the whole budget', () => {
    expect(splitBlocks('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })

  it('yields nothing for text that is only whitespace', () => {
    expect(splitBlocks('   \n\n  ', 10)).toEqual([])
  })

  it('sees a NUL as binary and ordinary text as text', () => {
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]))).toBe(true)
    expect(looksBinary(new TextEncoder().encode('# 标题\nplain text'))).toBe(false)
  })

  it('drops a character the byte cap cut in half rather than corrupting it', () => {
    const whole = new TextEncoder().encode('ab中')
    // 'ab' plus the first two of the three bytes that spell 中.
    const cut = whole.subarray(0, whole.byteLength - 1)
    expect(decodeText(cut)).toBe('ab')
    expect(decodeText(cut)).not.toContain('�')
    expect(decodeText(whole)).toBe('ab中')
  })
})

describe('the source', () => {
  it('reports unavailable when no drive holds a credential', async () => {
    const { ctx, dispose } = await mount(new StubDrive({ credential: false }))
    try {
      expect(await ctx.referenceCloudDrive.available()).toBe(false)
    } finally {
      await dispose()
    }
  })

  it('skips a configured drive that has never been logged into', async () => {
    // Both drives ship enabled, so the ordinary state of a machine is one
    // credential and one absence. The absent one must cost nothing rather than
    // fail a request per keystroke — and the presence of the other is what
    // makes that visible, since `available()` speaks for the source as a whole
    // and would otherwise take the group out of discovery entirely.
    const absent = new StubDrive({ credential: false, entries: [entry({ id: '1', name: 'secret.md' })] })
    const present = new StubDrive({ entries: [entry({ id: '2', name: 'notes.md' })] })
    const restore = DRIVE_PROVIDERS.pds
    DRIVE_PROVIDERS.pds = () => absent
    const { ctx, dispose } = await mount(present, { drives: ['baidu', 'pds'] })
    try {
      const listed = await ctx.references.list('', 10)
      expect(listed.map(item => item.label)).toEqual(['notes.md'])
      expect(absent.calls.list).toEqual([])
      expect(present.calls.list).toEqual([''])
    } finally {
      await dispose()
      DRIVE_PROVIDERS.pds = restore
    }
  })

  it('requires a grant, because these are the user\'s own remote files', async () => {
    const { ctx, dispose } = await mount(new StubDrive())
    try {
      const ref = { source: CLOUD_DRIVE_SOURCE_ID, id: 'baidu:1' }
      expect(ctx.referenceCloudDrive.requiresGrant).toBe(true)
      expect(() => ctx.references.assertGranted('task-1', ref))
        .toThrow(expect.objectContaining({ code: 'CONVERSATION_REFERENCE_NOT_GRANTED' }))
      ctx.references.grant('task-1', ref)
      expect(() => ctx.references.assertGranted('task-1', ref)).not.toThrow()
      // The same id under another source must not ride in on that grant.
      expect(() => ctx.references.assertGranted('task-1', { source: 'web-chat', id: 'baidu:1' }))
        .toThrow(expect.objectContaining({ code: 'CONVERSATION_REFERENCE_NOT_GRANTED' }))
    } finally {
      await dispose()
    }
  })

  it('lists files, drops folders, and carries no excerpt into a summary', async () => {
    const drive = new StubDrive({
      entries: [
        entry({ id: '1', name: 'notes.md', modifiedAt: 200, excerpt: 'secret passage' }),
        entry({ id: '2', name: 'archive', isDirectory: true }),
        entry({ id: '3', name: 'plan.md', modifiedAt: 300 }),
      ],
    })
    const { ctx, dispose } = await mount(drive)
    try {
      const found = await ctx.references.list('', 10)
      expect(found.map(item => item.label)).toEqual(['plan.md', 'notes.md'])
      expect(found[0]!.ref).toEqual({ source: CLOUD_DRIVE_SOURCE_ID, id: 'baidu:3' })
      expect(found[0]!.origin).toBe('/apps/bdpan/plan.md')
      expect(JSON.stringify(found)).not.toContain('secret passage')
    } finally {
      await dispose()
    }
  })

  it('ranks a filename match ahead of a hit only the drive can explain', async () => {
    const drive = new StubDrive({
      entries: [
        entry({ id: '1', name: 'unrelated-name.md' }),
        entry({ id: '2', name: 'cache-design.md' }),
      ],
    })
    const { ctx, dispose } = await mount(drive)
    try {
      const found = await ctx.references.list('cache', 10)
      // Both are kept — a semantic drive returns hits whose relevance the name
      // cannot show — but the visible match comes first.
      expect(found.map(item => item.label)).toEqual(['cache-design.md', 'unrelated-name.md'])
    } finally {
      await dispose()
    }
  })

  it('reads a file as document blocks, never as anyone\'s turn', async () => {
    const text = 'line one\nline two\nline three'
    const drive = new StubDrive({
      entries: [entry({ id: '7', name: 'notes.md', size: text.length })],
      bytes: new TextEncoder().encode(text),
      totalSize: text.length,
    })
    const { ctx, dispose } = await mount(drive, { blockChars: 12 })
    try {
      const snapshot = await read(ctx, 'baidu:7')
      expect(snapshot.body.items.map(item => item.role)).toEqual(['document', 'document', 'document'])
      expect(snapshot.body.items.map(item => item.text)).toEqual(['line one', 'line two', 'line three'])
      expect(snapshot.body.startIndex).toBe(0)
      expect(snapshot.partial).toBe(false)
      expect(drive.calls.read).toEqual([`7:0-${text.length}`])
    } finally {
      await dispose()
    }
  })

  it('marks a read that hit the byte cap as partial', async () => {
    const drive = new StubDrive({
      entries: [entry({ id: '7', name: 'big.md', size: 4096 })],
      bytes: new TextEncoder().encode('a\nb\nc\nd\ne\nf'),
      totalSize: 4096,
    })
    const { ctx, dispose } = await mount(drive, { maxReadBytes: 8 })
    try {
      const snapshot = await read(ctx, 'baidu:7')
      expect(snapshot.partial).toBe(true)
      expect(drive.calls.read).toEqual(['7:0-8'])
    } finally {
      await dispose()
    }
  })

  it('clamps the window to its own maxReadTurns', async () => {
    const drive = new StubDrive({
      entries: [entry({ id: '7', name: 'notes.md', size: 40 })],
      bytes: new TextEncoder().encode('a\nb\nc\nd\ne\nf\ng\nh'),
      totalSize: 16,
    })
    const { ctx, dispose } = await mount(drive, { blockChars: 1, maxReadTurns: 3 })
    try {
      const snapshot = await read(ctx, 'baidu:7', { limit: 100 })
      expect(snapshot.body.items).toHaveLength(3)
      expect(snapshot.body.hasOlder).toBe(true)
      expect(snapshot.body.totalTurns).toBe(8)
    } finally {
      await dispose()
    }
  })

  it('keeps a file it could never decode out of the menu, for the same reason it drops folders', async () => {
    const drive = new StubDrive({
      entries: [
        entry({ id: '1', name: 'notes.md' }),
        entry({ id: '2', name: 'holiday.png' }),
        entry({ id: '3', name: 'backup.zip' }),
        entry({ id: '4', name: 'LICENSE' }),
      ],
    })
    const { ctx, dispose } = await mount(drive)
    try {
      const found = await ctx.references.list('', 10)
      // Offering one would produce a reference whose only outcome is the
      // REFERENCE_READ_FAILED asserted below.
      expect(found.map(item => item.label)).toEqual(['notes.md'])
    } finally {
      await dispose()
    }
  })

  it('refuses a file it cannot decode, before spending any transfer on it', async () => {
    const drive = new StubDrive({ entries: [entry({ id: '9', name: 'holiday.png' })] })
    const { ctx, dispose } = await mount(drive)
    try {
      await expect(read(ctx, 'baidu:9'))
        .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }))
      expect(drive.calls.read).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('refuses a text-named file whose bytes are binary', async () => {
    const drive = new StubDrive({
      entries: [entry({ id: '9', name: 'mislabelled.md', size: 4 })],
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x00]),
    })
    const { ctx, dispose } = await mount(drive)
    try {
      await expect(read(ctx, 'baidu:9'))
        .rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }))
    } finally {
      await dispose()
    }
  })

  it('falls back to the drive\'s recalled passage, and says that is what it is', async () => {
    const drive = new StubDrive({
      entries: [entry({ id: '9', name: 'scan.md', size: 100 })],
      readFails: new Error('download refused'),
      extracted: 'the passage the index recalled',
    })
    const { ctx, dispose } = await mount(drive)
    try {
      const snapshot = await read(ctx, 'baidu:9')
      expect(snapshot.body.items[0]!.text).toContain('not the document')
      expect(snapshot.body.items.at(-1)!.text).toBe('the passage the index recalled')
      // A recalled extract is never the whole file, whatever its length.
      expect(snapshot.partial).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('reports the download failure when there is no passage to fall back to', async () => {
    const drive = new StubDrive({
      entries: [entry({ id: '9', name: 'scan.md', size: 100 })],
      readFails: new Error('download refused'),
    })
    const { ctx, dispose } = await mount(drive)
    try {
      // Asked of the source directly: the registry wraps whatever a source
      // throws, and what is under test here is that the download failure is
      // what surfaces rather than being replaced by an empty success.
      await expect(ctx.referenceCloudDrive.read({ source: CLOUD_DRIVE_SOURCE_ID, id: 'baidu:9' }, WINDOW))
        .rejects.toThrow('download refused')
    } finally {
      await dispose()
    }
  })

  it('describes a file it never listed, so a reference outlives its menu', async () => {
    const drive = new StubDrive({
      entries: [entry({ id: '7', name: 'notes.md', size: 5 })],
      totalSize: 5,
    })
    const { ctx, dispose } = await mount(drive)
    try {
      const snapshot = await read(ctx, 'baidu:7')
      expect(drive.calls.describe).toEqual(['7'])
      expect(snapshot.label).toBe('notes.md')
    } finally {
      await dispose()
    }
  })

  it('rejects a reference to a drive that is not configured', async () => {
    const { ctx, dispose } = await mount(new StubDrive())
    try {
      await expect(read(ctx, 'pds:7'))
        .rejects.toThrow(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }))
    } finally {
      await dispose()
    }
  })

  it('refuses to mount a drive this build has no transport for', async () => {
    // Both kinds in the vocabulary have a transport today, so the condition is
    // staged by removing one. That is the real shape of the failure: the
    // vocabulary outlives any one build, so a name can lose its transport
    // without ceasing to name a drive that stored references still point at.
    const restore = DRIVE_PROVIDERS.pds
    delete DRIVE_PROVIDERS.pds
    try {
      const ctx = new Context()
      await ctx.plugin(ReferenceRuntime, {})
      // Caught rather than matched with `.rejects`, which would try to render
      // the resolved fiber and fail inside the formatter instead of here.
      const thrown = await ctx.plugin(cloudDrive, { drives: ['pds'] }).then(() => undefined, (cause: unknown) => cause)
      expect(thrown).toBeInstanceOf(ReferenceAnythingError)
      expect((thrown as ReferenceAnythingError).code).toBe('REFERENCE_INVALID_CONFIG')
      expect(ctx.references.sourceIds()).not.toContain(CLOUD_DRIVE_SOURCE_ID)
    } finally {
      DRIVE_PROVIDERS.pds = restore
    }
  })

  it('unregisters the source when its fiber is disposed', async () => {
    const { ctx, dispose } = await mount(new StubDrive())
    expect(ctx.references.sourceIds()).toContain(CLOUD_DRIVE_SOURCE_ID)
    await dispose()
    expect(ctx.references.sourceIds()).not.toContain(CLOUD_DRIVE_SOURCE_ID)
  })
})
