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
  /**
   * The page's URL at the moment it was read. The tab can navigate between
   * being listed and being evaluated, so the caller checks this rather than
   * trusting that it read the conversation it asked for.
   */
  readonly location: string | null
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
  // The only site knowledge in this package. DeepSeek ships hashed CSS-module
  // class names, so these WILL age; the counts below are what makes a stale
  // selector diagnosable from an ordinary error message.
  const S = {
    container: '.dad65929',
    userText: '.fbb737a4',
    message: '.ds-message',
    markdown: '.ds-markdown',
    think: '.ds-think-content, .e1675d8b',
    loader: '.ds-loading, [class*="skeleton"], [class*="loading"]',
  }
  const MAX_TURNS = 2000
  const diagnostics = { container: 0, roleAttributed: 0, userText: 0, markdown: 0, think: 0 }

  // Block-aware text rather than innerText: innerText depends on layout and
  // forces a reflow on a page we are only supposed to be reading.
  const BLOCK = new Set(['P','DIV','LI','PRE','BR','TR','H1','H2','H3','H4','H5','H6','BLOCKQUOTE'])
  const textOf = (el) => {
    let out = ''
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return }
      if (n.nodeType !== 1) return
      for (const c of n.childNodes) walk(c)
      if (BLOCK.has(n.tagName)) out += '\n'
    }
    walk(el)
    return out.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  }
  const inOrder = (nodes) => nodes.sort((a, b) => {
    const relation = a.el.compareDocumentPosition(b.el)
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })
  const done = (strategy, turns, extra) => {
    let kept = turns.filter((t) => t.text !== '')
    const droppedOldest = Math.max(0, kept.length - MAX_TURNS)
    if (droppedOldest > 0) kept = kept.slice(droppedOldest)
    return Object.assign({
      strategy, turns: kept, droppedOldest, diagnostics,
      title: (document.title || '').trim() || null,
      location: location.href,
    }, extra)
  }

  const root = document.querySelector(S.container) || document.body
  diagnostics.container = document.querySelectorAll(S.container).length

  // Shape 1: nodes that name their own role. Not observed on DeepSeek today,
  // but it is cheap and it is what a redesign would most likely introduce.
  const roled = Array.from(root.querySelectorAll('[data-role="user"], [data-role="assistant"], [data-message-author-role]'))
  diagnostics.roleAttributed = roled.length
  if (roled.length > 0) {
    return done('roleAttributed', roled.map((el) => ({
      role: el.getAttribute('data-role') || el.getAttribute('data-message-author-role') || 'assistant',
      text: textOf(el),
    })), { complete: true })
  }

  // Shape 2: user prompts are plain bubbles, assistant answers are rendered
  // markdown inside a message wrapper. Reasoning blocks are excluded rather
  // than collected: they are not part of the conversation.
  const users = Array.from(root.querySelectorAll(S.userText))
  const answers = Array.from(root.querySelectorAll(S.message + ' ' + S.markdown))
    .filter((el) => !el.closest(S.think))
  diagnostics.userText = users.length
  diagnostics.markdown = answers.length
  diagnostics.think = root.querySelectorAll(S.think).length
  if (users.length > 0 || answers.length > 0) {
    const nodes = inOrder(
      users.map((el) => ({ el, role: 'user' })).concat(answers.map((el) => ({ el, role: 'assistant' }))),
    )
    const turns = nodes.map((entry) => ({ role: entry.role, text: textOf(entry.el) }))
    // A DeepSeek conversation always opens with a user turn, and a loader
    // above the first turn means older ones have not been fetched. Either
    // tells us the page is showing only part of the conversation.
    const first = nodes.length > 0 ? nodes[0] : null
    const loaderAbove = !!(first && Array.from(root.querySelectorAll(S.loader))
      .some((l) => l.compareDocumentPosition(first.el) & Node.DOCUMENT_POSITION_FOLLOWING))
    const complete = !!first && first.role === 'user' && !loaderAbove
    return done('markdownPairing', turns, { complete })
  }

  return done(null, [], { complete: true })
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
  location: string | null
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
  return { items, title: payload.title, complete: payload.complete, location: payload.location }
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
    location: typeof record.location === 'string' ? record.location : null,
    diagnostics: typeof record.diagnostics === 'object' && record.diagnostics !== null
      ? record.diagnostics as Record<string, number>
      : {},
  }
}
