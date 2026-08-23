import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { access, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import * as tool from '../src/tool.ts'
import { encodeReferenceUri } from '../src/uri.ts'
import type { ReferenceRef, ReferenceSource } from '../src/types.ts'

const driveRef: ReferenceRef = { source: 'cloud-drive', id: 'openlist:attachment-fixture' }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const RASTER_IMAGES = [
  { format: 'PNG', name: 'pixel.png', mediaType: 'image/png', bytes: PNG, attachmentId: 'saved-png' },
  {
    format: 'JPEG', name: 'photo.jpg', mediaType: 'image/jpeg', attachmentId: 'saved-jpeg',
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
  },
  {
    format: 'WebP', name: 'preview.webp', mediaType: 'image/webp', attachmentId: 'saved-webp',
    bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
  },
  {
    format: 'GIF', name: 'animation.gif', mediaType: 'image/gif', attachmentId: 'saved-gif',
    bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  },
] as const

function attachmentSource(): ReferenceSource {
  return {
    id: 'cloud-drive',
    available: async () => true,
    list: async () => [],
    read: async () => { throw new Error('not used') },
  }
}

async function mount(
  attachment: (ref: ReferenceRef, maxBytes: number, signal?: AbortSignal) => Promise<{
    name: string
    bytes: Uint8Array
    mimeType: string
  }>,
  saveImage?: (input: { data: Uint8Array, mediaType: string, name?: string }) => Promise<Record<string, unknown>>,
) {
  const ctx = new Context()
  await ctx.plugin(ReferenceRuntime, {})
  ctx.references.registerSource(attachmentSource())
  const driveProvider = ctx.provide('referenceCloudDrive', { attachment } as never)
  const imageProvider = saveImage === undefined ? undefined : ctx.provide('attachments', { saveImage } as never)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const fiber = await ctx.plugin(tool, {})
  return {
    ctx,
    dispose: async () => {
      await fiber.dispose()
      if (typeof imageProvider === 'function') await imageProvider()
      if (typeof driveProvider === 'function') await driveProvider()
    },
  }
}

let call = 0
function run(ctx: Context, attachmentId = 'file') {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `attachment-${++call}` as never,
    name: 'reference_attachment_read',
    arguments: { uri: encodeReferenceUri(driveRef), attachmentId },
  })
}

function attachmentRoots() {
  return readdir(tmpdir()).then(names => new Set(names.filter(name => name.startsWith('dsh-reference-drive-'))))
}

afterEach(() => { vi.useRealTimers() })

describe('reference_attachment_read', () => {
  it.each(RASTER_IMAGES)(
    'renders recognized $format bytes as an inline image',
    async ({ name, mediaType, bytes, attachmentId }) => {
      const image = { attachmentId, mediaType, bytes: bytes.byteLength, width: 1, height: 1, name }
      const saveImage = vi.fn(async () => image)
      const mounted = await mount(async () => ({ name, bytes, mimeType: mediaType }), saveImage)
      try {
        const result = await run(mounted.ctx)
        expect(result.isError).toBe(false)
        expect(saveImage).toHaveBeenCalledOnce()
        expect(saveImage).toHaveBeenCalledWith({ data: Buffer.from(bytes), mediaType, name })
        expect(result.value).toEqual({
          name, mimeType: mediaType, size: bytes.byteLength, localPath: expect.any(String), image,
        })
        expect(result.content).toEqual([
          { type: 'text', text: `${name} (${mediaType}, ${bytes.byteLength} bytes)` },
          { type: 'image', attachment: image },
        ])
      } finally { await mounted.dispose() }
    },
  )

  it('normalizes dependency-owned image metadata to the strict public schema', async () => {
    const saveImage = vi.fn(async () => ({
      attachmentId: 'saved-image', mediaType: 'image/png', bytes: PNG.byteLength,
      width: 1, height: 1, name: 'screen.png', originalDimensions: { width: 2000, height: 1000 },
    }))
    const mounted = await mount(async () => ({ name: 'screen.png', bytes: PNG, mimeType: 'image/png' }), saveImage)
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(false)
      expect(result.value).toEqual({
        name: 'screen.png', mimeType: 'image/png', size: PNG.byteLength,
        localPath: expect.any(String),
        image: {
          attachmentId: 'saved-image', mediaType: 'image/png', bytes: PNG.byteLength,
          width: 1, height: 1, name: 'screen.png',
        },
      })
    } finally { await mounted.dispose() }
  })

  it('materializes unsupported image formats as files without invoking image storage', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const saveImage = vi.fn()
    const mounted = await mount(async () => ({ name: 'diagram.svg', bytes: svg, mimeType: 'image/svg+xml' }), saveImage)
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ name: 'diagram.svg', mimeType: 'image/svg+xml', size: svg.byteLength })
      expect(result.value).not.toHaveProperty('image')
      expect(saveImage).not.toHaveBeenCalled()
      await expect(access((result.value as { localPath: string }).localPath)).resolves.toBeUndefined()
    } finally { await mounted.dispose() }
  })

  it('requires the documented cloud-drive attachment id', async () => {
    const attachment = vi.fn(async () => ({ name: 'notes.pdf', bytes: new Uint8Array([1]), mimeType: 'application/pdf' }))
    const mounted = await mount(attachment)
    try {
      const result = await run(mounted.ctx, 'not-file')
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
      expect(attachment).not.toHaveBeenCalled()
    } finally { await mounted.dispose() }
  })

  it('removes a temporary directory immediately when materialization fails', async () => {
    const before = await attachmentRoots()
    const mounted = await mount(async () => ({ name: 'broken.png', bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }))
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
      const after = await attachmentRoots()
      expect([...after].filter(root => !before.has(root))).toEqual([])
    } finally { await mounted.dispose() }
  })

  it('keeps successful files until disposal and removes them on disposal', async () => {
    const mounted = await mount(async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }))
    const result = await run(mounted.ctx)
    expect(result.isError).toBe(false)
    const path = (result.value as { localPath: string }).localPath
    await expect(access(path)).resolves.toBeUndefined()
    await mounted.dispose()
    await expect(access(path)).rejects.toThrow()
  })

  it.each(['..', '.', 'CON', 'report. ', '../outside.pdf'])(
    'keeps a hostile filename %j inside a generated attachment directory',
    async (name) => {
      const mounted = await mount(async () => ({ name, bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }))
      try {
        const result = await run(mounted.ctx)
        expect(result.isError).toBe(false)
        const path = (result.value as { localPath: string }).localPath
        expect(basename(dirname(path))).toMatch(/^dsh-reference-drive-/)
        expect(basename(path)).toMatch(/^attachment-/)
        await expect(access(path)).resolves.toBeUndefined()
      } finally { await mounted.dispose() }
    },
  )

  it('expires successful files after one hour', async () => {
    vi.useFakeTimers()
    const mounted = await mount(async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }))
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(false)
      const path = (result.value as { localPath: string }).localPath
      await expect(access(path)).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      await vi.waitFor(() => expect(access(path)).rejects.toThrow())
    } finally { await mounted.dispose() }
  })

  it('returns a stable error when raster output storage is missing', async () => {
    const mounted = await mount(async () => ({ name: 'screen.png', bytes: PNG, mimeType: 'image/png' }))
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
    } finally { await mounted.dispose() }
  })
})
