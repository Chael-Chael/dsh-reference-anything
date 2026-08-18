/**
 * Query parsing and relevance scoring for conversation discovery. Pure — no
 * Node builtins, no cordis — because both the Host source and the browser
 * bundle import it.
 *
 * The `@` mention path constrains this more than it looks: the trigger token
 * ends at the first whitespace (ui-input-trigger `core/detect.ts`), so a
 * mention query is always a single space-free run of characters. That rules
 * out `@chatgpt cache` and it rules out multi-word title search, which is why
 * the provider separator is `:`/`/` and why matching falls back to a
 * subsequence pass rather than demanding a contiguous substring.
 */

export type SearchProvider = 'chatgpt' | 'claude' | 'gemini' | 'deepseek' | 'grok'

/** Spellings accepted in a provider prefix, including short forms worth typing. */
const PROVIDER_ALIASES: Record<string, SearchProvider> = {
  chatgpt: 'chatgpt', gpt: 'chatgpt', openai: 'chatgpt',
  claude: 'claude',
  gemini: 'gemini',
  deepseek: 'deepseek', ds: 'deepseek',
  grok: 'grok',
}

/** Provider prefix followed by a separator that survives `@` token detection, or by nothing. */
const PROVIDER_PREFIX = /^@?([A-Za-z]+)(?:[:/\s]+([\s\S]*))?$/u

/**
 * Split a leading provider scope off a query.
 *
 * `:` and `/` are the separators that survive `@` token detection; whitespace
 * is accepted too because the model-facing `reference_list` path is not bound
 * by the token rules. A bare provider name scopes to that provider with an
 * empty query — `@claude` is the fast "show me my Claude chats" gesture.
 * @param value - raw query, with or without a provider prefix.
 * @returns the recognized provider (if any) and the remaining query.
 */
export function parseProviderQuery(value: string): { provider?: SearchProvider; query: string } {
  const trimmed = value.trim()
  const match = PROVIDER_PREFIX.exec(trimmed)
  if (!match) return { query: trimmed }
  const provider = PROVIDER_ALIASES[match[1]!.toLocaleLowerCase()]
  if (!provider) return { query: trimmed }
  return { provider, query: (match[2] ?? '').trim() }
}

/**
 * Match quality bands, best last. Ordered, and a band always outranks every
 * weaker one — within-band tiebreakers never cross a band boundary.
 */
export const MATCH_TIER = {
  subsequence: 1,
  substring: 2,
  wordBoundary: 3,
  prefix: 4,
  exact: 5,
} as const
export type MatchTier = (typeof MATCH_TIER)[keyof typeof MATCH_TIER]

/** Why and how well a title matched. */
export interface TitleMatch {
  readonly tier: MatchTier
  /** Offset of the first matched character — earlier reads as more relevant. */
  readonly at: number
  /** Characters spanned from first to last match; tighter is better. */
  readonly span: number
}

/** Separators a user might type that should not affect matching. */
const LOOSE = /[\s\-_.]/u
const LOOSE_ALL = /[\s\-_.]+/gu

/**
 * Score one title against a needle.
 *
 * The subsequence band is what makes a space-free query usable: `cachedes`
 * and `cache-design` both reach "Cache design notes", which no substring
 * search can do once the token cannot hold a space.
 * @param title - conversation title.
 * @param needle - user query, already stripped of any provider prefix.
 * @returns the match, or undefined when the title does not match at all.
 */
export function scoreTitle(title: string, needle: string): TitleMatch | undefined {
  const query = needle.trim().toLocaleLowerCase()
  if (query === '') return undefined
  const haystack = title.toLocaleLowerCase()

  if (haystack === query) return { tier: MATCH_TIER.exact, at: 0, span: query.length }
  const at = haystack.indexOf(query)
  if (at === 0) return { tier: MATCH_TIER.prefix, at, span: query.length }
  if (at > 0) {
    const tier = LOOSE.test(haystack.charAt(at - 1)) ? MATCH_TIER.wordBoundary : MATCH_TIER.substring
    return { tier, at, span: query.length }
  }
  return subsequence(haystack, query.replace(LOOSE_ALL, ''))
}

/**
 * Locate `query`'s characters in order, not necessarily adjacent.
 * @returns the match spanning the earliest greedy run, or undefined.
 */
function subsequence(haystack: string, query: string): TitleMatch | undefined {
  if (query === '') return undefined
  let first = -1
  let cursor = 0
  for (const char of query) {
    const found = haystack.indexOf(char, cursor)
    if (found < 0) return undefined
    if (first < 0) first = found
    cursor = found + char.length
  }
  return { tier: MATCH_TIER.subsequence, at: first, span: cursor - first }
}

/**
 * Order two matches best-first. Band dominates; within a band a tighter,
 * earlier match wins. Callers break remaining ties on recency.
 * @returns negative when `a` should sort before `b`.
 */
export function compareMatches(a: TitleMatch, b: TitleMatch): number {
  return (b.tier - a.tier) || (a.span - b.span) || (a.at - b.at)
}

/**
 * Excerpt the text around a hit for display beside a search result.
 *
 * UI only: this is mirrored conversation content, and it must not reach the
 * model outside the untrusted-data envelope `reference_read` builds.
 * @param text - the full text the hit was found in.
 * @param at - offset of the hit.
 * @param radius - characters of context to keep on each side.
 * @returns a whitespace-collapsed excerpt, elided where it was cut.
 */
export function snippet(text: string, at: number, radius = 30): string {
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + radius)
  const body = text.slice(start, end).replace(/\s+/gu, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}
