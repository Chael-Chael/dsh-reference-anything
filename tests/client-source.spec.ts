import { describe, expect, it } from 'vitest'
import { conversationMentions } from '../src/client/components.tsx'
import { conversationReferenceUri, describeRow, disambiguate, parseProviderQuery } from '../src/client/source.ts'
import type { SearchResult } from '../src/client/remote.ts'
import { REFERENCE_ANYTHING_INVOCATIONS } from '../src/contract.ts'
import { decodeReferenceUri } from '../src/uri.ts'

function row(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    uriId: 'id', provider: 'chatgpt', title: 'Cache design notes', url: 'https://example.test/c/1',
    updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
    turnCount: 24, partial: false, syncedAt: new Date().toISOString(), matchedVia: 'title', ...overrides,
  }
}

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
    expect(parseProviderQuery('chatgpt cache design')).toEqual({ provider: 'chatgpt', query: 'cache design' })
    expect(parseProviderQuery('cache design')).toEqual({ query: 'cache design' })
  })

  it('describes a title hit with its provider, age, and size', () => {
    expect(describeRow(row())).toBe('ChatGPT · 3d ago · 24 turns')
    expect(describeRow(row({ partial: true }))).toBe('ChatGPT · 3d ago · 24 turns · partial')
  })

  it('shows the matched excerpt instead of the turn count when the title did not match', () => {
    const described = describeRow(row({ title: 'New chat', matchedVia: 'content', snippet: '…used pgvector for…' }))
    expect(described).toBe('ChatGPT · 3d ago · …used pgvector for…')
    expect(described).not.toContain('turns')
  })

  it('numbers repeated titles so the menu can key and resolve rows by name', () => {
    const numbered = disambiguate([
      { name: 'New chat' }, { name: 'Cache design' }, { name: 'New chat' }, { name: 'New chat' },
    ])
    expect(numbered.map(item => item.name)).toEqual(['New chat', 'Cache design', 'New chat (2)', 'New chat (3)'])
  })

  it('does not let a generated suffix collide with a title that already looks like one', () => {
    const numbered = disambiguate([{ name: 'New chat' }, { name: 'New chat (2)' }, { name: 'New chat' }])
    expect(numbered.map(item => item.name)).toEqual(['New chat', 'New chat (2)', 'New chat (3)'])
    expect(new Set(numbered.map(item => item.name)).size).toBe(numbered.length)
  })

  it('declares search cancellation so the input-trigger AbortSignal is accepted by the Remote API', () => {
    const search = REFERENCE_ANYTHING_INVOCATIONS.find(descriptor => descriptor.method === 'search')
    expect(search?.cancellation).toEqual({ parameter: 'signal' })
  })

  it('registers the management-list RPC surface added for continuous sync and browse/delete', () => {
    const methods = REFERENCE_ANYTHING_INVOCATIONS.map(descriptor => descriptor.method)
    expect(methods).toEqual(expect.arrayContaining(['browse', 'deleteConversation', 'syncStates']))

    const browse = REFERENCE_ANYTHING_INVOCATIONS.find(descriptor => descriptor.method === 'browse')
    expect(browse?.cancellation).toEqual({ parameter: 'signal' })

    const deleteConversation = REFERENCE_ANYTHING_INVOCATIONS.find(descriptor => descriptor.method === 'deleteConversation')
    expect(deleteConversation?.cancellation).toEqual({ parameter: 'signal' })

    const syncStates = REFERENCE_ANYTHING_INVOCATIONS.find(descriptor => descriptor.method === 'syncStates')
    expect(syncStates?.cancellation).toBeUndefined()
  })
})
