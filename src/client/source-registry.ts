/**
 * Which `@` groups exist, and which plugin each depends on.
 *
 * Built-in groups backed by a Host source appear only while that source's
 * plugin row is on; their switch in settings is that row's switch. Other
 * plugins add groups through the `referenceSources` client service.
 */
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { PickerSourceOptions } from './source.ts'

/** Built-in groups that read a Host source, with the plugin row that provides it. */
export const HOST_GROUPS: Readonly<Record<string, { readonly source: string; readonly row: string }>> = {
  agents: { source: 'local-agent', row: 'reference-local-agent' },
  conversations: { source: 'web-chat', row: 'reference-web-chat' },
  drives: { source: 'cloud-drive', row: 'reference-cloud-drive' },
  plugins: { source: 'local-plugin', row: 'reference-local-plugin' },
}

/**
 * Whether a group's Host source is loaded. An unknown roster (before the
 * first answer, or from an older Host) counts as loaded.
 */
export function hostSourceLoaded(source: string | undefined, loaded: readonly string[] | undefined): boolean {
  return source === undefined || loaded === undefined || loaded.includes(source)
}

/** An `@` group another plugin contributes. */
export interface ReferenceGroup {
  /** Unique group id; also its key in the menu settings and its `id:` scope. */
  readonly id: string
  /** Name shown in the menu settings. */
  readonly label: string
  /** The Host source it reads; the group is hidden while that source is not loaded. */
  readonly hostSource?: string
  /** Default position among groups; the user can reorder. */
  readonly order?: number
  /** Default `alias:` tokens that scope a query to this group. */
  readonly aliases?: readonly string[]
  /** Build the input-trigger source with the user's limits and shortcuts applied. */
  create(options: PickerSourceOptions): InputTriggerSource
}

/** Client service `referenceSources`. */
export interface ReferenceGroupRegistry {
  /** Add a group; the disposer removes it. Wrap the call in `ctx.effect`. */
  register(group: ReferenceGroup): () => void
  list(): readonly ReferenceGroup[]
  subscribe(listener: () => void): () => void
}

export function createReferenceGroupRegistry(reserved: readonly string[]): ReferenceGroupRegistry {
  const groups = new Map<string, ReferenceGroup>()
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    register(group) {
      if (reserved.includes(group.id) || groups.has(group.id)) throw new Error(`reference group ${JSON.stringify(group.id)} is already registered`)
      groups.set(group.id, group)
      notify()
      return () => { if (groups.get(group.id) === group) { groups.delete(group.id); notify() } }
    },
    list: () => [...groups.values()],
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { referenceSources: ReferenceGroupRegistry }
}
