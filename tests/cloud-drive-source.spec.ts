import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import * as cloudDrive from '../src/sources/cloud-drive/index.ts'
import { DRIVE_PROVIDERS } from '../src/sources/cloud-drive/registry.ts'
import type { DriveEntry, DriveProvider, DriveReadResult } from '../src/sources/cloud-drive/types.ts'

const original = DRIVE_PROVIDERS.openlist
afterEach(() => { DRIVE_PROVIDERS.openlist = original })

class StubDrive implements DriveProvider {
  readonly kind = 'openlist' as const
  readonly displayName = 'OpenList'
  supportsRange: boolean | undefined = true
  reads = 0
  constructor(public entry: DriveEntry, private readonly bytes: Uint8Array, private readonly readResult?: DriveReadResult) {}
  async credentialed() { return true }
  async list() { return [this.entry] }
  async describe(id: string) { return id === this.entry.id ? this.entry : undefined }
  async extractedText() { return undefined }
  async read(_id: string, start: number, end: number): Promise<DriveReadResult> { this.reads++; return this.readResult ?? { bytes: this.bytes.subarray(start, end), ranged: true, totalSize: this.bytes.byteLength } }
}

async function mount(drive: StubDrive, config: cloudDrive.Config = {}, generation?: () => number) {
  DRIVE_PROVIDERS.openlist = () => drive
  const ctx = new Context(); await ctx.plugin(ReferenceRuntime, {})
  const provided = ctx.provide('openListManager', { credentialGeneration: generation ?? (() => 0), credentials: async () => ({ endpoint: 'http://localhost:5244', token: 'private' }) })
  const fiber = await ctx.plugin(cloudDrive, config)
  return { ctx, dispose: async () => { await fiber.dispose(); if (typeof provided === 'function') await provided() } }
}

describe('cloud drive source safeguards survive the OpenList migration', () => {
  it('keeps grants, text allowlist, byte cap and window behavior in CloudDriveService', async () => {
    const text = new TextEncoder().encode('one\ntwo\nthree')
    const drive = new StubDrive({ kind: 'openlist', id: '/notes.md', path: '/notes.md', name: 'notes.md', size: text.byteLength, isDirectory: false }, text)
    const { ctx, dispose } = await mount(drive, { maxReadBytes: 8, blockChars: 3, maxReadTurns: 1 })
    try {
      const listed = await ctx.references.list('', 10)
      expect(listed[0]?.ref.id).toMatch(/^openlist:/)
      const ref = listed[0]!.ref
      expect(() => ctx.references.assertGranted('task', ref)).toThrow()
      ctx.references.grant('task', ref)
      const snapshot = await ctx.references.read(ref, { limit: 10 })
      expect(snapshot.partial).toBe(true)
      expect(snapshot.body.items).toHaveLength(1)
      expect(drive.reads).toBe(1)
    } finally { await dispose() }
  })
  it('orders an unfiltered listing by filename, then newest duplicate first', async () => {
    const bytes = new TextEncoder().encode('one')
    const drive = new StubDrive({ kind: 'openlist', id: '/unused', path: '/unused', name: 'unused.md', size: 3, isDirectory: false }, bytes)
    drive.list = async () => [
      { kind: 'openlist', id: '/b', path: '/b', name: 'b.md', size: 3, isDirectory: false, modifiedAt: 100 },
      { kind: 'openlist', id: '/a-old', path: '/a-old', name: 'a.md', size: 3, isDirectory: false, modifiedAt: 10 },
      { kind: 'openlist', id: '/a-new', path: '/a-new', name: 'a.md', size: 3, isDirectory: false, modifiedAt: 30 },
    ]
    const { ctx, dispose } = await mount(drive)
    try {
      expect((await ctx.references.list('', 10)).map(value => value.updatedAt)).toEqual([30, 10, 100])
    } finally { await dispose() }
  })
  it('rejects binary data even when its filename is text-like', async () => {
    const drive = new StubDrive({ kind: 'openlist', id: '/fake.md', path: '/fake.md', name: 'fake.md', size: 4, isDirectory: false }, new Uint8Array([0x50, 0x4b, 0x03, 0]))
    const { ctx, dispose } = await mount(drive)
    try { await expect(ctx.references.read({ source: 'cloud-drive', id: 'openlist:eyJ2IjoxLCJwYXRoIjoiL2Zha2UubWQifQ' }, { limit: 2 })).rejects.toThrow(); expect(drive.reads).toBe(1) } finally { await dispose() }
  })
  it('offers common binary documents as on-demand attachments', async () => {
    const drive = new StubDrive({ kind: 'openlist', id: '/photo.png', path: '/photo.png', name: 'photo.png', size: 4, isDirectory: false }, new Uint8Array([1, 2, 3, 4]))
    const { ctx, dispose } = await mount(drive)
    try {
      const ref = { source: 'cloud-drive', id: 'openlist:eyJ2IjoxLCJwYXRoIjoiL3Bob3RvLnBuZyJ9' }
      const snapshot = await ctx.references.read(ref, { limit: 2 })
      expect(snapshot.body.items[0]?.attachments?.[0]).toMatchObject({ name: 'photo.png', status: 'available' })
      expect(drive.reads).toBe(0)
      const bytes = await ctx.referenceCloudDrive.attachment(ref, 10)
      expect([...bytes.bytes]).toEqual([1, 2, 3, 4])
    } finally { await dispose() }
  })
  it('rejects a truncated attachment download when the provider reports its total size', async () => {
    const drive = new StubDrive(
      { kind: 'openlist', id: '/report.pdf', path: '/report.pdf', name: 'report.pdf', size: 4, isDirectory: false },
      new Uint8Array([1, 2, 3, 4]),
      { bytes: new Uint8Array([1, 2]), ranged: true, totalSize: 4 },
    )
    const { ctx, dispose } = await mount(drive)
    try {
      const ref = { source: 'cloud-drive', id: 'openlist:eyJ2IjoxLCJwYXRoIjoiL3JlcG9ydC5wZGYifQ' }
      await expect(ctx.referenceCloudDrive.attachment(ref, 10)).rejects.toMatchObject({ code: 'REFERENCE_READ_FAILED' })
    } finally { await dispose() }
  })
  it('rejects a truncated attachment download when the provider omits its total size', async () => {
    const drive = new StubDrive(
      { kind: 'openlist', id: '/report.pdf', path: '/report.pdf', name: 'report.pdf', size: 4, isDirectory: false },
      new Uint8Array([1, 2, 3, 4]),
      { bytes: new Uint8Array([1, 2]), ranged: true },
    )
    const { ctx, dispose } = await mount(drive)
    try {
      const ref = { source: 'cloud-drive', id: 'openlist:eyJ2IjoxLCJwYXRoIjoiL3JlcG9ydC5wZGYifQ' }
      await expect(ctx.referenceCloudDrive.attachment(ref, 10)).rejects.toMatchObject({ code: 'REFERENCE_READ_FAILED' })
    } finally { await dispose() }
  })
  it('accepts a completed attachment when both metadata and provider total size are unknown', async () => {
    const drive = new StubDrive(
      { kind: 'openlist', id: '/report.pdf', path: '/report.pdf', name: 'report.pdf', size: 0, isDirectory: false },
      new Uint8Array([1, 2, 3, 4]),
      { bytes: new Uint8Array([1, 2, 3, 4]), ranged: false },
    )
    const { ctx, dispose } = await mount(drive)
    try {
      const ref = { source: 'cloud-drive', id: 'openlist:eyJ2IjoxLCJwYXRoIjoiL3JlcG9ydC5wZGYifQ' }
      await expect(ctx.referenceCloudDrive.attachment(ref, 10)).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3, 4]) })
    } finally { await dispose() }
  })
  it('rejects an unknown-size ranged attachment whose completeness cannot be proven', async () => {
    const drive = new StubDrive(
      { kind: 'openlist', id: '/report.pdf', path: '/report.pdf', name: 'report.pdf', size: 0, isDirectory: false },
      new Uint8Array([1, 2, 3, 4]),
      { bytes: new Uint8Array([1, 2, 3, 4]), ranged: true },
    )
    const { ctx, dispose } = await mount(drive)
    try {
      const ref = { source: 'cloud-drive', id: 'openlist:eyJ2IjoxLCJwYXRoIjoiL3JlcG9ydC5wZGYifQ' }
      await expect(ctx.referenceCloudDrive.attachment(ref, 10)).rejects.toMatchObject({ code: 'REFERENCE_READ_FAILED' })
    } finally { await dispose() }
  })
  it('rejects a provider total that contradicts indexed file size', async () => {
    const drive = new StubDrive(
      { kind: 'openlist', id: '/report.pdf', path: '/report.pdf', name: 'report.pdf', size: 4, isDirectory: false },
      new Uint8Array([1, 2, 3, 4]),
      { bytes: new Uint8Array([1, 2]), ranged: true, totalSize: 2 },
    )
    const { ctx, dispose } = await mount(drive)
    try {
      const ref = { source: 'cloud-drive', id: 'openlist:eyJ2IjoxLCJwYXRoIjoiL3JlcG9ydC5wZGYifQ' }
      await expect(ctx.referenceCloudDrive.attachment(ref, 10)).rejects.toMatchObject({ code: 'REFERENCE_READ_FAILED' })
    } finally { await dispose() }
  })
  it('rejects an oversized attachment from metadata without downloading it', async () => {
    const drive = new StubDrive(
      { kind: 'openlist', id: '/report.pdf', path: '/report.pdf', name: 'report.pdf', size: 11, isDirectory: false },
      new Uint8Array(11),
    )
    const { ctx, dispose } = await mount(drive)
    try {
      const ref = { source: 'cloud-drive', id: 'openlist:eyJ2IjoxLCJwYXRoIjoiL3JlcG9ydC5wZGYifQ' }
      await expect(ctx.referenceCloudDrive.attachment(ref, 10)).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' })
      expect(drive.reads).toBe(0)
    } finally { await dispose() }
  })
  it('rejects an oversized attachment returned by the provider', async () => {
    const drive = new StubDrive(
      { kind: 'openlist', id: '/report.pdf', path: '/report.pdf', name: 'report.pdf', size: 4, isDirectory: false },
      new Uint8Array([1, 2, 3, 4]),
      { bytes: new Uint8Array(11), ranged: false, totalSize: 11 },
    )
    const { ctx, dispose } = await mount(drive)
    try {
      const ref = { source: 'cloud-drive', id: 'openlist:eyJ2IjoxLCJwYXRoIjoiL3JlcG9ydC5wZGYifQ' }
      await expect(ctx.referenceCloudDrive.attachment(ref, 10)).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' })
      expect(drive.reads).toBe(1)
    } finally { await dispose() }
  })
  it('drops cached listings immediately when the OpenList credential generation changes', async () => {
    let generation = 1
    const text = new TextEncoder().encode('one')
    const drive = new StubDrive({ kind: 'openlist', id: '/old.md', path: '/old.md', name: 'old.md', size: text.byteLength, isDirectory: false }, text)
    const { ctx, dispose } = await mount(drive, { listTtlMs: 60_000 }, () => generation)
    try {
      expect((await ctx.references.list('', 10)).map(value => value.label)).toEqual(['old.md'])
      drive.entry = { ...drive.entry, id: '/new.md', path: '/new.md', name: 'new.md' }
      generation += 1
      expect((await ctx.references.list('', 10)).map(value => value.label)).toEqual(['new.md'])
    } finally { await dispose() }
  })
  it('preserves bounded-search incompleteness in public summaries', async () => {
    const text = new TextEncoder().encode('one')
    const drive = new StubDrive({ kind: 'openlist', id: '/partial.md', path: '/partial.md', name: 'partial.md', size: text.byteLength, isDirectory: false, searchIncomplete: true }, text)
    const { ctx, dispose } = await mount(drive)
    try { expect(await ctx.references.list('partial', 10)).toMatchObject([{ label: 'partial.md', searchIncomplete: true }]) } finally { await dispose() }
  })
})
