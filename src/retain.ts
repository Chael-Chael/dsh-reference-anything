/**
 * Fitting one referenced conversation into an exact serialized byte budget.
 *
 * The budget applies to the *complete* serialized block — labels, ids, and
 * every other fixed field included — because that is what actually reaches the
 * model. Measuring only the conversation text would let a long label push the
 * real payload past the cap.
 *
 * @module dsh-reference-anything/retain
 */

import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { ConversationItem } from './types.ts'

/** What survived the budget, and what it cost. */
export interface RetentionOutcome {
  readonly items: readonly ConversationItem[]
  readonly originalMessages: number
  readonly retainedMessages: number
  readonly omittedMessages: number
  readonly omittedBytes: number
  readonly truncated: boolean
}

/**
 * Reduce a conversation until its serialized form fits `maxBytes`.
 *
 * Two passes, in this order. First whole turns are dropped oldest-first, since
 * a conversation's recent end is what the current task needs and losing a
 * whole early turn costs less comprehension than shortening every turn. The
 * newest turn is never dropped — a reference that kept nothing the user could
 * recognize would be worse than no reference. Only then, if one turn is itself
 * over budget, is it shortened head-and-tail with an exact omission notice.
 * @param items - the projected conversation, oldest first.
 * @param maxBytes - budget for the complete serialized block.
 * @param serialize - renders the block from a candidate item list; must include every fixed field.
 * @returns the outcome, or `undefined` when even the fixed fields cannot fit.
 */
export function retainConversation(
  items: readonly ConversationItem[],
  maxBytes: number,
  serialize: (items: readonly ConversationItem[]) => string,
): RetentionOutcome | undefined {
  const originalMessages = items.length
  let retained: ConversationItem[] = items.map(item => ({ ...item }))
  let omittedMessages = 0
  let omittedBytes = 0

  const size = (): number => Buffer.byteLength(serialize(retained), 'utf8')

  while (size() > maxBytes && retained.length > 1) {
    const dropped = retained[0]
    if (dropped === undefined) break
    retained = retained.slice(1)
    omittedMessages += 1
    omittedBytes += Buffer.byteLength(dropped.text, 'utf8')
  }

  while (size() > maxBytes) {
    let longestIndex = -1
    let longestBytes = 0
    for (const [index, item] of retained.entries()) {
      const bytes = Buffer.byteLength(item.text, 'utf8')
      if (bytes > longestBytes) {
        longestBytes = bytes
        longestIndex = index
      }
    }
    // Nothing left to shorten: the fixed fields alone exceed the budget, so no
    // honest partial exists and the caller must fail rather than emit one.
    if (longestIndex < 0 || longestBytes === 0) return undefined
    const item = retained[longestIndex]
    if (item === undefined) return undefined
    const overflow = size() - maxBytes
    const shortened = truncateWithNotice(item.text, Math.max(0, longestBytes - overflow))
    if (shortened.text === item.text) return undefined
    retained = retained.with(longestIndex, { ...item, text: shortened.text })
    omittedBytes += shortened.omittedBytes
  }

  return {
    items: retained,
    originalMessages,
    retainedMessages: retained.length,
    omittedMessages,
    omittedBytes,
    truncated: omittedMessages > 0 || omittedBytes > 0,
  }
}

/**
 * Shorten one text to at most `maxOutputBytes`, keeping both ends.
 *
 * The notice naming the omission is itself part of the output, and its length
 * depends on the number it reports, so the largest fitting size cannot be
 * computed directly — it is searched for.
 * @param text - the complete original text.
 * @param maxOutputBytes - budget for the shortened text including its notice.
 * @returns the shortened text and the exact number of UTF-8 bytes it lost.
 */
function truncateWithNotice(text: string, maxOutputBytes: number): { text: string; omittedBytes: number } {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (totalBytes <= maxOutputBytes) return { text, omittedBytes: 0 }
  let low = 0
  let high = maxOutputBytes
  let best = { text: '', omittedBytes: totalBytes }
  while (low <= high) {
    const retainedBytes = Math.floor((low + high) / 2)
    const retainer = new TextRetainer({
      kind: 'headTail',
      headBytes: Math.ceil(retainedBytes / 2),
      tailBytes: Math.floor(retainedBytes / 2),
    })
    retainer.push(text)
    const result = retainer.finish()
    // The whole string was pushed before finish(), so the retainer always
    // knows exactly how much it dropped; a lower bound would mean the notice
    // understates the loss.
    if (result.omittedBytes.kind !== 'exact') {
      throw new Error('reference retention did not receive an exact omitted-byte count')
    }
    const omitted = result.omittedBytes.count
    const candidate = omitted === 0 ? result.text : `${result.text}\n[… omitted ${omitted} UTF-8 bytes …]`
    if (Buffer.byteLength(candidate, 'utf8') <= maxOutputBytes) {
      best = { text: candidate, omittedBytes: omitted }
      low = retainedBytes + 1
    } else {
      high = retainedBytes - 1
    }
  }
  return best
}
