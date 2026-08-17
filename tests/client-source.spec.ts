import { describe, expect, it } from 'vitest'
import { conversationMentions } from '../src/client/components.tsx'
import { conversationReferenceUri, parseQuery } from '../src/client/source.ts'
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

  it('declares search cancellation so the input-trigger AbortSignal is accepted by the Remote API', () => {
    const search = REFERENCE_ANYTHING_INVOCATIONS.find(descriptor => descriptor.method === 'search')
    expect(search?.cancellation).toEqual({ parameter: 'signal' })
  })
})
