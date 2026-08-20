/**
 * Continuation tokens for paging backwards through a transcript.
 *
 * A cursor is opaque to callers but not to this file, and it carries the one
 * thing a stateless read needs: where the previous page began. Which "where"
 * that is depends on the branch the read took — an exact turn index when the
 * whole file was streamed, a byte offset when only its tail was reachable — so
 * the two are separate members rather than one nullable field.
 *
 * @module dsh-reference-anything/local-agent/page
 */

import { ReferenceAnythingError } from '../../errors.ts'

/** Where the previous page started, and what it started in. */
export type AgentCursor =
  | { readonly kind: 'index'; readonly size: number; readonly index: number }
  | { readonly kind: 'offset'; readonly size: number; readonly offset: number }

/** Format version, so a token minted by an older build is rejected cleanly. */
const VERSION = 1

/**
 * Encode a continuation token.
 * @param ref - the reference id this token belongs to; a token is not portable.
 * @param cursor - where the next page should start.
 * @returns an opaque base64url token.
 */
export function encodeAgentCursor(ref: string, cursor: AgentCursor): string {
  const body = cursor.kind === 'index'
    ? { v: VERSION, ref, size: cursor.size, index: cursor.index }
    : { v: VERSION, ref, size: cursor.size, offset: cursor.offset }
  return Buffer.from(JSON.stringify(body)).toString('base64url')
}

/**
 * Decode a continuation token minted for this reference.
 *
 * Rejects a token from another reference as firmly as a malformed one: a
 * cursor that silently paged through a different transcript would hand the
 * model somebody else's conversation under the label it asked for.
 * @param value - the token as the caller supplied it.
 * @param expectedRef - the reference id it must belong to.
 * @returns where the next page starts.
 */
export function decodeAgentCursor(value: string, expectedRef: string): AgentCursor {
  let row: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    row = parsed as Record<string, unknown>
  } catch {
    throw malformed()
  }
  if (row['v'] !== VERSION || row['ref'] !== expectedRef) throw malformed()
  const size = row['size']
  if (!isCount(size)) throw malformed()
  if (isCount(row['index'])) return { kind: 'index', size, index: row['index'] }
  if (isCount(row['offset'])) return { kind: 'offset', size, offset: row['offset'] }
  throw malformed()
}

/**
 * Decide whether a cursor still describes the file in front of us.
 *
 * Deliberately not revision equality. A live agent appends to its transcript
 * continuously, and under pure append both cursor kinds stay true: a byte
 * offset still points at the same record and a turn index still names the same
 * turn. Only shrinkage — a rotated, truncated, or replaced file — moves the
 * ground under a token.
 * @param cursor - the decoded token.
 * @param currentSize - the transcript's size right now, in bytes.
 * @returns whether the cursor may still be used.
 */
export function cursorStillValid(cursor: AgentCursor, currentSize: number): boolean {
  return currentSize >= cursor.size
}

/** Raise the expiry error, so callers do not each phrase it differently. */
export function cursorExpired(): ReferenceAnythingError {
  return new ReferenceAnythingError(
    'the transcript was truncated or replaced since this page was read, so the continuation no longer points at the same turns',
    'REFERENCE_CURSOR_EXPIRED',
  )
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function malformed(): ReferenceAnythingError {
  return new ReferenceAnythingError(
    'transcript continuation token is malformed or belongs to another transcript',
    'REFERENCE_INVALID_CURSOR',
  )
}
