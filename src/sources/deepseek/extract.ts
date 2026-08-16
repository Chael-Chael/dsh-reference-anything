/**
 * Reading a DeepSeek conversation out of a page that is already open.
 *
 * Two halves, kept apart on purpose. {@link EXTRACT_CONVERSATION} is a
 * package-owned constant evaluated inside the page — it can never be built
 * from caller, model, or config input. {@link parseDeepSeekPayload} is pure,
 * so a captured fixture exercises every normalization rule without a browser.
 *
 * The selectors are a starting point, not a settled contract: DeepSeek's front
 * end is undocumented and unversioned. The script therefore tries several
 * shapes, reports which one matched, and returns per-selector counts, so
 * correcting it is a matter of reading `diagnostics` rather than guessing. See
 * the probe procedure in the README.
 *
 * @module dsh-reference-anything/sources/deepseek/extract
 */

import { ReferenceAnythingError } from '../../errors.ts'
import type { ConversationItem } from '../../types.ts'

/** What the in-page script returns. */
export interface DeepSeekPayload {
  /** Which shape matched, or null when none did. */
  readonly strategy: string | null
  readonly title: string | null
  readonly turns: readonly { readonly role: string; readonly text: string }[]
  /**
   * Whether the page appears to be showing the whole conversation. False when
   * the script can tell the list is virtualized and older turns are not in the
   * DOM at all.
   */
  readonly complete: boolean
  /** Per-selector match counts, so a failed extraction says what it saw. */
  readonly diagnostics: Readonly<Record<string, number>>
}

/**
 * The expression evaluated inside the DeepSeek tab.
 *
 * Read-only by construction: it queries the DOM and returns a value. It never
 * clicks, scrolls, navigates, or writes, because the page belongs to the user
 * and they did not ask us to drive it.
 */
export const EXTRACT_CONVERSATION = `(() => {
  const diagnostics = {}
  const count = (name, nodes) => { diagnostics[name] = nodes.length; return nodes }
  const text = (node) => (node && node.innerText ? node.innerText : '').replace(/\\u00a0/g, ' ').trim()
  const title = (document.title || '').replace(/\\s*[|-]\\s*DeepSeek.*$/i, '').trim() || null

  // Shape 1: nodes that name their own role. Cheapest and most stable when present.
  const roled = count('roleAttributed', Array.from(document.querySelectorAll(
    '[data-role="user"], [data-role="assistant"], [data-message-author-role]',
  )))
  if (roled.length > 0) {
    const turns = roled.map((node) => ({
      role: node.getAttribute('data-role') || node.getAttribute('data-message-author-role') || 'assistant',
      text: text(node),
    })).filter((turn) => turn.text !== '')
    if (turns.length > 0) return { strategy: 'roleAttributed', title, turns, complete: true, diagnostics }
  }

  // Shape 2: DeepSeek renders assistant answers into markdown containers and
  // user messages into plainer bubbles. Pairing them in document order
  // recovers the alternation without depending on either class alone.
  const markdown = count('dsMarkdown', Array.from(document.querySelectorAll('.ds-markdown, [class*="ds-markdown"]')))
  const bubbles = count('userBubble', Array.from(document.querySelectorAll('[class*="_user"], [class*="fbb737a4"]')))
  if (markdown.length > 0 || bubbles.length > 0) {
    const tagged = []
    for (const node of markdown) tagged.push({ node, role: 'assistant' })
    for (const node of bubbles) tagged.push({ node, role: 'user' })
    tagged.sort((a, b) => {
      const relation = a.node.compareDocumentPosition(b.node)
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1
      return 0
    })
    const turns = tagged.map((entry) => ({ role: entry.role, text: text(entry.node) }))
      .filter((turn) => turn.text !== '')
    if (turns.length > 0) return { strategy: 'markdownPairing', title, turns, complete: true, diagnostics }
  }

  count('nextData', document.querySelectorAll('#__NEXT_DATA__'))
  return { strategy: null, title, turns: [], complete: true, diagnostics }
})()`

/**
 * Normalize and validate what the page returned.
 *
 * Fails rather than returning an empty conversation: an empty success is
 * indistinguishable from a broken extractor, and would have the model answer
 * as though the user's chat had said nothing.
 * @param raw - the value the page evaluated to.
 * @param label - the conversation's name, for the diagnostic.
 * @returns the conversation turns, oldest first.
 */
export function parseDeepSeekPayload(raw: unknown, label: string): {
  items: ConversationItem[]
  title: string | null
  complete: boolean
} {
  const payload = asPayload(raw)
  if (payload === undefined) {
    throw new ReferenceAnythingError(
      `the DeepSeek page returned something this version cannot read for ${JSON.stringify(label)}`,
      'CDP_EXTRACTION_EMPTY',
    )
  }
  const items = payload.turns.flatMap((turn) => {
    const text = typeof turn.text === 'string' ? turn.text.trim() : ''
    if (text === '') return []
    return [{ role: normalizeRole(turn.role), text }]
  })
  if (items.length === 0) {
    throw new ReferenceAnythingError(
      `no conversation turns could be read from the DeepSeek page for ${JSON.stringify(label)}`
      + ` (selectors matched: ${describeDiagnostics(payload.diagnostics)}).`
      + ' The page layout has probably changed; see the probe procedure in the dsh-reference-anything README.',
      'CDP_EXTRACTION_EMPTY',
    )
  }
  return { items, title: payload.title, complete: payload.complete }
}

/** Anything that is not clearly the user is treated as the assistant's turn. */
function normalizeRole(role: unknown): ConversationItem['role'] {
  return typeof role === 'string' && role.toLowerCase().includes('user') ? 'user' : 'assistant'
}

function describeDiagnostics(diagnostics: Readonly<Record<string, number>>): string {
  const entries = Object.entries(diagnostics)
  return entries.length === 0 ? 'none' : entries.map(([name, n]) => `${name}=${n}`).join(', ')
}

function asPayload(raw: unknown): DeepSeekPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.turns)) return undefined
  const turns = record.turns.filter((turn): turn is { role: unknown; text: unknown } =>
    typeof turn === 'object' && turn !== null)
  return {
    strategy: typeof record.strategy === 'string' ? record.strategy : null,
    title: typeof record.title === 'string' && record.title !== '' ? record.title : null,
    turns: turns as DeepSeekPayload['turns'],
    complete: record.complete !== false,
    diagnostics: typeof record.diagnostics === 'object' && record.diagnostics !== null
      ? record.diagnostics as Record<string, number>
      : {},
  }
}
