import { describe, expect, it } from 'vitest'
import { conversationMentions } from '../src/client/components.tsx'
import { conversationReferenceUri, createCommandSource, createConversationSource, createSessionSource, createSkillSource, createWorkspaceSource, parseQuery } from '../src/client/source.ts'
import { REFERENCE_ANYTHING_INVOCATIONS } from '../src/contract.ts'
import { decodeReferenceUri } from '../src/uri.ts'

describe('conversation client references', () => {
  it('uses the canonical opaque dsh-ref URI accepted by the host', () => {
    const uri = conversationReferenceUri('chatgpt\0scope\0conversation-1')
    expect(uri).toMatch(/^dsh-ref:[A-Za-z0-9_-]+$/)
    expect(decodeReferenceUri(uri)).toEqual({ source: 'web-chat', id: 'chatgpt\0scope\0conversation-1' })
    expect(uri).not.toContain('web-chat/')
  })

  it('recognizes a canonical conversation mention in the dock', () => {
    const uri = conversationReferenceUri('claude\0scope\0conversation-2')
    expect(conversationMentions(`compare @[Claude · Design](${uri}) now`)).toEqual([{
      label: 'Claude · Design', uri, start: 8, end: 8 + `@[Claude · Design](${uri})`.length,
    }])
  })

  it('parses a provider prefix without treating ordinary search text as one', () => {
    expect(parseQuery('chatgpt cache design')).toEqual({ provider: 'chatgpt', query: 'cache design' })
    expect(parseQuery('cache design')).toEqual({ query: 'cache design' })
  })

  it('inserts a visual composer chip while serializing the canonical mention on send', async () => {
    const source = createConversationSource(async () => [])
    const row = {
      uriId: 'chatgpt\0scope\0conversation-3', provider: 'chatgpt' as const,
      title: 'BiWM SFT Loss 解释', turnCount: 4, updatedAt: '2026-08-17T00:00:00.000Z', syncedAt: '2026-08-17T00:00:00.000Z', partial: false, url: 'https://example.test',
      matchedVia: 'recent' as const,
    }
    const outcome = source.onPick({
      candidate: { name: row.title, conversation: row }, session: { sessionId: 'session-1' as never },
      position: 'inline', via: 'menu', span: { start: 0, end: 1, draftRev: 1 },
    })
    expect(outcome).toMatchObject({ insert: { source: 'External conversations', label: '💬 ChatGPT · BiWM SFT Loss 解释' } })
    if (outcome === undefined || outcome === 'handled' || !('insert' in outcome)) throw new Error('expected reference insert')
    await expect(source.codec?.serialize(outcome.insert.ref, new AbortController().signal))
      .resolves.toBe(`@[ChatGPT · BiWM SFT Loss 解释](${conversationReferenceUri(row.uriId)})`)
  })

  it('groups workspace paths and serializes a compact dsh-file chip', async () => {
    const source = createWorkspaceSource(async () => [{ path: 'src/index.ts', kind: 'file' }])
    const candidates = await source.candidates({ sessionId: 'session-1' as never }, { query: 'index', position: 'inline', signal: new AbortController().signal })
    expect(source.name).toBe('Files and folders')
    const outcome = source.onPick({ candidate: candidates[0]!, session: { sessionId: 'session-1' as never }, position: 'inline', via: 'menu', span: { start: 0, end: 1, draftRev: 1 } })
    if (outcome === undefined || outcome === 'handled' || !('insert' in outcome)) throw new Error('expected file insert')
    expect(outcome.insert.label).toBe('📄 index.ts')
    await expect(source.codec?.serialize(outcome.insert.ref, new AbortController().signal)).resolves.toMatch(/^@\[index\.ts\]\(dsh-file:[A-Za-z0-9_-]+\)$/u)
  })

  it('uses the official dsh-session URI returned by the host', async () => {
    const uri = 'dsh-session:InNvdXJjZSI'
    const source = createSessionSource(async () => [{ sessionId: uri, label: '项目聊天导出', cwd: 'D:\\repo', createdAt: 1 }])
    const candidates = await source.candidates({ sessionId: 'session-1' as never }, { query: '', position: 'inline', signal: new AbortController().signal })
    expect(source.name).toBe('DSH sessions')
    const outcome = source.onPick({ candidate: candidates[0]!, session: { sessionId: 'session-1' as never }, position: 'inline', via: 'menu', span: { start: 0, end: 1, draftRev: 1 } })
    if (outcome === undefined || outcome === 'handled' || !('insert' in outcome)) throw new Error('expected session insert')
    await expect(source.codec?.serialize(outcome.insert.ref, new AbortController().signal)).resolves.toBe(`@[项目聊天导出](${uri})`)
  })

  it('exposes host commands in the leading @ panel and hands execution back to the native slash pipeline', async () => {
    const source = createCommandSource(async () => [{ name: 'plan', description: 'Plan mode' }])
    const candidates = await source.candidates({ sessionId: 'session-1' as never }, { query: 'pla', position: 'leading', signal: new AbortController().signal })
    expect(candidates).toEqual([expect.objectContaining({ name: 'plan', commandName: 'plan' })])
    expect(source.onPick({ candidate: candidates[0]!, session: { sessionId: 'session-1' as never }, position: 'leading', via: 'menu', span: { start: 0, end: 4, draftRev: 1 } })).toEqual({ text: '/plan ' })
    await expect(source.candidates({ sessionId: 'session-1' as never }, { query: '', position: 'inline', signal: new AbortController().signal })).resolves.toEqual([])
  })

  it('exposes filesystem-backed skills in the leading @ panel', async () => {
    const source = createSkillSource(async () => [{ name: 'review', description: 'Review code', modelInvocable: false }])
    const candidates = await source.candidates({ sessionId: 'session-1' as never }, { query: 'rev', position: 'leading', signal: new AbortController().signal })
    expect(candidates).toEqual([expect.objectContaining({ name: 'review', description: 'user-only · Review code', skillName: 'review' })])
    expect(source.onPick({ candidate: candidates[0]!, session: { sessionId: 'session-1' as never }, position: 'leading', via: 'menu', span: { start: 0, end: 4, draftRev: 1 } })).toEqual({ text: '/review ' })
  })

  it('declares search cancellation so the input-trigger AbortSignal is accepted by the Remote API', () => {
    const search = REFERENCE_ANYTHING_INVOCATIONS.find(descriptor => descriptor.method === 'search')
    expect(search?.cancellation).toEqual({ parameter: 'signal' })
    expect(REFERENCE_ANYTHING_INVOCATIONS.find(descriptor => descriptor.method === 'workspaceSearch')?.cancellation).toEqual({ parameter: 'signal' })
    expect(REFERENCE_ANYTHING_INVOCATIONS.find(descriptor => descriptor.method === 'sessionSearch')?.cancellation).toEqual({ parameter: 'signal' })
  })
})
