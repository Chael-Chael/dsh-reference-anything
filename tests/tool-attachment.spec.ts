import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { access, mkdir, mkdtemp, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import * as tool from '../src/tool.ts'
import { encodeReferenceUri } from '../src/uri.ts'
import type { ReferenceRef, ReferenceSource } from '../src/types.ts'

const selectedWriteFault = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'partial-fail' | 'pause-fail',
  path: '',
  gate: undefined as Promise<void> | undefined,
  started: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async (loadOriginal) => {
  const actual = await loadOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async writeFile(path: Parameters<typeof actual.writeFile>[0], data: Uint8Array | string, options?: object) {
      if (selectedWriteFault.mode === 'partial-fail' && (options as { flag?: string } | undefined)?.flag === 'wx') {
        selectedWriteFault.mode = 'none'
        selectedWriteFault.path = String(path)
        const partial = typeof data === 'string' ? data.slice(0, 1) : data.subarray(0, 1)
        await actual.writeFile(path, partial, options)
        throw new Error('injected attachment write failure')
      }
      return actual.writeFile(path, data, options)
    },
    async open(path: Parameters<typeof actual.open>[0], flags: string | number, mode?: number) {
      const handle = await actual.open(path, flags, mode)
      if (selectedWriteFault.mode === 'none' || flags !== 'wx') return handle
      const faultMode = selectedWriteFault.mode
      selectedWriteFault.mode = 'none'
      selectedWriteFault.path = String(path)
      if (faultMode === 'pause-fail') {
        const stats = await handle.stat()
        await handle.close()
        return {
          stat: async () => stats,
          async writeFile() {
            selectedWriteFault.started?.()
            await selectedWriteFault.gate
            throw new Error('injected delayed attachment write failure')
          },
          close: async () => {},
        }
      }
      return {
        stat: () => handle.stat(),
        async writeFile(data: Uint8Array | string) {
          if (typeof data === 'string') await handle.write(data.slice(0, 1))
          else await handle.write(data.subarray(0, 1))
          throw new Error('injected attachment write failure')
        },
        close: () => handle.close(),
      }
    },
  }
})

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
  cloudDriveDownloadDirectory = '',
) {
  const ctx = new Context()
  await ctx.plugin(ReferenceRuntime, {})
  ctx.references.registerSource(attachmentSource())
  const driveProvider = ctx.provide('referenceCloudDrive', { attachment } as never)
  const settings = { cloudDriveDownloadDirectory }
  const historyProvider = ctx.provide('referenceChatHistory', { store: { settings } } as never)
  const imageProvider = saveImage === undefined ? undefined : ctx.provide('attachments', { saveImage } as never)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const fiber = await ctx.plugin(tool, {})
  return {
    ctx,
    settings,
    dispose: async () => {
      await fiber.dispose()
      if (typeof imageProvider === 'function') await imageProvider()
      if (typeof historyProvider === 'function') await historyProvider()
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

const testBases: string[] = []
async function testBase() {
  const path = await mkdtemp(join(tmpdir(), 'dsh-reference-selected-base-'))
  testBases.push(path)
  return path
}

afterEach(async () => {
  vi.useRealTimers()
  selectedWriteFault.mode = 'none'
  selectedWriteFault.path = ''
  selectedWriteFault.gate = undefined
  selectedWriteFault.started = undefined
  await Promise.all(testBases.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('reference_attachment_read', () => {
  it('uses the system temporary directory when no cloud-drive download directory is selected', async () => {
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
    )
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(false)
      const localPath = (result.value as { localPath: string }).localPath
      expect(dirname(dirname(localPath))).toBe(resolve(tmpdir()))
    } finally { await mounted.dispose() }
  })

  it('creates an isolated attachment directory under the selected cloud-drive download directory', async () => {
    const base = await testBase()
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
      undefined,
      base,
    )
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(false)
      const localPath = (result.value as { localPath: string }).localPath
      expect(dirname(dirname(localPath))).toBe(resolve(base))
      expect(basename(dirname(localPath))).toMatch(/^dsh-reference-drive-/)
      await expect(access(localPath)).resolves.toBeUndefined()
    } finally { await mounted.dispose() }
  })

  it.runIf(process.platform !== 'win32')('uses exact symlink and parent-segment semantics for materialization and cleanup', async () => {
    const selectionParent = await testBase()
    const actualParent = await testBase()
    const junctionTarget = join(actualParent, 'junction-target')
    const actualDownloads = join(actualParent, 'downloads')
    await mkdir(junctionTarget)
    await mkdir(actualDownloads)
    const link = join(selectionParent, 'link')
    await symlink(junctionTarget, link, 'dir')
    const selected = `${link}/../downloads`
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
      undefined,
      selected,
    )
    let localPath = ''
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(false)
      localPath = (result.value as { localPath: string }).localPath
      expect(localPath).toContain('/link/../downloads')
      await expect(access(localPath)).resolves.toBeUndefined()
      expect(await readdir(actualDownloads)).toHaveLength(1)
    } finally { await mounted.dispose() }
    await expect(access(localPath)).rejects.toThrow()
    expect(await readdir(actualDownloads)).toEqual([])
  })

  it('uses the latest selected directory for each cloud-drive attachment without a restart', async () => {
    const baseA = await testBase()
    const baseB = await testBase()
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
      undefined,
      baseA,
    )
    try {
      const first = await run(mounted.ctx)
      expect(dirname(dirname((first.value as { localPath: string }).localPath))).toBe(resolve(baseA))

      mounted.settings.cloudDriveDownloadDirectory = baseB
      const second = await run(mounted.ctx)
      expect(dirname(dirname((second.value as { localPath: string }).localPath))).toBe(resolve(baseB))
    } finally { await mounted.dispose() }
  })

  it('removes only its generated child on failure and preserves the selected directory and siblings', async () => {
    const base = await testBase()
    const sibling = join(base, 'keep.txt')
    await writeFile(sibling, 'keep')
    const mounted = await mount(
      async () => ({ name: 'broken.png', bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }),
      undefined,
      base,
    )
    try {
      const result = await run(mounted.ctx)
      expect(result.error?.info).toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
      expect(await readdir(base)).toEqual(['keep.txt'])
      await expect(access(sibling)).resolves.toBeUndefined()
    } finally { await mounted.dispose() }
    await expect(access(base)).resolves.toBeUndefined()
    await expect(access(sibling)).resolves.toBeUndefined()
  })

  it('expires only its generated child and preserves the selected directory and siblings', async () => {
    vi.useFakeTimers()
    const base = await testBase()
    const sibling = join(base, 'keep.txt')
    await writeFile(sibling, 'keep')
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
      undefined,
      base,
    )
    try {
      const result = await run(mounted.ctx)
      const localPath = (result.value as { localPath: string }).localPath
      await vi.advanceTimersByTimeAsync(tool.ATTACHMENT_LIFETIME_MS)
      await vi.waitFor(() => expect(access(localPath)).rejects.toThrow())
      await expect(access(base)).resolves.toBeUndefined()
      await expect(access(sibling)).resolves.toBeUndefined()
    } finally { await mounted.dispose() }
  })

  it('disposal removes only generated children and preserves the selected directory and siblings', async () => {
    const base = await testBase()
    const sibling = join(base, 'keep.txt')
    await writeFile(sibling, 'keep')
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
      undefined,
      base,
    )
    let localPath = ''
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(false)
      localPath = (result.value as { localPath: string }).localPath
    } finally { await mounted.dispose() }
    await expect(access(localPath)).rejects.toThrow()
    await expect(access(base)).resolves.toBeUndefined()
    await expect(access(sibling)).resolves.toBeUndefined()
  })

  it('does not delete a replacement tree when the selected base is swapped before disposal', async () => {
    const base = await testBase()
    const movedBase = `${base}-moved`
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
      undefined,
      base,
    )
    const result = await run(mounted.ctx)
    expect(result.isError).toBe(false)
    const originalRoot = dirname((result.value as { localPath: string }).localPath)
    await rename(base, movedBase)
    testBases.push(movedBase)
    const replacementRoot = join(base, basename(originalRoot))
    const victim = join(replacementRoot, 'do-not-delete.txt')
    await mkdir(replacementRoot, { recursive: true })
    await writeFile(victim, 'preserve replacement data')

    await mounted.dispose()

    await expect(access(victim)).resolves.toBeUndefined()
  })

  it('deletes its verified file but preserves an unexpected entry', async () => {
    const base = await testBase()
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
      undefined,
      base,
    )
    const result = await run(mounted.ctx)
    expect(result.isError).toBe(false)
    const localPath = (result.value as { localPath: string }).localPath
    const foreignPath = join(dirname(localPath), 'foreign-file.txt')
    await writeFile(foreignPath, 'not owned by the plugin')

    await mounted.dispose()

    await expect(access(localPath)).rejects.toThrow()
    await expect(access(foreignPath)).resolves.toBeUndefined()
  })

  it('does not unlink a replacement file with the same attachment name', async () => {
    const base = await testBase()
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
      undefined,
      base,
    )
    const result = await run(mounted.ctx)
    expect(result.isError).toBe(false)
    const localPath = (result.value as { localPath: string }).localPath
    await rm(localPath)
    await writeFile(localPath, 'replacement data that is not plugin-owned')

    await mounted.dispose()

    await expect(access(localPath)).resolves.toBeUndefined()
  })

  it('cleans a partial custom-directory file when writing fails after creation', async () => {
    const base = await testBase()
    selectedWriteFault.mode = 'partial-fail'
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
      undefined,
      base,
    )
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'REFERENCE_READ_FAILED' })
      expect(selectedWriteFault.path).toContain('dsh-reference-drive-')
      await expect(access(selectedWriteFault.path)).rejects.toThrow()
      expect(await readdir(base)).toEqual([])
    } finally { await mounted.dispose() }
  })

  it('keeps the selected safety tombstone across disposal, delayed failure, and base replacement', async () => {
    const base = await testBase()
    const movedBase = `${base}-after-dispose`
    let announceWrite!: () => void
    const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve })
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    selectedWriteFault.mode = 'pause-fail'
    selectedWriteFault.started = announceWrite
    selectedWriteFault.gate = writeGate
    const mounted = await mount(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
      undefined,
      base,
    )
    const pending = run(mounted.ctx)
    await writeStarted
    const originalRoot = dirname(selectedWriteFault.path)
    const foreignPath = join(originalRoot, 'foreign-file.txt')
    await writeFile(foreignPath, 'force the first cleanup to retain a tombstone')

    await mounted.dispose()
    await expect(access(selectedWriteFault.path)).rejects.toThrow()
    await expect(access(foreignPath)).resolves.toBeUndefined()

    await rename(base, movedBase)
    testBases.push(movedBase)
    const replacementRoot = join(base, basename(originalRoot))
    const victim = join(replacementRoot, 'do-not-delete.txt')
    await mkdir(replacementRoot, { recursive: true })
    await writeFile(victim, 'replacement tree must survive the delayed catch cleanup')
    releaseWrite()

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ code: 'REFERENCE_READ_FAILED' })
    await expect(access(victim)).resolves.toBeUndefined()
    await expect(access(join(movedBase, basename(originalRoot), 'foreign-file.txt'))).resolves.toBeUndefined()
  })

  it('fails with a stable configuration error when the selected directory disappears without falling back', async () => {
    const base = await testBase()
    const missing = join(base, 'removed-download-directory')
    const sibling = join(base, 'keep.txt')
    await writeFile(sibling, 'keep')
    const beforeDefaultRoots = await attachmentRoots()
    const attachment = vi.fn(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
    )
    const mounted = await mount(
      attachment,
      undefined,
      missing,
    )
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
      expect(attachment).not.toHaveBeenCalled()
      expect(await readdir(base)).toEqual(['keep.txt'])
      const afterDefaultRoots = await attachmentRoots()
      expect([...afterDefaultRoots].filter(root => !beforeDefaultRoots.has(root))).toEqual([])
    } finally { await mounted.dispose() }
    await expect(access(base)).resolves.toBeUndefined()
    await expect(access(sibling)).resolves.toBeUndefined()
  })

  it('rejects a non-absolute runtime download directory without writing to the default directory', async () => {
    const beforeDefaultRoots = await attachmentRoots()
    const attachment = vi.fn(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
    )
    const mounted = await mount(
      attachment,
      undefined,
      'relative-download-directory',
    )
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
      expect(attachment).not.toHaveBeenCalled()
      const afterDefaultRoots = await attachmentRoots()
      expect([...afterDefaultRoots].filter(root => !beforeDefaultRoots.has(root))).toEqual([])
    } finally { await mounted.dispose() }
  })

  it('rejects a selected base that is replaced while the cloud file is downloading', async () => {
    const base = await testBase()
    const movedBase = `${base}-during-download`
    const attachment = vi.fn(async () => {
      await rename(base, movedBase)
      testBases.push(movedBase)
      await mkdir(base)
      return { name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }
    })
    const mounted = await mount(attachment, undefined, base)
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
      expect(attachment).toHaveBeenCalledOnce()
      expect(await readdir(base)).toEqual([])
    } finally { await mounted.dispose() }
  })

  it('rejects a symbolic-link or junction selected base before downloading', async () => {
    const target = await testBase()
    const linkedBase = `${target}-linked`
    await symlink(target, linkedBase, process.platform === 'win32' ? 'junction' : 'dir')
    const attachment = vi.fn(
      async () => ({ name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' }),
    )
    const mounted = await mount(attachment, undefined, linkedBase)
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
      expect(attachment).not.toHaveBeenCalled()
    } finally {
      await mounted.dispose()
      await unlink(linkedBase).catch(() => rmdir(linkedBase))
    }
  })

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
