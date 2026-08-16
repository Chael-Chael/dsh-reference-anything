import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import ReferenceRuntime from '../src/index.ts'
import * as deepseek from '../src/sources/deepseek/index.ts'
import {
  DEEPSEEK_SOURCE_ID,
  DeepSeekReferenceSource,
  conversationIdOf,
  isAllowedOrigin,
} from '../src/sources/deepseek/index.ts'
import { parseDeepSeekPayload } from '../src/sources/deepseek/extract.ts'
import type { CdpTarget, CdpTransport } from '../src/cdp/transport.ts'
import { ReferenceAnythingError } from '../src/errors.ts'

const CHAT = 'https://chat.deepseek.com/a/chat/s/6a8136ce-3820-83e9-909e-9318e6819022'
const CHAT_ID = '6a8136ce-3820-83e9-909e-9318e6819022'

const OPTIONS = {
  endpoint: 'http://127.0.0.1:9222',
  origins: ['https://chat.deepseek.com'],
  evaluateTimeoutMs: 5_000,
  maxTurns: 400,
}

function target(over: Partial<CdpTarget> = {}): CdpTarget {
  return {
    id: 'target-1',
    type: 'page',
    url: CHAT,
    title: 'Cache design | DeepSeek',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target-1',
    ...over,
  }
}

function payload(turns: { role: string; text: string }[], over: Record<string, unknown> = {}): unknown {
  return {
    strategy: 'roleAttributed',
    title: 'Cache design',
    turns,
    complete: true,
    location: CHAT,
    diagnostics: {},
    ...over,
  }
}

const TALK = [
  { role: 'user', text: 'how should we key the cache?' },
  { role: 'assistant', text: 'by request hash' },
]

function fakeTransport(over: Partial<CdpTransport> = {}): CdpTransport {
  return {
    listTargets: () => Promise.resolve([target()]),
    evaluate: () => Promise.resolve(payload(TALK)),
    ...over,
  }
}

function source(over: Partial<CdpTransport> = {}, options = OPTIONS): DeepSeekReferenceSource {
  return new DeepSeekReferenceSource(fakeTransport(over), options)
}

describe('opting in', () => {
  it('is unavailable until an endpoint is configured', async () => {
    expect(await source({}, { ...OPTIONS, endpoint: '  ' }).available()).toBe(false)
    expect(await source().available()).toBe(true)
  })

  it('refuses to mount without an endpoint rather than picking one', async () => {
    const ctx = new Context()
    await ctx.plugin(ReferenceRuntime, {})
    await expect(ctx.plugin(deepseek, {})).rejects.toThrow(/endpoint/u)
  })

  it('registers and unregisters with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(ReferenceRuntime, {})
    const fiber = await ctx.plugin(deepseek, { endpoint: 'http://127.0.0.1:9222' })
    expect(ctx.references.sourceIds()).toContain(DEEPSEEK_SOURCE_ID)
    await fiber.dispose()
    expect(ctx.references.sourceIds()).not.toContain(DEEPSEEK_SOURCE_ID)
  })

  it('is a namespace plugin, so the Loader keeps its inject list', () => {
    expect('default' in deepseek).toBe(false)
    expect(deepseek.inject).toEqual(['references'])
  })
})

describe('origin allowlisting', () => {
  it('accepts an allowed origin', () => {
    expect(isAllowedOrigin(CHAT, ['https://chat.deepseek.com'])).toBe(true)
  })

  it.each([
    ['a lookalike suffix', 'https://chat.deepseek.com.evil.test/a/chat/s/x'],
    ['a different host', 'https://example.com/a/chat/s/x'],
    ['plain http', 'http://chat.deepseek.com/a/chat/s/x'],
    ['a non-URL target', 'about:blank'],
  ])('rejects %s', (_label, url) => {
    // A prefix test would have accepted the lookalike; origins are compared parsed.
    expect(isAllowedOrigin(url, ['https://chat.deepseek.com'])).toBe(false)
  })

  it('ignores an unparseable entry in the allowlist instead of throwing', () => {
    expect(isAllowedOrigin(CHAT, ['not a url', 'https://chat.deepseek.com'])).toBe(true)
  })

  it('never evaluates in a disallowed page', async () => {
    let evaluated = 0
    const scoped = source({
      listTargets: () => Promise.resolve([target({ url: 'https://evil.test/a/chat/s/x' })]),
      evaluate: () => { evaluated += 1; return Promise.resolve(payload(TALK)) },
    })
    await expect(scoped.list('', 10)).resolves.toEqual([])
    await expect(scoped.read({ source: DEEPSEEK_SOURCE_ID, id: 'x' }, { limit: 10 }))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_NO_MATCHING_TARGET' }))
    // The allowlist is applied before anything reaches the page, not after.
    expect(evaluated).toBe(0)
  })
})

describe('conversation URLs', () => {
  it('recovers the conversation id', () => {
    expect(conversationIdOf(CHAT)).toBe(CHAT_ID)
  })

  it.each([
    ['the app root', 'https://chat.deepseek.com/'],
    ['a settings page', 'https://chat.deepseek.com/a/settings'],
    ['a non-URL', 'about:blank'],
  ])('returns nothing for %s', (_label, url) => {
    expect(conversationIdOf(url)).toBeUndefined()
  })
})

describe('listing open tabs', () => {
  it('returns one entry per open conversation, titled from the tab', async () => {
    await expect(source().list('', 10)).resolves.toEqual([{
      ref: { source: DEEPSEEK_SOURCE_ID, id: CHAT_ID },
      label: 'Cache design',
      origin: CHAT,
    }])
  })

  it('skips non-page targets and pages that are not conversations', async () => {
    const scoped = source({
      listTargets: () => Promise.resolve([
        target({ type: 'service_worker' }),
        target({ id: 'b', url: 'https://chat.deepseek.com/' }),
        target({ id: 'c' }),
      ]),
    })
    await expect(scoped.list('', 10)).resolves.toHaveLength(1)
  })

  it('filters by title and honors the limit', async () => {
    await expect(source().list('cache', 10)).resolves.toHaveLength(1)
    await expect(source().list('nothing', 10)).resolves.toEqual([])
    await expect(source().list('', 0)).resolves.toEqual([])
  })
})

describe('reading a conversation', () => {
  it('returns the turns with their position', async () => {
    const snapshot = await source().read({ source: DEEPSEEK_SOURCE_ID, id: CHAT_ID }, { limit: 10 })
    expect(snapshot.label).toBe('Cache design')
    expect(snapshot.body.items).toEqual(TALK)
    expect(snapshot.body).toMatchObject({ startIndex: 0, totalTurns: 2, hasOlder: false })
    expect(snapshot.partial).toBe(false)
  })

  it('windows the turns it was asked for', async () => {
    const many = Array.from({ length: 20 }, (_v, index) => ({ role: 'user', text: `turn ${index}` }))
    const scoped = source({ evaluate: () => Promise.resolve(payload(many)) })
    const snapshot = await scoped.read({ source: DEEPSEEK_SOURCE_ID, id: CHAT_ID }, { limit: 3, before: 10 })
    expect(snapshot.body.items.map(item => item.text)).toEqual(['turn 7', 'turn 8', 'turn 9'])
    expect(snapshot.body).toMatchObject({ startIndex: 7, hasOlder: true })
  })

  it('names the missing tab when the conversation is not open', async () => {
    await expect(source().read({ source: DEEPSEEK_SOURCE_ID, id: 'not-open' }, { limit: 10 }))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_NO_MATCHING_TARGET' }))
  })

  it('declares itself partial when the page did not render everything', async () => {
    const scoped = source({ evaluate: () => Promise.resolve(payload(TALK, { complete: false })) })
    const snapshot = await scoped.read({ source: DEEPSEEK_SOURCE_ID, id: CHAT_ID }, { limit: 10 })
    // Scrolling would reveal more and this source will not scroll, so the
    // rest is out of reach — and no total may be claimed for a conversation
    // only partly seen.
    expect(snapshot.partial).toBe(true)
    expect(snapshot.body.totalTurns).toBeUndefined()
  })

  it('caps what one page may contribute, and says the result is partial', async () => {
    const many = Array.from({ length: 50 }, (_v, index) => ({ role: 'user', text: `turn ${index}` }))
    const scoped = source({ evaluate: () => Promise.resolve(payload(many)) }, { ...OPTIONS, maxTurns: 5 })
    const snapshot = await scoped.read({ source: DEEPSEEK_SOURCE_ID, id: CHAT_ID }, { limit: 10 })
    expect(snapshot.body.items).toHaveLength(5)
    expect(snapshot.body.items.at(-1)?.text).toBe('turn 49')
    expect(snapshot.partial).toBe(true)
  })

  it('passes the caller signal to the page', async () => {
    let seen: AbortSignal | undefined
    const scoped = source({
      evaluate: (_t, _e, _ms, signal) => { seen = signal; return Promise.resolve(payload(TALK)) },
    })
    const controller = new AbortController()
    await scoped.read({ source: DEEPSEEK_SOURCE_ID, id: CHAT_ID }, { limit: 10 }, controller.signal)
    expect(seen).toBe(controller.signal)
  })

  it('evaluates only the package-owned constant, never anything caller-shaped', async () => {
    const seen: string[] = []
    const scoped = source({
      evaluate: (_t, expression) => { seen.push(expression); return Promise.resolve(payload(TALK)) },
    })
    await scoped.read({ source: DEEPSEEK_SOURCE_ID, id: CHAT_ID }, { limit: 3, before: 7 })
    expect(seen).toHaveLength(1)
    // Nothing from the window, the ref, or the config may appear in the script.
    expect(seen[0]).not.toContain(CHAT_ID)
    expect(seen[0]).not.toContain('before')
    expect(seen[0]).toContain('document.querySelectorAll')
  })
})

describe('the page can move under us', () => {
  it('discards a read whose tab navigated to another conversation', async () => {
    const scoped = source({
      evaluate: () => Promise.resolve(payload(TALK, {
        location: 'https://chat.deepseek.com/a/chat/s/some-other-conversation',
      })),
    })
    // Without this check the read would quietly return a conversation the
    // user never referenced.
    await expect(scoped.read({ source: DEEPSEEK_SOURCE_ID, id: CHAT_ID }, { limit: 10 }))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_NO_MATCHING_TARGET' }))
  })

  it('discards a read whose tab left the allowed origins', async () => {
    const scoped = source({
      evaluate: () => Promise.resolve(payload(TALK, { location: 'https://evil.test/a/chat/s/' + CHAT_ID })),
    })
    await expect(scoped.read({ source: DEEPSEEK_SOURCE_ID, id: CHAT_ID }, { limit: 10 }))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_NO_MATCHING_TARGET' }))
  })

  it('discards a read from a page that would not say where it was', async () => {
    const scoped = source({ evaluate: () => Promise.resolve(payload(TALK, { location: null })) })
    await expect(scoped.read({ source: DEEPSEEK_SOURCE_ID, id: CHAT_ID }, { limit: 10 }))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_NO_MATCHING_TARGET' }))
  })
})

describe('extraction is loud when it reads nothing', () => {
  it('fails rather than returning an empty conversation', () => {
    // An empty success is indistinguishable from an extractor the site has
    // outgrown, and the model would answer as if the chat had said nothing.
    expect(() => parseDeepSeekPayload(payload([]), 'Cache design'))
      .toThrow(expect.objectContaining({ code: 'CDP_EXTRACTION_EMPTY' }))
  })

  it('reports what the selectors actually matched, so the fix is obvious', () => {
    try {
      parseDeepSeekPayload(payload([], { diagnostics: { roleAttributed: 0, dsMarkdown: 12 } }), 'Cache design')
      expect.unreachable('expected an extraction failure')
    } catch (error: unknown) {
      expect((error as Error).message).toContain('roleAttributed=0')
      expect((error as Error).message).toContain('dsMarkdown=12')
    }
  })

  it.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['a payload with no turns array', { strategy: 'x' }],
  ])('refuses %s from the page', (_label, raw) => {
    expect(() => parseDeepSeekPayload(raw, 'x')).toThrow(ReferenceAnythingError)
  })

  it('drops blank turns and normalizes unknown roles to the assistant', () => {
    const parsed = parseDeepSeekPayload(payload([
      { role: 'user', text: '  hello  ' },
      { role: 'system', text: 'notice' },
      { role: 'assistant', text: '   ' },
    ]), 'x')
    expect(parsed.items).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'notice' },
    ])
  })

  it('carries the page title through when it has one', () => {
    expect(parseDeepSeekPayload(payload(TALK), 'x').title).toBe('Cache design')
    expect(parseDeepSeekPayload(payload(TALK, { title: '' }), 'x').title).toBeNull()
  })
})
