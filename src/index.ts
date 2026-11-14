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
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { ReferenceAnythingError } from './errors.ts'
import { mayContainReference, parseReferenceText } from './uri.ts'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { SourceSettingsRegistry, sourceSettingsDomainSpec, type SourceSettingsDefinition, type SourceSettingsHandle } from './settings.ts'
import type {
  ReferenceRef,
  ReferenceSnapshot,
  ReferenceSource,
  ReferenceSummary,
  ReferenceWindow,
} from './types.ts'
import { mountCoreRemote } from './core-remote.ts'
import { registerSourceAuthorSkill } from './source-author-skill.ts'
import { legacySourcePlugin, legacyPluginName } from './legacy-source.ts'
import { referenceError, type ReferenceCall, type ReferenceSourcePlugin } from './reference-source.ts'

export type * from './types.ts'
export type * from './reference-source.ts'
export { defineReferenceSource } from './reference-source.ts'
export { ReferenceAnythingError, type ReferenceErrorCode } from './errors.ts'
export type { SourceSettingsDefinition, SourceSettingsHandle } from './settings.ts'
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
  private readonly plugins = new Map<string, ReferenceSourcePlugin>()
  /** Core wrappers of plain sources, kept per registered object so a re-registration gets a fresh one. */
  private readonly adapted = new WeakMap<ReferenceSource, ReferenceSourcePlugin>()
  private readonly grants = new Map<string, Set<string>>()
  private readonly listLimit: number
  private readonly settingsRegistry = new SourceSettingsRegistry()

  /**
   * @param ctx - the mounting context.
   * @param config - validated deployment settings.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'references')
    this.listLimit = config.listLimit ?? DEFAULT_LIST_LIMIT
    ctx.on('session/disposed', session => { this.revoke(String(session.id)) })
    // Optional: without durable storage (tests, minimal profiles) settings
    // still work in memory, and they reload once storage appears.
    const registry = this.settingsRegistry
    ctx.inject(['storageDomain'], async scoped => {
      const domain = await scoped.storageDomain.open(sourceSettingsDomainSpec)
      scoped.effect(() => () => { registry.detach(); void domain.close() }, 'references.settingsDomain')
      await registry.attach(domain)
    })
    // The settings panel's Remote lives with the registry: while the core is on, the panel works.
    mountCoreRemote(ctx, this)
    registerSourceAuthorSkill(ctx)
  }

  /**
   * Declare one source's user settings. They live as long as the calling
   * plugin: unloading it removes the definition, never the stored value.
   * @param id - the source id; one definition per id.
   * @param definition - schema, defaults, and an optional migration.
   * @returns a live handle to the source's own settings.
   */
  defineSettings<T>(id: string, definition: SourceSettingsDefinition<T>): SourceSettingsHandle<T> {
    const registry = this.settingsRegistry
    let defined: ReturnType<SourceSettingsRegistry['define']> | undefined
    this.ctx.effect(function* () {
      defined = registry.define(id, definition)
      yield () => defined?.dispose()
    }, 'references.defineSettings()')
    return defined!.handle as SourceSettingsHandle<T>
  }

  /** Current settings of a loaded source, or undefined when it is not loaded. */
  settingsOf(id: string): unknown { return this.settingsRegistry.value(id) }

  /**
   * Save one loaded source's settings, through that source's own validation.
   * @throws when no loaded source declared settings under `id`.
   */
  updateSettings(id: string, value: unknown): Promise<unknown> {
    const handle = this.settingsRegistry.handle(id)
    if (!handle) throw new ReferenceAnythingError(`no loaded source declared settings ${JSON.stringify(id)}`, 'SOURCE_UNKNOWN')
    return handle.update(value)
  }

  /** Ids of loaded sources that declared settings. */
  settingsIds(): string[] { return this.settingsRegistry.ids() }

  /** Hand over the settings object saved before sources owned their settings; kept once. */
  publishLegacySettings(record: Readonly<Record<string, unknown>>): Promise<void> {
    return this.settingsRegistry.publishLegacy(record)
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

  /**
   * Make a source plugin answer the `reference` tool.
   * @param plugin - its `source` is the routing key and must be unused.
   * @returns a disposer that unregisters it.
   */
  registerPlugin(plugin: ReferenceSourcePlugin): () => void {
    if (!/^[a-z][a-z0-9-]*$/.test(plugin.source) || this.plugins.has(plugin.source)) {
      throw new ReferenceAnythingError(`reference source ${JSON.stringify(plugin.source)} is invalid or already registered`, 'SOURCE_DUPLICATE')
    }
    const plugins = this.plugins
    const dispose = this.ctx.effect(function* () {
      plugins.set(plugin.source, plugin)
      yield () => plugins.delete(plugin.source)
    }, 'references.registerPlugin()')
    return () => void dispose()
  }

  /**
   * @returns every source plugin: native ones in registration order, then each plain
   * {@link ReferenceSource} that no native plugin answers for, wrapped by the core.
   */
  pluginList(): ReferenceSourcePlugin[] {
    const native = [...this.plugins.values()]
    const claimed = new Set(native.flatMap(plugin => [plugin.source, ...(plugin.mentionSources ?? [])]))
    const adapted: ReferenceSourcePlugin[] = []
    for (const source of this.sources.values()) {
      const name = legacyPluginName(source.id)
      if (claimed.has(source.id) || claimed.has(name) || !/^[a-z][a-z0-9-]*$/.test(name)) continue
      let wrapped = this.adapted.get(source)
      if (!wrapped) { wrapped = legacySourcePlugin(this.ctx, source); this.adapted.set(source, wrapped) }
      claimed.add(name)
      adapted.push(wrapped)
    }
    return [...native, ...adapted]
  }

  /** @returns the plugin routed to by `source`, if any. */
  plugin(source: string): ReferenceSourcePlugin | undefined {
    return this.pluginList().find(plugin => plugin.source === source)
  }

  /**
   * Map an `@` mention, in any wire format still accepted, to a plugin and its id.
   * @returns undefined when no loaded plugin claims it.
   */
  resolveMention(ref: ReferenceRef): { plugin: ReferenceSourcePlugin; id: string } | undefined {
    for (const plugin of this.pluginList()) {
      if (plugin.source !== ref.source && !(plugin.mentionSources ?? []).includes(ref.source)) continue
      let id: string | undefined
      try { id = plugin.claim ? plugin.claim(ref) : plugin.source === ref.source ? ref.id : undefined } catch { id = undefined }
      if (id) return { plugin, id }
    }
    return undefined
  }

  /** Authorize one task to read a plugin object and its children; only `@` mentions call this. */
  grantPlugin(sessionId: string, source: string, id: string): void {
    this.grant(sessionId, { source, id })
  }

  /**
   * Enforce that the user of this task (or of the task that spawned it) `@`-mentioned
   * the object or its parent, unless the plugin lets this id through ungated.
   * Grants come only from user messages; tool results never grant.
   */
  async assertPluginGranted(session: Session | undefined, plugin: ReferenceSourcePlugin, id: string, call: ReferenceCall): Promise<void> {
    const chain: string[] = []
    for (let current: string | undefined = id; current && chain.length < 8; current = plugin.parentOf?.(current)) chain.push(current)
    const keys = chain.map(value => ReferenceRuntime.grantKey({ source: plugin.source, id: value }))
    const has = (sessionId: string | undefined) => !!sessionId && keys.some(key => this.grants.get(sessionId)?.has(key))
    if (session) {
      if (has(String(session.id))) return
      // A subagent inherits what its parent task was granted.
      const parent = session.header?.parentSession
      if (parent && has(String(parent))) return
      for (const event of session.snapshotEvents()) {
        if (event.type !== 'user/message') continue
        for (const block of event.data.content) {
          if (block.type !== 'text' || !mayContainReference(block.text)) continue
          let parsed
          try { parsed = parseReferenceText(block.text) } catch { continue }
          for (const input of parsed.references) {
            const resolved = this.resolveMention(input.ref)
            if (resolved) this.grantPlugin(String(session.id), resolved.plugin.source, resolved.id)
          }
        }
      }
      if (has(String(session.id))) return
    }
    if (plugin.ungated && await plugin.ungated(id, call).catch(() => false)) return
    throw referenceError('UNAUTHORIZED', 'This object was not @-mentioned by the user in this task. Ask the user to @ it; listing or searching does not grant access.')
  }

  /** @returns the registered source ids, in registration order. */
  sourceIds(): string[] {
    return [...this.sources.keys()]
  }

  /** @returns the registered source with this id, if any. */
  source(id: string): ReferenceSource | undefined {
    return this.sources.get(id)
  }

  /**
   * Whether a source's items may only be read after an explicit grant.
   *
   * An unregistered source fails closed: registration order must never decide
   * authorization, and `read()` would reject it as `SOURCE_UNKNOWN` a moment
   * later anyway.
   */
  private gated(source: string): boolean {
    const registered = this.sources.get(source)
    return registered === undefined || registered.requiresGrant === true
  }

  /**
   * Qualify the grant by source.
   *
   * Two sources can mint the same opaque id, and an unqualified key would let
   * a grant for one silently authorize the other. NUL cannot occur in either
   * half, so the join is unambiguous.
   */
  private static grantKey(ref: ReferenceRef): string { return `${ref.source}\u0000${ref.id}` }

  private static contentMentions(blocks: readonly ContentBlock[], key: string): boolean {
    return blocks.some(block => {
      if (block.type !== 'text' || !mayContainReference(block.text)) return false
      try {
        return parseReferenceText(block.text).references.some(input => ReferenceRuntime.grantKey(input.ref) === key)
      } catch {
        return false
      }
    })
  }

  /** Authorize one task to read a gated reference named by its user or discovery tool. */
  grant(sessionId: string, ref: ReferenceRef): void {
    // Recorded unconditionally: a source may register after the mention that
    // named it, and a grant for an ungated source is merely inert.
    const values = this.grants.get(sessionId) ?? new Set<string>()
    values.add(ReferenceRuntime.grantKey(ref))
    this.grants.set(sessionId, values)
  }

  /** Enforce that a gated URI originated in this task's mention/list surface. */
  assertGranted(sessionId: string | undefined, ref: ReferenceRef): void {
    if (!this.gated(ref.source)) return
    if (!sessionId || !this.grants.get(sessionId)?.has(ReferenceRuntime.grantKey(ref))) {
      throw new ReferenceAnythingError(
        'this task has not been granted access to that conversation reference',
        'CONVERSATION_REFERENCE_NOT_GRANTED',
      )
    }
  }

  /** Allow a gated URI granted live or named in this task's durable user history; tool results never grant. */
  assertSessionGranted(session: Session | undefined, ref: ReferenceRef): void {
    const key = ReferenceRuntime.grantKey(ref)
    if (session && !this.grants.get(String(session.id))?.has(key)) {
      const mentioned = session.snapshotEvents().some(event => event.type === 'user/message' && ReferenceRuntime.contentMentions(event.data.content, key))
      if (mentioned) this.grant(String(session.id), ref)
    }
    this.assertGranted(session && String(session.id), ref)
  }

  /** Release task-local grants when a host knows the task is gone. */
  revoke(sessionId: string): void { this.grants.delete(sessionId) }

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
   * Read one window of turns from a reference.
   * @param ref - the reference to resolve; its `source` selects the owning implementation.
   * @param window - which turns to return.
   * @param signal - cancellation from the caller.
   * @returns the requested turns and their position in the conversation.
   */
  async read(ref: ReferenceRef, window: ReferenceWindow, signal?: AbortSignal): Promise<ReferenceSnapshot> {
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
      return await source.read(ref, window, signal)
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
