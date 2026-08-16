/**
 * Taking one window out of a conversation a source already holds in full.
 *
 * Sources that can read the whole conversation cheaply — a file, an export, an
 * in-page payload — share this instead of each re-deriving the index
 * arithmetic. A source that pages upstream computes its own slice and does not
 * use this.
 *
 * @module dsh-reference-anything/window
 */

import type { ConversationItem, ReferenceSlice, ReferenceWindow } from './types.ts'

/**
 * Select the requested turns and say where they sit.
 *
 * `before` is clamped rather than rejected. A model reading backwards knows
 * the index it last saw but not always the total, so asking for turns before a
 * number past the end is an ordinary first request, not an error; the returned
 * `startIndex` and `hasOlder` tell it where it actually landed.
 * @param items - the complete conversation, oldest first.
 * @param window - the requested turns.
 * @returns the selected turns and their position.
 */
export function sliceTurns(items: readonly ConversationItem[], window: ReferenceWindow): ReferenceSlice {
  const totalTurns = items.length
  const end = window.before === undefined
    ? totalTurns
    : Math.max(0, Math.min(Math.trunc(window.before), totalTurns))
  const start = Math.max(0, end - Math.max(0, Math.trunc(window.limit)))
  return {
    kind: 'conversation',
    items: items.slice(start, end),
    startIndex: start,
    totalTurns,
    hasOlder: start > 0,
  }
}
