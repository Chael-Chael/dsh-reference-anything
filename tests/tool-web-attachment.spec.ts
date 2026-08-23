import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import { OpenCliError } from '../src/opencli.ts'
import * as tool from '../src/tool.ts'
import { encodeReferenceUri } from '../src/uri.ts'
import type { ReferenceSource } from '../src/types.ts'

const runnerAttachment = vi.hoisted(() => vi.fn())

vi.mock('../src/opencli.ts', async (load) => {
  const actual = await load<typeof import('../src/opencli.ts')>()
  return {
    ...actual,
    OpenCliRunner: class {
      attachment(...args: unknown[]) { return runnerAttachment(...args) }
    },
  }
})

const conversationId = 'web-conversation'
const ref = { source: 'web-chat', id: conversationId }
const expectedScope = 'a'.repeat(64)

function source(): ReferenceSource {
  return {
    id: 'web-chat',
    available: async () => true,
    list: async () => [],
    read: async () => { throw new Error('not used') },
  }
}

async function mount(accountScope = expectedScope) {
  const ctx = new Context()
  await ctx.plugin(ReferenceRuntime, {})
  ctx.references.registerSource(source())
  const history = {
    store: {
      settings: { historyMode: 'full', opencliPath: 'opencli', profile: '' },
      conversations: new Map([[conversationId, {
        provider: 'chatgpt', accountScope, currentRevision: 'revision-1',
      }]]),
      attachment: () => ({
        attachmentId: 'asset-1', name: 'asset.bin', mimeType: 'application/octet-stream', size: 3,
        status: 'available', locator: '/backend-api/files/asset-1',
      }),
    },
  }
  const provided = ctx.provide('referenceChatHistory', history as never)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const fiber = await ctx.plugin(tool, {})
  return {
    ctx,
    dispose: async () => {
      await fiber.dispose()
      if (typeof provided === 'function') await provided()
    },
  }
}

let call = 0
function run(ctx: Context) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `web-attachment-${++call}` as never,
    name: 'reference_attachment_read',
    arguments: { uri: encodeReferenceUri(ref), attachmentId: 'asset-1' },
  })
}

function webRoots() {
  return readdir(tmpdir()).then(names => new Set(names.filter(name => name.startsWith('dsh-reference-attachment-'))))
}

beforeEach(() => { runnerAttachment.mockReset() })

describe('reference_attachment_read Web authorization boundary', () => {
  it('passes the synchronized account scope and keeps a successful file until disposal', async () => {
    runnerAttachment.mockImplementationOnce(async (_provider, _locator, output: string) => {
      await writeFile(output, new Uint8Array([1, 2, 3]))
      return { size: 3 }
    })
    const mounted = await mount()
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(false)
      expect(runnerAttachment).toHaveBeenLastCalledWith(
        'chatgpt', '/backend-api/files/asset-1', expect.any(String), tool.MAX_ATTACHMENT_BYTES,
        expect.any(AbortSignal), expectedScope,
      )
      await expect(access((result.value as { localPath: string }).localPath)).resolves.toBeUndefined()
    } finally { await mounted.dispose() }
  })

  it('maps a different active account to the stable recovery error and cleans up immediately', async () => {
    const before = await webRoots()
    runnerAttachment.mockRejectedValueOnce(new OpenCliError('wrong account', 'PROVIDER_ACCOUNT_MISMATCH'))
    const mounted = await mount()
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'REFERENCE_ACCOUNT_MISMATCH' })
      expect(result.error?.message).toContain('sync chatgpt and reselect')
      const after = await webRoots()
      expect([...after].filter(root => !before.has(root))).toEqual([])
    } finally { await mounted.dispose() }
  })

  it('fails closed when a legacy conversation has no verified account scope', async () => {
    const mounted = await mount('')
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'REFERENCE_ACCOUNT_MISMATCH' })
      expect(result.error?.message).toContain('sync chatgpt and reselect')
      expect(runnerAttachment).not.toHaveBeenCalled()
    } finally { await mounted.dispose() }
  })

  it.each([' ', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}x`])(
    'fails closed for a noncanonical account scope %j',
    async (accountScope) => {
      const mounted = await mount(accountScope)
      try {
        const result = await run(mounted.ctx)
        expect(result.error?.info).toMatchObject({ code: 'REFERENCE_ACCOUNT_MISMATCH' })
        expect(runnerAttachment).not.toHaveBeenCalled()
      } finally { await mounted.dispose() }
    },
  )

  it('does not retain a file recreated by an in-flight download after disposal', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let output = ''
    runnerAttachment.mockImplementationOnce(async (_provider, _locator, path: string) => {
      output = path
      await gate
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, new Uint8Array([1, 2, 3]))
      return { size: 3 }
    })
    const mounted = await mount()
    const pending = run(mounted.ctx)
    await vi.waitFor(() => expect(runnerAttachment).toHaveBeenCalledOnce())
    await mounted.dispose()
    release()
    const result = await pending
    expect(result.error?.info).toMatchObject({ code: 'REFERENCE_CANCELLED' })
    await expect(access(output)).rejects.toThrow()
  })

  it('maps provider and size failures to stable package errors', async () => {
    const mounted = await mount()
    try {
      runnerAttachment.mockRejectedValueOnce(new OpenCliError('provider failed', 'OPENCLI_FAILED'))
      const providerFailure = await run(mounted.ctx)
      expect(providerFailure.error?.info).toMatchObject({ code: 'REFERENCE_READ_FAILED' })

      runnerAttachment.mockRejectedValueOnce(new OpenCliError('too large', 'ATTACHMENT_TOO_LARGE'))
      const oversized = await run(mounted.ctx)
      expect(oversized.error?.info).toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' })

      runnerAttachment.mockRejectedValueOnce(new OpenCliError('provider rate limit reached', 'PROVIDER_RATE_LIMIT'))
      const rateLimited = await run(mounted.ctx)
      expect(rateLimited.error?.info).toMatchObject({ code: 'PROVIDER_RATE_LIMIT' })
    } finally { await mounted.dispose() }
  })
})
