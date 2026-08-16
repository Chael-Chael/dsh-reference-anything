/**
 * `ctx.references` — the registry of sources that can name and read material
 * held outside this session.
 *
 * Unlike a seam that selects one configured backend per capability, this one
 * dispatches per call: every reference carries the id of the source that owns
 * it, so a single session can hold references into a browser chat, an exported
 * file, and another agent's log at the same time.
 *
 * @module dsh-reference-anything
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReferenceAnythingError } from './errors.ts'
import type { ReferenceRef, ReferenceSnapshot, ReferenceSource, ReferenceSummary } from './types.ts'

export type * from './types.ts'
export { ReferenceAnythingError, type ReferenceErrorCode } from './errors.ts'
export {
  REFERENCE_SCHEME,
  decodeReferenceUri,
  encodeReferenceUri,
  formatReferenceMention,
  mayContainReference,
  parseReferenceText,
  type ParsedReferenceText,
} from './uri.ts'

/** Fan-out cap applied to discovery when a caller names no limit of its own. */
export const DEFAULT_LIST_LIMIT = 20

declare module '@deepseek-ai/cordis' {
  interface Context {
    references: ReferenceRuntime
  }
}

/** Deployment settings for reference discovery. */
export interface Config {
  /**
   * Maximum items discovery returns across all sources combined. Varies by
   * deployment: a browser host may have fifty open conversations where a
   * directory of exports has three.
   */
  listLimit?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  listLimit: z.number().step(1).min(1).default(DEFAULT_LIST_LIMIT),
})

/** Registry and dispatcher for {@link ReferenceSource} implementations. */
export default class ReferenceRuntime extends Service {
  static Config: z<Config> = Config

  private readonly sources = new Map<string, ReferenceSource>()
  private readonly listLimit: number

  /**
   * @param ctx - the mounting context.
   * @param config - validated deployment settings.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'references')
    this.listLimit = config.listLimit ?? DEFAULT_LIST_LIMIT
  }

  /**
   * Add one source to the registry.
   * @param source - the implementation to register; its `id` must be unused.
   * @returns a disposer that removes it again.
   */
  registerSource(source: ReferenceSource): () => void {
    if (this.sources.has(source.id)) {
      throw new ReferenceAnythingError(
        `a reference source with id ${JSON.stringify(source.id)} is already registered`,
        'SOURCE_DUPLICATE',
      )
    }
    const sources = this.sources
    const dispose = this.ctx.effect(function* () {
      sources.set(source.id, source)
      yield () => sources.delete(source.id)
    }, 'references.registerSource()')
    // ctx.effect's disposer resolves a promise; this API is synchronous
    // fire-and-forget, so the settled promise is discarded.
    return () => void dispose()
  }

  /** @returns the registered source ids, in registration order. */
  sourceIds(): string[] {
    return [...this.sources.keys()]
  }

  /**
   * Discover referenceable items across every available source.
   *
   * One source failing does not fail discovery — a broken browser attachment
   * should not hide the exported files sitting on disk. Every available source
   * failing does, because that is indistinguishable from a broken deployment
   * and returning an empty list would present it as "you have no conversations".
   * @param query - case-insensitive substring; empty means "the most relevant items".
   * @param limit - maximum items overall; defaults to the configured `listLimit`.
   * @param signal - cancellation from the caller.
   * @returns matching items, capped at `limit`.
   */
  async list(query = '', limit: number = this.listLimit, signal?: AbortSignal): Promise<ReferenceSummary[]> {
    throwIfCancelled(signal)
    const available = await this.availableSources(signal)
    if (available.length === 0) return []
    const settled = await Promise.allSettled(
      available.map(source => source.list(query, limit, signal)),
    )
    throwIfCancelled(signal)
    const failures = settled.filter(result => result.status === 'rejected')
    if (failures.length === available.length) {
      throw new ReferenceAnythingError(
        `every available reference source failed to list (${available.map(s => s.id).join(', ')})`,
        'REFERENCE_READ_FAILED',
        { cause: failures[0]?.reason },
      )
    }
    return settled
      .flatMap(result => result.status === 'fulfilled' ? result.value : [])
      .slice(0, limit)
  }

  /**
   * Read one reference exactly.
   * @param ref - the reference to resolve; its `source` selects the owning implementation.
   * @param signal - cancellation from the caller.
   * @returns the referenced item and its content.
   */
  async read(ref: ReferenceRef, signal?: AbortSignal): Promise<ReferenceSnapshot> {
    throwIfCancelled(signal)
    const source = this.sources.get(ref.source)
    if (source === undefined) {
      throw new ReferenceAnythingError(
        `no reference source named ${JSON.stringify(ref.source)} is registered`,
        'SOURCE_UNKNOWN',
      )
    }
    if (!await source.available()) {
      throw new ReferenceAnythingError(
        `reference source ${JSON.stringify(ref.source)} is not currently usable`,
        'SOURCE_UNAVAILABLE',
      )
    }
    throwIfCancelled(signal)
    try {
      return await source.read(ref, signal)
    } catch (error: unknown) {
      if (error instanceof ReferenceAnythingError) throw error
      throwIfCancelled(signal)
      throw new ReferenceAnythingError(
        `reference source ${JSON.stringify(ref.source)} failed to read ${JSON.stringify(ref.id)}`,
        'REFERENCE_READ_FAILED',
        { cause: error },
      )
    }
  }

  private async availableSources(signal?: AbortSignal): Promise<ReferenceSource[]> {
    const sources = [...this.sources.values()]
    const checks = await Promise.all(sources.map(async source => {
      try {
        return await source.available()
      } catch {
        // `available()` is documented as a cheap local check. One that throws
        // is broken, not merely unusable, and treating it as unavailable keeps
        // the rest of discovery working.
        return false
      }
    }))
    throwIfCancelled(signal)
    return sources.filter((_source, index) => checks[index] === true)
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new ReferenceAnythingError('reference lookup was cancelled', 'REFERENCE_CANCELLED', { cause: signal.reason })
}
