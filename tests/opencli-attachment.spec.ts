import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
// @ts-expect-error The shipped OpenCLI adapter is JavaScript and intentionally has no declaration bundle.
import { ATTACHMENT_SCRIPT, registerProvider } from '../opencli-plugin/common.js'

type AttachmentResult = {
  ok: boolean
  code?: string
  message?: string
  base64?: string
  mimeType?: string
  name?: string
}

type ReaderHarness = {
  response: Record<string, unknown>
  read: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  releaseLock: ReturnType<typeof vi.fn>
  cancelBody: ReturnType<typeof vi.fn>
}

type RegisteredAttachmentCommand = {
  args: Array<{ name: string }>
  func?: (page: Record<string, unknown>, kwargs: Record<string, unknown>) => Promise<unknown>
}

let registeredSite = 0
const registeredSites: string[] = []

function registerAttachmentCommand(): RegisteredAttachmentCommand {
  const site = `dsh-attachment-command-test-${registeredSite++}`
  registeredSites.push(site)
  registerProvider({
    provider: 'chatgpt',
    site,
    domain: 'example.test',
    home: 'https://example.test/',
    whoamiScript: 'async function () {}',
    historyScript: 'async function () {}',
    detailScript: 'async function () {}',
    conversationUrl: (id: string) => `https://example.test/c/${id}`,
  })
  const registry = (globalThis as typeof globalThis & {
    __opencli_registry__?: Map<string, RegisteredAttachmentCommand>
  }).__opencli_registry__
  const command = registry?.get(`${site}/attachment`)
  if (!command?.func) throw new Error('registered attachment command was not found')
  return command
}

afterAll(() => {
  const registry = (globalThis as typeof globalThis & {
    __opencli_registry__?: Map<string, RegisteredAttachmentCommand>
  }).__opencli_registry__
  for (const site of registeredSites) {
    for (const command of ['whoami', 'sync-index', 'history-all', 'detail', 'attachment']) {
      registry?.delete(`${site}/${command}`)
    }
  }
})

function response(chunks: number[][], contentLength: string | null = null, status = 200): ReaderHarness {
  let index = 0
  const read = vi.fn(async () => index < chunks.length
    ? { done: false, value: new Uint8Array(chunks[index++]!) }
    : { done: true, value: undefined })
  const cancel = vi.fn(async () => undefined)
  const releaseLock = vi.fn()
  const cancelBody = vi.fn(async () => undefined)
  return {
    response: {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get: (name: string) => name.toLowerCase() === 'content-length' ? contentLength
          : name.toLowerCase() === 'content-type' ? 'application/octet-stream' : null,
      },
      body: { getReader: () => ({ read, cancel, releaseLock }), cancel: cancelBody },
      arrayBuffer: vi.fn(async () => { throw new Error('arrayBuffer must not be used') }),
    },
    read,
    cancel,
    releaseLock,
    cancelBody,
  }
}

async function runAttachment(
  fetchImpl: ReturnType<typeof vi.fn>,
  args: Record<string, unknown> = { locator: '/files/a.bin', origin: 'https://example.test', maxBytes: 5 },
): Promise<AttachmentResult> {
  const execute = Function('fetch', `return (${ATTACHMENT_SCRIPT})`)(fetchImpl) as (
    value: Record<string, unknown>,
  ) => Promise<string>
  return JSON.parse(await execute(args)) as AttachmentResult
}

describe('OpenCLI attachment browser streaming', () => {
  it('streams a boundary-sized payload without Content-Length or arrayBuffer()', async () => {
    const harness = response([[1, 2], [3, 4, 5]])
    const result = await runAttachment(vi.fn(async () => harness.response))

    expect(Buffer.from(result.base64 || '', 'base64')).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(harness.read).toHaveBeenCalledTimes(3)
    expect(harness.cancel).not.toHaveBeenCalled()
    expect(harness.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('stops and cancels when a dishonest Content-Length hides a streamed overflow', async () => {
    const harness = response([[1, 2, 3], [4, 5, 6]], '1')
    const result = await runAttachment(vi.fn(async () => harness.response))

    expect(result).toMatchObject({ ok: false, code: 'TOO_LARGE', message: 'attachment exceeds maxBytes' })
    expect(harness.read).toHaveBeenCalledTimes(2)
    expect(harness.cancel).toHaveBeenCalledTimes(1)
    expect(harness.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('rejects and cancels an oversized first chunk without reading again', async () => {
    const harness = response([[1, 2, 3, 4, 5, 6]])
    const result = await runAttachment(vi.fn(async () => harness.response))

    expect(result).toMatchObject({ ok: false, code: 'TOO_LARGE', message: 'attachment exceeds maxBytes' })
    expect(harness.read).toHaveBeenCalledTimes(1)
    expect(harness.cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels the response immediately when Content-Length exceeds the limit', async () => {
    const harness = response([], '6')
    const result = await runAttachment(vi.fn(async () => harness.response))

    expect(result).toMatchObject({ ok: false, code: 'TOO_LARGE', message: 'attachment exceeds maxBytes' })
    expect(harness.cancelBody).toHaveBeenCalledTimes(1)
    expect(harness.read).not.toHaveBeenCalled()
  })

  it('rejects a response that ends before its positive Content-Length', async () => {
    const harness = response([[1, 2, 3]], '5')
    const result = await runAttachment(vi.fn(async () => harness.response))

    expect(result).toMatchObject({ ok: false, message: 'attachment download was truncated' })
    expect(harness.read).toHaveBeenCalledTimes(2)
    expect(harness.cancel).not.toHaveBeenCalled()
    expect(harness.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('refuses cross-origin locators before fetching', async () => {
    const fetchImpl = vi.fn()
    const result = await runAttachment(fetchImpl, {
      locator: 'https://evil.example/file', origin: 'https://example.test', maxBytes: 5,
    })

    expect(result).toMatchObject({ ok: false, message: 'cross-origin locator refused' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin final response and cancels its body', async () => {
    const harness = response([[1, 2]])
    harness.response.url = 'https://cdn.example/file'
    const fetchImpl = vi.fn(async () => harness.response)
    const result = await runAttachment(fetchImpl)

    expect(result).toMatchObject({ ok: false, message: 'cross-origin redirect refused' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/files/a.bin',
      { credentials: 'include', redirect: 'error' },
    )
    expect(harness.cancelBody).toHaveBeenCalledOnce()
  })

  it('preserves authentication and HTTP failures', async () => {
    const auth = response([], null, 403)
    const unavailable = response([], null, 503)

    await expect(runAttachment(vi.fn(async () => auth.response))).resolves.toMatchObject({ ok: false, code: 'AUTH' })
    await expect(runAttachment(vi.fn(async () => unavailable.response)))
      .resolves.toMatchObject({ ok: false, message: 'attachment HTTP 503' })
    expect(auth.cancelBody).toHaveBeenCalledTimes(1)
    expect(unavailable.cancelBody).toHaveBeenCalledTimes(1)
  })
})

describe('OpenCLI attachment account authorization', () => {
  it('accepts the synchronized identity and refuses a different active identity', async () => {
    // @ts-expect-error The shipped OpenCLI adapter is JavaScript and intentionally has no declaration bundle.
    const { parseExpectedAccountScope, verifyAccountScope } = await import('../opencli-plugin/common.js')
    const expected = createHash('sha256').update('chatgpt\0account-a').digest('hex')

    expect(parseExpectedAccountScope(undefined)).toBe('')
    expect(parseExpectedAccountScope(expected)).toBe(expected)
    for (const invalid of ['', ' ', 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(() => parseExpectedAccountScope(invalid)).toThrow(/accountScope/)
    }
    expect(() => verifyAccountScope('chatgpt', 'dsh-chatgpt', expected, 'account-a')).not.toThrow()
    expect(() => verifyAccountScope('chatgpt', 'dsh-chatgpt', expected, 'account-b'))
      .toThrow(/DSH_ACCOUNT_SCOPE_MISMATCH/)
  })

  it('waits for a stable identity before materializing an authorized attachment', async () => {
    const command = registerAttachmentCommand()
    const expected = createHash('sha256').update('chatgpt\0account-a').digest('hex')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-opencli-attachment-'))
    const output = join(directory, 'attachment.bin')
    let evaluations = 0
    const page = {
      goto: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => {
        evaluations++
        if (evaluations === 1) return JSON.stringify({ ok: true, identity: '' })
        if (evaluations === 2) return JSON.stringify({ ok: true, identity: 'account-a' })
        return JSON.stringify({ ok: true, base64: 'AQID', name: 'attachment.bin' })
      }),
      closeTab: vi.fn(async () => undefined),
    }

    try {
      await expect(command.func!(page, {
        locator: '/files/attachment.bin', output, accountScope: expected, maxBytes: 3,
      })).resolves.toEqual([expect.objectContaining({
        attachmentId: '/files/attachment.bin', size: 3, status: 'available', localPath: output,
      })])
      await expect(readFile(output)).resolves.toEqual(Buffer.from([1, 2, 3]))
      expect(command.args.map(arg => arg.name)).toContain('accountScope')
      expect(page.evaluate).toHaveBeenCalledTimes(3)
      expect(page.closeTab).toHaveBeenCalledOnce()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses a different active account before download and preserves the output', async () => {
    const command = registerAttachmentCommand()
    const expected = createHash('sha256').update('chatgpt\0account-a').digest('hex')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-opencli-attachment-'))
    const output = join(directory, 'existing.bin')
    const marker = Buffer.from('keep-existing-output')
    await writeFile(output, marker)
    const page = {
      goto: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => JSON.stringify({ ok: true, identity: 'account-b' })),
      closeTab: vi.fn(async () => { throw new Error('tab already closed') }),
    }

    try {
      await expect(command.func!(page, {
        locator: '/files/attachment.bin', output, accountScope: expected, maxBytes: 1024,
      })).rejects.toThrow(/DSH_ACCOUNT_SCOPE_MISMATCH/)
      expect(page.evaluate).toHaveBeenCalledOnce()
      await expect(readFile(output)).resolves.toEqual(marker)
      expect(page.closeTab).toHaveBeenCalledOnce()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { code: 'AUTH', message: /not logged in/i },
    { code: 'RATE_LIMIT', message: /rate limit/i },
  ])('preserves the $code identity failure without downloading or writing', async ({ code, message }) => {
    const command = registerAttachmentCommand()
    const expected = createHash('sha256').update('chatgpt\0account-a').digest('hex')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-opencli-attachment-'))
    const output = join(directory, 'existing.bin')
    const marker = Buffer.from('keep-existing-output')
    await writeFile(output, marker)
    const page = {
      goto: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => JSON.stringify({ ok: false, code })),
      closeTab: vi.fn(async () => undefined),
    }

    try {
      await expect(command.func!(page, {
        locator: '/files/attachment.bin', output, accountScope: expected, maxBytes: 1024,
      })).rejects.toThrow(message)
      expect(page.evaluate).toHaveBeenCalledOnce()
      await expect(readFile(output)).resolves.toEqual(marker)
      expect(page.closeTab).toHaveBeenCalledOnce()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
