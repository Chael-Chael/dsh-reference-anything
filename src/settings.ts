/**
 * Per-source user settings owned by the core registry.
 *
 * Every source keeps its own record, validated by its own schema, so turning
 * one source plugin off never changes how another one behaves. The core knows
 * nothing about any source's fields: it stores opaque JSON and hands each
 * source back exactly what that source's schema accepts.
 */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

/** How a stored value came to be; only a user save is final. */
const originSchema = z.enum(['legacy', 'user'])
const storedSettingsSchema = z.object({ origin: originSchema, value: z.unknown() })
type StoredSettings = z.infer<typeof storedSettingsSchema>
const legacySnapshotSchema = z.object({ value: z.record(z.string(), z.unknown()) })

export const sourceSettingsDomainSpec = defineDomain({
  name: 'reference_anything_sources',
  version: 1,
  tables: {
    settings: domainTable<string, StoredSettings>(storedSettingsSchema),
    // One row, `record`: the settings object saved before sources owned their
    // own settings. Kept so a source that loads later can still migrate.
    legacy: domainTable<string, z.infer<typeof legacySnapshotSchema>>(legacySnapshotSchema),
  },
})

type SourceSettingsDomain = Domain<typeof sourceSettingsDomainSpec>

/** What a source declares about its settings. */
export interface SourceSettingsDefinition<T> {
  /** Validates both stored and submitted values. */
  readonly schema: z.ZodType<T>
  /** Used until the user saves, and wherever a stored value no longer parses. */
  readonly defaults: T
  /**
   * Map the pre-split settings object to this source's settings.
   * @returns undefined when nothing in the old object applies.
   */
  fromLegacy?(legacy: Readonly<Record<string, unknown>>): T | undefined
  /**
   * Check or normalize a parsed value before it is saved, for checks a schema
   * cannot make (a directory that must exist). Throwing leaves the old value.
   */
  prepare?(next: T, previous: T): Promise<T>
}

/** A source's live view of its own settings. */
export interface SourceSettingsHandle<T> {
  /** The current value; synchronous and always valid. */
  get(): T
  /** Validate, persist, and publish a new value. */
  update(value: unknown): Promise<T>
  /** Called after each change; returns an unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void
}

interface Entry {
  handle?: SourceSettingsHandle<unknown>
  readonly definition: SourceSettingsDefinition<unknown>
  readonly listeners: Set<(value: unknown) => void>
  value: unknown
}

/** Storage and change fan-out for every source's settings. */
export class SourceSettingsRegistry {
  private readonly entries = new Map<string, Entry>()
  private domain?: SourceSettingsDomain
  private legacy?: Readonly<Record<string, unknown>>
  private queue: Promise<unknown> = Promise.resolve()

  /** Attach durable storage. Values held in memory until now are reloaded from it. */
  async attach(domain: SourceSettingsDomain): Promise<void> {
    this.domain = domain
    this.legacy = domain.table('legacy').get('record')?.value
    for (const [id, entry] of this.entries) await this.load(id, entry)
  }

  /** Detach storage; values stay in memory until storage comes back. */
  detach(): void { this.domain = undefined }

  /**
   * Record the pre-split settings object once. Later calls are ignored, so a
   * stale copy can never overwrite what the first migration produced.
   */
  async publishLegacy(record: Readonly<Record<string, unknown>>): Promise<void> {
    await this.serial(async () => {
      if (this.legacy !== undefined) return
      this.legacy = record
      await this.domain?.table('legacy').put('record', { value: { ...record } })
      for (const [id, entry] of this.entries) await this.load(id, entry)
    })
  }

  /** Register a source's settings; the returned disposer unregisters them. */
  define<T>(id: string, definition: SourceSettingsDefinition<T>): { handle: SourceSettingsHandle<T>; dispose(): void } {
    if (this.entries.has(id)) throw new Error(`settings for source ${JSON.stringify(id)} are already defined`)
    const entry: Entry = { definition: definition as SourceSettingsDefinition<unknown>, listeners: new Set(), value: definition.defaults }
    this.entries.set(id, entry)
    void this.serial(() => this.load(id, entry))
    const handle: SourceSettingsHandle<T> = {
      get: () => entry.value as T,
      update: value => this.serial(async () => {
        let parsed = definition.schema.parse(value)
        if (definition.prepare) parsed = definition.schema.parse(await definition.prepare(parsed, entry.value as T))
        await this.domain?.table('settings').put(id, { origin: 'user', value: parsed })
        this.publish(entry, parsed)
        return parsed
      }),
      subscribe: listener => {
        const wrapped = listener as (value: unknown) => void
        entry.listeners.add(wrapped)
        return () => { entry.listeners.delete(wrapped) }
      },
    }
    entry.handle = handle as SourceSettingsHandle<unknown>
    return { handle, dispose: () => { if (this.entries.get(id) === entry) this.entries.delete(id) } }
  }

  /** Ids with settings currently defined, in definition order. */
  ids(): string[] { return [...this.entries.keys()] }

  /** Current value of one source's settings, if that source is loaded. */
  value(id: string): unknown { return this.entries.get(id)?.value }

  /** The live handle of a loaded source's settings. */
  handle(id: string): SourceSettingsHandle<unknown> | undefined { return this.entries.get(id)?.handle }

  private async load(id: string, entry: Entry): Promise<void> {
    const stored = this.domain?.table('settings').get(id)
    if (stored?.origin === 'user') {
      const parsed = entry.definition.schema.safeParse(stored.value)
      this.publish(entry, parsed.success ? parsed.data : entry.definition.defaults)
      return
    }
    const migrated = this.legacy === undefined ? undefined : entry.definition.fromLegacy?.(this.legacy)
    if (migrated !== undefined) {
      const parsed = entry.definition.schema.safeParse(migrated)
      if (parsed.success) {
        if (stored === undefined) await this.domain?.table('settings').put(id, { origin: 'legacy', value: parsed.data })
        this.publish(entry, parsed.data)
        return
      }
    }
    if (stored !== undefined) {
      const parsed = entry.definition.schema.safeParse(stored.value)
      if (parsed.success) { this.publish(entry, parsed.data); return }
    }
    this.publish(entry, entry.definition.defaults)
  }

  private publish(entry: Entry, value: unknown): void {
    if (isDeepStrictEqual(entry.value, value)) return
    entry.value = value
    for (const listener of entry.listeners) {
      try { listener(value) } catch { /* A listener's failure is its own. */ }
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
}

/** A handle kept only in memory, for callers that run without the registry. */
export function memorySettings<T>(schema: z.ZodType<T>, defaults: T): SourceSettingsHandle<T> {
  let value = defaults
  const listeners = new Set<(value: T) => void>()
  return {
    get: () => value,
    async update(next) {
      value = schema.parse(next)
      for (const listener of listeners) listener(value)
      return value
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
