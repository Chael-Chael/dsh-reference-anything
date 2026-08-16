/**
 * Public vocabulary for referencing material that lives outside this session.
 *
 * A *reference* names one conversation held somewhere else — a DeepSeek web
 * chat, an exported transcript, another agent's log — and a *source* is the
 * component that can list and read them. Sources are addressed by id carried
 * inside the reference itself, so one session can hold references into several
 * sources at once.
 *
 * @module dsh-reference-anything/types
 */

/**
 * Opaque handle to one referenceable item.
 *
 * Neither field is parsed outside its owning source: `id` is whatever that
 * source needs to find the item again, and callers move the pair around as a
 * unit. The canonical wire form is the `dsh-ref:` URI, never these two fields
 * spelled separately.
 */
export interface ReferenceRef {
  /** Registered {@link ReferenceSource.id} that can read this item. */
  readonly source: string
  /** Source-scoped opaque item id. */
  readonly id: string
}

/** One referenceable item as discovery sees it, without its body. */
export interface ReferenceSummary {
  readonly ref: ReferenceRef
  /**
   * Human-facing name, never empty — a source with no title falls back to the
   * item id. Consumers show this verbatim, so it must not carry markup or
   * terminal control sequences.
   */
  readonly label: string
  /**
   * Where the item lives (URL or filesystem path), for user-facing display
   * only. Deliberately absent from everything the model sees.
   */
  readonly origin?: string
  /** Last known activity in Unix epoch milliseconds, when the source knows it. */
  readonly updatedAt?: number
}

/** One projected turn of a referenced conversation. */
export interface ConversationItem {
  readonly role: 'user' | 'assistant'
  /** Visible text of that turn. Tool calls, reasoning, and injected context are not projected. */
  readonly text: string
}

/**
 * Which turns to read.
 *
 * Indices count from the **oldest** turn, because a conversation grows at its
 * newest end: an index from the start still names the same turn tomorrow,
 * while an index from the end would silently slide. That is what lets a model
 * page backwards across several calls without a continuation token.
 */
export interface ReferenceWindow {
  /** Maximum turns to return. */
  readonly limit: number
  /** Exclusive upper bound; absent means the newest turns. */
  readonly before?: number
}

/**
 * The turns a source returned, and where they sit in the whole conversation.
 *
 * Discriminated from the start so a later non-conversation referent is an
 * added member rather than a rewrite of every consumer.
 */
export interface ReferenceSlice {
  readonly kind: 'conversation'
  /** Turns in chronological order, oldest first. */
  readonly items: readonly ConversationItem[]
  /** Index of `items[0]` in the whole conversation. */
  readonly startIndex: number
  /** Total turns, when the source can count them. */
  readonly totalTurns?: number
  /** Whether turns exist before `startIndex`. */
  readonly hasOlder: boolean
}

/** One referenceable item together with the turns a source read for it. */
export interface ReferenceSnapshot extends ReferenceSummary {
  readonly body: ReferenceSlice
  /**
   * The source could not see the whole conversation — a virtualized list that
   * had not rendered fully, a history it has no way to page.
   *
   * Distinct from {@link ReferenceSlice.hasOlder}, and the two must never be
   * folded together: `hasOlder` means turns exist that the caller has not
   * asked for yet, while `partial` means turns exist that nobody here can
   * reach. One is a viewport, the other is loss.
   */
  readonly partial: boolean
  /** When this snapshot was read, in Unix epoch milliseconds. */
  readonly capturedAt: number
}

/**
 * A component that can enumerate and read referenceable items of one kind.
 *
 * Implementations are registered on `ctx.references` and are reached only
 * through it. `list` is best-effort discovery and may return nothing; `read`
 * is exact and must fail loudly rather than return an empty conversation,
 * because an empty success is indistinguishable from a broken extractor.
 */
export interface ReferenceSource {
  /** Stable registry key, also the `source` half of every {@link ReferenceRef} it owns. */
  readonly id: string
  /**
   * Whether this source can currently be used. Must stay cheap and local —
   * no network calls, no subprocess launches — because discovery calls it on
   * every source before fanning out.
   * @returns whether `list` and `read` are worth attempting.
   */
  available(): Promise<boolean>
  /**
   * Enumerate items matching a substring query.
   * @param query - case-insensitive substring; empty means "the most relevant items".
   * @param limit - maximum items to return; the source must not exceed it.
   * @param signal - cancellation from the caller.
   * @returns matching items, newest-relevant first, at most `limit`.
   */
  list(query: string, limit: number, signal?: AbortSignal): Promise<ReferenceSummary[]>
  /**
   * Read one window of turns from an item.
   *
   * Must fail rather than return an empty conversation for an item that
   * exists: an empty success is indistinguishable from a broken reader, and
   * the model would answer as if the user's chat had said nothing.
   * @param ref - a reference this source owns; `ref.source` always equals {@link ReferenceSource.id}.
   * @param window - which turns to return.
   * @param signal - cancellation from the caller.
   * @returns the requested turns and their position in the conversation.
   */
  read(ref: ReferenceRef, window: ReferenceWindow, signal?: AbortSignal): Promise<ReferenceSnapshot>
}

/**
 * Durable provenance for one aggregated block of referenced material.
 *
 * `form: 'recall'` and the per-reference `label` / `retainedMessages` /
 * `omittedMessages` / `truncated` fields are read by the harness Web client's
 * recall card, which never inspects `kind`. That reader is all-or-nothing: one
 * entry missing any of the four degrades the whole row to an opaque JSON body,
 * and `label` must be a non-empty string.
 */
export interface ReferenceContextSource {
  readonly kind: 'reference-anything'
  readonly form: 'recall'
  readonly version: 1
  readonly references: readonly ReferenceProvenance[]
}

/** What one reference contributed, and what was left out getting it here. */
export interface ReferenceProvenance {
  readonly source: string
  readonly id: string
  /** Display name carried into the model-facing block; never empty. */
  readonly label: string
  readonly capturedAt: number
  /** Index of the first previewed turn within the whole conversation. */
  readonly startIndex: number
  /** Total turns, when the source can count them. */
  readonly totalTurns?: number
  /** Turns actually shown to the model. */
  readonly retainedMessages: number
  /** Turns not shown, whether older than the window or dropped by the budget. */
  readonly omittedMessages: number
  /** UTF-8 bytes lost to shortening inside the turns that were shown. */
  readonly omittedBytes: number
  /** Whether anything at all was left out. */
  readonly truncated: boolean
  /** Whether older turns can still be fetched. */
  readonly hasOlder: boolean
  /** Whether the source itself could not see the whole conversation. */
  readonly partial: boolean
  /** Why the preview is absent, when the read failed. */
  readonly error?: string
  /** Position in the user's mention order, preserved after deduplication. */
  readonly inputIndex: number
}

/** A reference the user named, with the label their text used for it. */
export interface ReferenceInput {
  readonly ref: ReferenceRef
  /** Label from the mention, or the source's own when the mention carried none. */
  readonly label?: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'reference-anything': ReferenceContextSource
  }
}
