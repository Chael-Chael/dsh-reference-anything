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
  /** The source failed while reading; its own error is the `cause`. */
  | 'REFERENCE_READ_FAILED'
  /** The caller cancelled before the read settled. */
  | 'REFERENCE_CANCELLED'
  /** A `dsh-ref:` URI was malformed, non-canonical, or not a reference at all. */
  | 'REFERENCE_INVALID_URI'
  /** One message named more distinct references than the configured limit allows. */
  | 'REFERENCE_TOO_MANY'
  /** A reference's fixed fields alone exceed its byte budget, so no honest partial exists. */
  | 'REFERENCE_BUDGET_EXCEEDED'
  /** A plugin config value was outside its documented domain. */
  | 'REFERENCE_INVALID_CONFIG'
  /** No browser is listening for DevTools connections where the config says. */
  | 'CDP_ENDPOINT_UNREACHABLE'
  /** The page exists but another debugger client already holds it. */
  | 'CDP_TARGET_BUSY'
  /** No open tab matches the reference, or none is on an allowed origin. */
  | 'CDP_NO_MATCHING_TARGET'
  /** The page did not answer in time. */
  | 'CDP_EVALUATE_TIMEOUT'
  /** The browser refused the evaluation, or the extractor threw inside the page. */
  | 'CDP_EVALUATE_FAILED'
  /**
   * The page answered but no turns could be read from it. Always loud: an
   * empty conversation returned as success is indistinguishable from an
   * extractor the site's layout has outgrown.
   */
  | 'CDP_EXTRACTION_EMPTY'

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
