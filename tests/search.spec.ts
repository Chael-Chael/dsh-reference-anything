import { describe, expect, it } from 'vitest'
import { MATCH_TIER, compareMatches, parseProviderQuery, scoreTitle, snippet } from '../src/search.ts'

describe('provider prefix parsing', () => {
  it('accepts the separators that survive @ token detection', () => {
    expect(parseProviderQuery('chatgpt:cache')).toEqual({ provider: 'chatgpt', query: 'cache' })
    expect(parseProviderQuery('claude/重构')).toEqual({ provider: 'claude', query: '重构' })
  })

  it('still accepts whitespace, which the model-facing list path is free to use', () => {
    expect(parseProviderQuery('gemini rag eval')).toEqual({ provider: 'gemini', query: 'rag eval' })
  })

  it('scopes to a provider on the bare name', () => {
    expect(parseProviderQuery('claude')).toEqual({ provider: 'claude', query: '' })
    expect(parseProviderQuery('deepseek:')).toEqual({ provider: 'deepseek', query: '' })
  })

  it('resolves the short forms worth typing', () => {
    expect(parseProviderQuery('gpt:cache')).toEqual({ provider: 'chatgpt', query: 'cache' })
    expect(parseProviderQuery('ds:cache')).toEqual({ provider: 'deepseek', query: 'cache' })
  })

  it('leaves ordinary search text alone', () => {
    expect(parseProviderQuery('cachedesign')).toEqual({ query: 'cachedesign' })
    expect(parseProviderQuery('cache-design')).toEqual({ query: 'cache-design' })
    expect(parseProviderQuery('grokking:transformers')).toEqual({ query: 'grokking:transformers' })
  })
})

describe('title scoring', () => {
  it('bands an exact title above a prefix above a mid-word substring', () => {
    const exact = scoreTitle('Cache design', 'cache design')!
    const prefix = scoreTitle('Cache design notes', 'cache')!
    const inner = scoreTitle('Recaching the design', 'aching')!
    expect(exact.tier).toBe(MATCH_TIER.exact)
    expect(prefix.tier).toBe(MATCH_TIER.prefix)
    expect(inner.tier).toBe(MATCH_TIER.substring)
    expect([inner, exact, prefix].sort(compareMatches).map(match => match.tier))
      .toEqual([MATCH_TIER.exact, MATCH_TIER.prefix, MATCH_TIER.substring])
  })

  it('ranks a hit after a separator above one buried inside a word', () => {
    expect(scoreTitle('Cache design notes', 'design')!.tier).toBe(MATCH_TIER.wordBoundary)
    expect(scoreTitle('Redesign the cache', 'design')!.tier).toBe(MATCH_TIER.substring)
  })

  it('finds a title through a space-free query, which is all the @ token allows', () => {
    const match = scoreTitle('Cache design notes', 'cachedes')
    expect(match?.tier).toBe(MATCH_TIER.subsequence)
  })

  it('treats typed separators as noise so cache-design and cachedesign agree', () => {
    expect(scoreTitle('Cache design notes', 'cache-design')?.tier).toBe(MATCH_TIER.subsequence)
    expect(scoreTitle('Cache design notes', 'cachedesign')?.tier).toBe(MATCH_TIER.subsequence)
  })

  it('matches CJK titles, which carry no word separators at all', () => {
    expect(scoreTitle('缓存设计讨论', '缓存设计')?.tier).toBe(MATCH_TIER.prefix)
    expect(scoreTitle('缓存的设计讨论', '缓存设计')?.tier).toBe(MATCH_TIER.subsequence)
  })

  it('prefers the tighter subsequence when two titles both match', () => {
    const tight = scoreTitle('Cache design', 'cachedesign')!
    const loose = scoreTitle('Cannot access the hedge fund design doc', 'cachedesign')!
    expect(tight.tier).toBe(loose.tier)
    expect([loose, tight].sort(compareMatches)[0]).toBe(tight)
  })

  it('returns nothing for a query the title cannot satisfy', () => {
    expect(scoreTitle('Cache design notes', 'zzz')).toBeUndefined()
    expect(scoreTitle('Cache design notes', '   ')).toBeUndefined()
  })
})

describe('snippets', () => {
  it('elides only the ends it actually cut', () => {
    const text = 'a'.repeat(100) + 'NEEDLE' + 'b'.repeat(100)
    const excerpt = snippet(text, 100, 10)
    expect(excerpt).toBe('…aaaaaaaaaaNEEDLEbbbb…')
    expect(snippet('short text', 6, 30)).toBe('short text')
  })

  it('collapses the whitespace a conversation turn carries', () => {
    expect(snippet('we  discussed\n\n  pgvector', 14, 30)).toBe('we discussed pgvector')
  })
})
