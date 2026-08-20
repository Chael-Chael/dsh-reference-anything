/**
 * Failure classes for reference lookup, decoding, and budgeting.
 *
 * @module dsh-reference-anything/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable, machine-routable failure classes; route on these, never on message text. */
export type ReferenceErrorCode =
  /** Two sources claimed the same registry id. */
  | 'SOURCE_DUPLICATE'
  /** A reference named a source that is not registered. */
  | 'SOURCE_UNKNOWN'
  /** The owning source is registered but reported itself unusable. */
  | 'SOURCE_UNAVAILABLE'
  /** The source is usable but holds no item with that id. */
  | 'REFERENCE_NOT_FOUND'
  /** A live browser read targeted a conversation owned by another account. */
  | 'REFERENCE_ACCOUNT_MISMATCH'
  /** The source failed while reading; its own error is the `cause`. */
  | 'REFERENCE_READ_FAILED'
  /** A transcript whose format must be read whole is larger than the scan budget. */
  | 'REFERENCE_TRANSCRIPT_TOO_LARGE'
  /** The caller cancelled before the read settled. */
  | 'REFERENCE_CANCELLED'
  /** A `dsh-ref:` URI was malformed, non-canonical, or not a reference at all. */
  | 'REFERENCE_INVALID_URI'
  /** A continuation token is malformed or belongs to another reference. */
  | 'REFERENCE_INVALID_CURSOR'
  /** The immutable revision pinned by a cursor aged out of retention. */
  | 'REFERENCE_CURSOR_EXPIRED'
  /** The current task did not mention or discover this conversation. */
  | 'CONVERSATION_REFERENCE_NOT_GRANTED'
  /** A provider cannot materialize this attachment from a stable locator. */
  | 'ATTACHMENT_UNAVAILABLE'
  /** Provider bytes exceeded the attachment cap. */
  | 'ATTACHMENT_TOO_LARGE'
  /** One message named more distinct references than the configured limit allows. */
  | 'REFERENCE_TOO_MANY'
  /** A reference's fixed fields alone exceed its byte budget, so no honest partial exists. */
  | 'REFERENCE_BUDGET_EXCEEDED'
  /** A plugin config value was outside its documented domain. */
  | 'REFERENCE_INVALID_CONFIG'
  /** A management action conflicts with a sync job currently in flight. */
  | 'REFERENCE_SYNC_IN_PROGRESS'

/**
 * Named distinctly from the global `ReferenceError` — these describe this
 * package's references, not JavaScript bindings, and shadowing the built-in in
 * a file that also does ordinary work would be a trap.
 */
export class ReferenceAnythingError extends HarnessError {
  declare readonly code: ReferenceErrorCode

  /**
   * @param message - human-readable diagnostic.
   * @param code - stable failure class.
   * @param options - standard error options, carrying the underlying `cause` where one exists.
   */
  constructor(message: string, code: ReferenceErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
