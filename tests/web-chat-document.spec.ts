import { beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ReferenceRuntime from '../src/index.ts'
import * as mention from '../src/reference-prestep.ts'
import * as tool from '../src/tool.ts'
import { formatReferenceMention } from '../src/uri.ts'
import { ConversationStore, type ProviderTurnRow } from '../src/store/store.ts'
import { webReferencePlugin } from '../src/sources/web-chat/document.ts'
import { ReferenceAnythingError } from '../src/errors.ts'

const scope = 'a'.repeat(64)
const row = (ordinal: number, role: 'user' | 'assistant', text: string, attachments: unknown[] = []): ProviderTurnRow => ({
  conversationId: 'c1', ordinal, messageId: `m${ordinal}`, parentId: '', branchId: '', activeBranch: true, role, text,
  createdAt: '', attachmentsJson: JSON.stringify(attachments), partial: false,
})

let rows: ProviderTurnRow[]
let enabled: string[]
let historyMode: 'metadata-only' | 'offline-mirror'
let includeThinking: boolean
let liveFails: boolean
let ctx: Context
let agent: Agent
const conversations = new Map<string, Record<string, unknown>>()
const key = ConversationStore.conversationKey('deepseek', scope, 'c1')
const id = 'deepseek:c1'
const fake = {
  id: 'web-chat',
  store: {
    conversations: { entries: () => conversations.entries(), get: (value: string) => conversations.get(value) },
    get settings() { return { historyMode, enabledProviders: enabled, includeThinking } },
    read: () => ({ body: { kind: 'conversation', items: [{ role: 'user', text: 'mirrored question' }] } }),
  },
  providerEnabled: (provider: string) => enabled.includes(provider),
  async liveDetail() {
    if (liveFails) throw new ReferenceAnythingError('could not fetch the conversation from deepseek', 'REFERENCE_READ_FAILED')
    return rows
  },
  listEnabled: () => [...conversations.entries()].filter(([, value]) => enabled.includes(String(value.provider))).map(([key, value]) => ({ key, row: value })),
  runner: () => { throw new Error('no runner in this test') },
}

beforeEach(async () => {
  rows = [row(1, 'user', '第一问 🌏'), row(2, 'assistant', '回答一', [{ id: 'img1', kind: 'image', name: 'shot.png', mimeType: 'image/png', locator: '/file/1', status: 'available' }]), row(3, 'user', '第二问')]
  enabled = ['deepseek']
  historyMode = 'metadata-only'
  includeThinking = false
  liveFails = false
  conversations.clear()
  conversations.set(key, { provider: 'deepseek', externalId: 'c1', accountScope: scope, title: '缓存讨论', url: '', updatedAt: '2026-11-01T00:00:00Z', partial: false, remoteMissing: false, currentRevision: 'r1' })
  ctx = new Context()
  await ctx.plugin(ReferenceRuntime, {})
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(tool, {})
  await ctx.plugin(mention, {})
  ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }) })
  ctx.references.registerPlugin(webReferencePlugin(fake as never))
  agent = { session: Session.create(SessionId('web-doc')), options: { provider: 'test', model: 'test' } } as Agent
  ctx.references.grantPlugin(String(agent.session.id), 'web', id)
})

const call = (args: unknown) => ctx.tools.execute({ agent, signal: new AbortController().signal, callId: 't' as never, name: 'reference', arguments: JSON.parse(JSON.stringify(args)) })
const text = (result: { content: readonly { type: string; text?: string }[] }) => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const value = (result: Awaited<ReturnType<typeof call>>): any => { expect(result.isError, text(result)).not.toBe(true); return result.value }
const preStep = async (text: string) => {
  const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })]
  const result = await ctx.waterfall('agent/pre-step', { agent, messages, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages }))
  if (result.kind !== 'enter') throw new Error('rejected')
  const context = result.messages[1]!.content.map(block => block.type === 'text' ? block.text : '').join('')
  return JSON.parse(context.split('<references>')[1]!.split('</references>')[0]!)
}

it('reads a web chat with next and lists its attachments as children', async () => {
  const first = value(await call({ source: 'web', id, op: 'read', args: { limit: 2 } }))
  expect(first.content).toEqual([{ n: 1, role: 'user', text: '第一问 🌏' }, { n: 2, role: 'assistant', text: '回答一', children: true }])
  const second = value(await call({ source: 'web', id, op: 'read', args: { next: first.next } }))
  expect(second.content).toEqual([{ n: 3, role: 'user', text: '第二问' }])
  expect(second.next).toBeNull()
  const children = value(await call({ source: 'web', id, op: 'list' }))
  expect(children.items).toEqual([{ source: 'web', id: `${id}>1`, title: 'shot.png', kind: 'image' }])
})

it('reports a stale position after the chat grows and rejects foreign fields', async () => {
  const first = value(await call({ source: 'web', id, op: 'read', args: { limit: 1 } }))
  rows = [...rows, row(4, 'assistant', 'new turn')]
  expect(JSON.parse(text(await call({ source: 'web', id, op: 'read', args: { next: first.next } })).replace(/^Error: /u, ''))).toMatchObject({ code: 'REVISION_CHANGED', retry: 'restart' })
  expect(value(await call({ source: 'web', id, op: 'read' })).content).toHaveLength(4)
  expect(text(await call({ source: 'web', id, op: 'read', args: { path: 'x' } }))).toContain('INVALID_ARGS')
  expect(text(await call({ source: 'web', id, op: 'list', args: { agent: 'codex' } }))).toContain('INVALID_ARGS')
})

it('searches inside a chat', async () => {
  const result = value(await call({ source: 'web', id, op: 'search', args: { query: '第二' } }))
  expect(result.hits).toMatchObject([{ source: 'web', id, excerpt: '第二问' }])
  expect(value(await call({ source: 'web', id, op: 'read', args: result.hits[0].args })).content[0]).toMatchObject({ n: 3, text: '第二问' })
})

it('enforces the provider switch and the local index on every read', async () => {
  enabled = []
  expect(text(await call({ source: 'web', id, op: 'read' }))).toContain('switched off')
  enabled = ['deepseek']
  ctx.references.grantPlugin(String(agent.session.id), 'web', 'deepseek:missing')
  expect(text(await call({ source: 'web', id: 'deepseek:missing', op: 'read' }))).toContain('missing from the local deepseek index')
})

it('falls back to an opted-in offline copy with a notice, never silently', async () => {
  liveFails = true
  expect(text(await call({ source: 'web', id, op: 'read' }))).toContain('could not fetch')
  historyMode = 'offline-mirror'
  const page = value(await call({ source: 'web', id, op: 'read' }))
  expect(page.content).toEqual([{ n: 1, role: 'user', text: 'mirrored question' }])
  expect(page.notice).toMatch(/Offline copy/)
})

it('lists web chats with a provider filter, without granting them', async () => {
  const all = value(await call({ source: 'web', op: 'list' }))
  expect(all.items).toMatchObject([{ source: 'web', id, title: '缓存讨论', kind: 'deepseek' }])
  expect(value(await call({ source: 'web', op: 'list', args: { provider: 'deepseek' } })).items).toHaveLength(1)
  expect(value(await call({ source: 'web', op: 'list', args: { query: 'nothing' } })).items).toEqual([])
  agent = { ...agent, session: Session.create(SessionId('web-other')) } as Agent
  expect(text(await call({ source: 'web', id, op: 'read' }))).toContain('UNAUTHORIZED')
})

it('previews a web mention inline at send time with the plugin id and source usage', async () => {
  agent = { ...agent, session: Session.create(SessionId('web-mention')) } as Agent
  const body = await preStep(formatReferenceMention({ source: 'web-chat', id: key }, '缓存讨论') + ' 总结一下')
  expect(body.sources).toMatchObject([{ source: 'web', usage: expect.stringContaining('Web AI chats') }])
  const [preview] = body.references
  expect(preview).toMatchObject({ source: 'web', id, title: '缓存讨论', total: 3 })
  expect(preview.content.map((item: { text: string }) => item.text)).toEqual(['第一问 🌏', '回答一', '第二问'])
  expect(JSON.stringify(body)).not.toContain(scope)
  // The mention granted this task.
  expect(value(await call({ source: 'web', id, op: 'read' })).content).toHaveLength(3)
})

it('states the full record count when the preview keeps only the tail', async () => {
  rows = Array.from({ length: 12 }, (_, index) => row(index + 1, index % 2 ? 'assistant' : 'user', `${index + 1}:` + 'x'.repeat(4000)))
  const [preview] = (await preStep(formatReferenceMention({ source: 'web-chat', id: key }, '缓存讨论'))).references
  expect(preview.total).toBe(12)
  expect(preview.content[0].n).toBeGreaterThan(1)
  expect(preview.content.at(-1).n).toBe(12)
})

it('leaves thinking out unless the user includes it', async () => {
  rows = [row(1, 'user', '问'), { ...row(2, 'assistant', '答'), thinking: '先想一想' }]
  expect(value(await call({ source: 'web', id, op: 'read' })).content).toEqual([{ n: 1, role: 'user', text: '问' }, { n: 2, role: 'assistant', text: '答' }])
  includeThinking = true
  expect(value(await call({ source: 'web', id, op: 'read' })).content[1].text).toBe('<thinking>\n先想一想\n</thinking>\n\n答')
})

it('rejects a second plugin under the same source', () => {
  expect(() => ctx.references.registerPlugin(webReferencePlugin(fake as never))).toThrow(/already registered/)
})

it('does not wrap a plain source that a native plugin already answers for', async () => {
  const old = { id: 'web-chat', available: async () => true, list: async () => [{ ref: { source: 'web-chat', id: key }, label: '缓存讨论' }], read: async () => { throw new Error('unused') } }
  ctx.references.registerSource(old as never)
  expect(ctx.references.pluginList().map(plugin => plugin.source)).toEqual(['web'])
  expect(ctx.references.resolveMention({ source: 'web-chat', id: key })).toMatchObject({ id })
})
