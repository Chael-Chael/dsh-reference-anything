import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import { MAX_DOWNLOAD_BYTES } from '../src/local-reference.ts'
import { OpenCliError } from '../src/opencli.ts'
import { ConversationStore, type ProviderTurnRow } from '../src/store/store.ts'
import { webReferencePlugin } from '../src/sources/web-chat/document.ts'
import * as tool from '../src/tool.ts'

const runnerAttachment = vi.fn()
const expectedScope = 'a'.repeat(64)
const row = (ordinal: number, role: 'user' | 'assistant', text: string, attachments: unknown[] = []): ProviderTurnRow => ({
  conversationId: 'c1', ordinal, messageId: `m${ordinal}`, parentId: '', branchId: '', activeBranch: true, role, text,
  createdAt: '', attachmentsJson: JSON.stringify(attachments), partial: false,
})
const rows = [
  row(1, 'user', 'see the file', [{ id: 'asset-1', kind: 'file', name: 'asset.bin', mimeType: 'application/octet-stream', size: 3, locator: '/backend-api/files/asset-1', status: 'available' }]),
  row(2, 'assistant', 'read it'),
]

async function mount(accountScope = expectedScope) {
  const ctx = new Context()
  await ctx.plugin(ReferenceRuntime, {})
  const key = ConversationStore.conversationKey('chatgpt', accountScope, 'c1')
  const conversations = new Map<string, Record<string, unknown>>([[key, {
    provider: 'chatgpt', externalId: 'c1', accountScope, title: 'files', url: '', updatedAt: '', partial: false, remoteMissing: false, currentRevision: 'r1',
  }]])
  const history = {
    id: 'web-chat',
    store: {
      conversations: { entries: () => conversations.entries(), get: (id: string) => conversations.get(id) },
      settings: { historyMode: 'metadata-only', enabledProviders: ['chatgpt'], includeThinking: false },
    },
    providerEnabled: (provider: string) => provider === 'chatgpt',
    liveDetail: async () => rows,
    listEnabled: () => [],
    runner: () => ({ attachment: runnerAttachment }),
  }
  ctx.references.registerPlugin(webReferencePlugin(history as never))
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const fiber = await ctx.plugin(tool, {})
  return { ctx, dispose: () => fiber.dispose() }
}

const agent = { session: Session.create(SessionId('web-attachment')) } as Agent
const id = 'chatgpt:c1'
let call = 0
async function run(ctx: Context) {
  ctx.references.grantPlugin(String(agent.session.id), 'web', id)
  return ctx.tools.execute({
    agent, signal: new AbortController().signal, callId: `web-attachment-${++call}` as never,
    name: 'reference', arguments: { source: 'web', id: `${id}>1`, op: 'read', args: { as: 'file' } },
  })
}

function webRoots() {
  return readdir(tmpdir()).then(names => new Set(names.filter(name => name.startsWith('dsh-reference-attachment-'))))
}

beforeEach(() => { runnerAttachment.mockReset() })

describe('web file children: authorization boundary', () => {
  it('lists non-image files of a web chat as children', async () => {
    const mounted = await mount()
    try {
      mounted.ctx.references.grantPlugin(String(agent.session.id), 'web', id)
      const page = await mounted.ctx.tools.execute({ agent, signal: new AbortController().signal, callId: 'web-list' as never, name: 'reference', arguments: { source: 'web', id, op: 'list' } })
      expect((page.value as { items: unknown[] }).items).toEqual([{ source: 'web', id: `${id}>1`, title: 'asset.bin', kind: 'file', size: 3 }])
    } finally { await mounted.dispose() }
  })

  it('passes the synchronized account scope and the 50 MiB cap, and keeps a successful file until disposal', async () => {
    runnerAttachment.mockImplementationOnce(async (_provider, _locator, output: string) => {
      await writeFile(output, new Uint8Array([1, 2, 3]))
      return { size: 3 }
    })
    const mounted = await mount()
    let localPath = ''
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(false)
      expect(runnerAttachment).toHaveBeenLastCalledWith(
        'chatgpt', '/backend-api/files/asset-1', expect.any(String), MAX_DOWNLOAD_BYTES,
        expect.any(AbortSignal), expectedScope,
      )
      localPath = (result.value as { localPath: string }).localPath
      await expect(access(localPath)).resolves.toBeUndefined()
    } finally { await mounted.dispose() }
    await expect(access(localPath)).rejects.toThrow()
  })

  it('maps a different active account to the stable recovery error and cleans up immediately', async () => {
    const before = await webRoots()
    runnerAttachment.mockRejectedValueOnce(new OpenCliError('wrong account', 'PROVIDER_ACCOUNT_MISMATCH'))
    const mounted = await mount()
    try {
      const result = await run(mounted.ctx)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: 'UNAUTHORIZED' })
      expect(result.error?.message).toContain('sync chatgpt and reselect')
      const after = await webRoots()
      expect([...after].filter(root => !before.has(root))).toEqual([])
    } finally { await mounted.dispose() }
  })

  it.each(['a'.repeat(63), `${'a'.repeat(64)}x`, 'A'.repeat(64), ' '])(
    'fails closed without downloading for a stored account scope %j',
    async (accountScope) => {
      const mounted = await mount(accountScope)
      try {
        const result = await run(mounted.ctx)
        expect(result.isError).toBe(true)
        expect(['UNAUTHORIZED', 'NOT_FOUND']).toContain((result.error?.info as { code?: string }).code)
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
      expect(providerFailure.error?.info).toMatchObject({ code: 'SOURCE_UNAVAILABLE' })

      runnerAttachment.mockRejectedValueOnce(new OpenCliError('too large', 'ATTACHMENT_TOO_LARGE'))
      const oversized = await run(mounted.ctx)
      expect(oversized.error?.info).toMatchObject({ code: 'SOURCE_UNAVAILABLE' })

      runnerAttachment.mockRejectedValueOnce(new OpenCliError('provider rate limit reached', 'PROVIDER_RATE_LIMIT'))
      const rateLimited = await run(mounted.ctx)
      expect(rateLimited.error?.info).toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
      expect(rateLimited.error?.message).toContain('rate')
    } finally { await mounted.dispose() }
  })
})
