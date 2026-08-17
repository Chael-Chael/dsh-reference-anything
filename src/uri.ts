/**
 * Canonical `dsh-ref:` URI and the inline mention that carries it.
 *
 * A reference is two opaque strings, either of which may contain any character
 * a JavaScript string can hold. JSON-encoding the pair before base64url means
 * quotes, slashes, backslashes, newlines, and astral characters all survive
 * without a delimiter the payload could itself spell.
 *
 * @module dsh-reference-anything/uri
 */

import { ReferenceAnythingError } from './errors.ts'
import type { ReferenceInput, ReferenceRef } from './types.ts'
import { decodeReferenceUriUnchecked, encodeReferenceUri, REFERENCE_SCHEME } from './uri-codec.ts'

export { encodeReferenceUri, REFERENCE_SCHEME }

/**
 * Decode one canonical reference URI.
 *
 * Re-encodes the decoded value and compares: base64url has multiple spellings
 * of the same bytes, and JSON has multiple spellings of the same object, so
 * without this check two different URIs could name one reference and a
 * consumer deduplicating by string would keep both.
 * @param uri - complete URI, including the scheme.
 * @returns the decoded reference.
 */
export function decodeReferenceUri(uri: string): ReferenceRef {
  try {
    return decodeReferenceUriUnchecked(uri)
  } catch (error: unknown) {
    throw invalidUri(uri, error)
  }
}

/**
 * Render a host-neutral Markdown mention carrying the canonical URI.
 * @param ref - the reference to name.
 * @param label - display text; falls back to the item id when empty.
 * @returns an escaped `@[label](uri)` mention.
 */
export function formatReferenceMention(ref: ReferenceRef, label?: string): string {
  const shown = label === undefined || label === '' ? ref.id : label
  return `@[${escapeLabel(shown)}](${encodeReferenceUri(ref)})`
}

/** Readable text with mentions replaced, plus the references they named. */
export interface ParsedReferenceText {
  /** The original text with every mention replaced by a readable `@label`. */
  readonly text: string
  /** References in first-appearance order, before deduplication. */
  readonly references: readonly ReferenceInput[]
}

/**
 * Extract Markdown mentions and bare canonical URIs from one text value.
 *
 * An explicit `@[label](dsh-ref:…)` mention is a claim that this is a
 * reference, so a malformed URI there is an error rather than prose. Bare text
 * is only treated as a reference when it carries a base64url-shaped payload;
 * a bare `dsh-ref:` with nothing after it stays ordinary discussion text, so
 * writing *about* the scheme does not accidentally reference anything.
 * @param text - the user's text.
 * @returns readable text and the references it named, in order.
 */
export function parseReferenceText(text: string): ParsedReferenceText {
  const references: ReferenceInput[] = []
  const pattern = /@\[((?:\\.|[^\\\]])*)\]\((dsh-ref:[^\s)]*)\)|(dsh-ref:[A-Za-z0-9_-]+)/gu
  const rendered = text.replace(pattern, (
    _match: string,
    rawLabel: string | undefined,
    markdownUri: string | undefined,
    bareUri: string | undefined,
  ) => {
    const uri = markdownUri ?? bareUri
    if (uri === undefined) throw invalidUri(String(_match))
    const ref = decodeReferenceUri(uri)
    const label = rawLabel === undefined ? ref.id : unescapeLabel(rawLabel)
    references.push({ ref, label })
    return `@${label}`
  })
  return { text: rendered, references }
}

/**
 * Whether text could possibly contain a reference.
 *
 * The mention expander runs on every step of every turn, so the overwhelmingly
 * common answer must cost one substring scan rather than a regex pass.
 * @param text - the text to screen.
 * @returns whether a full parse is worth running.
 */
export function mayContainReference(text: string): boolean {
  return text.includes(REFERENCE_SCHEME)
}

function escapeLabel(label: string): string {
  return label.replace(/[\\\]]/gu, match => `\\${match}`)
}

function unescapeLabel(label: string): string {
  return label.replace(/\\(.)/gu, '$1')
}

function invalidUri(uri: string, cause?: unknown): ReferenceAnythingError {
  return new ReferenceAnythingError(
    `invalid reference URI ${JSON.stringify(uri)}`,
    'REFERENCE_INVALID_URI',
    cause === undefined ? undefined : { cause },
  )
}
