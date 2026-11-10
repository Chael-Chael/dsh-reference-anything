/**
 * What a third-party reference source needs from Reference Anything.
 *
 * Types for both halves of a source plugin, plus the one helper the browser
 * half needs to insert a reference. Safe to import from Host and browser code:
 * nothing here touches Node.
 *
 * Host half: inject `references`, then `ctx.references.registerSource(...)`
 * and, for user settings, `ctx.references.defineSettings(...)`.
 * Browser half: inject `referenceSources`, then
 * `ctx.effect(() => ctx.referenceSources.register(...))`.
 *
 * @module dsh-reference-anything/sdk
 */
import type {} from './index.ts'
import type {} from './client/source-registry.ts'
import { encodeReferenceUri } from './uri-codec.ts'
import type { ReferenceRef } from './types.ts'

export type {
  ConversationItem,
  ReferenceAttachmentCapability,
  ReferenceAttachmentPayload,
  ReferenceRef,
  ReferenceSnapshot,
  ReferenceSource,
  ReferenceSummary,
  ReferenceWindow,
} from './types.ts'
export type { SourceSettingsDefinition, SourceSettingsHandle } from './settings.ts'
export type { ReferenceGroup, ReferenceGroupRegistry } from './client/source-registry.ts'
export type { PickerSourceOptions } from './client/source.ts'
export type { ReferenceAnythingError, ReferenceErrorCode } from './errors.ts'
export { encodeReferenceUri }

/**
 * Apply the user's `alias:` scoping to a group's query.
 * @param query - the text after `@`.
 * @param groupId - the registering group's id.
 * @param options - the options the group's `create` received.
 * @returns the query for this group, or undefined when another group was named.
 */
export function scopedGroupQuery(query: string, groupId: string, options: { shortcuts?: Readonly<Record<string, string | readonly string[]>> }): string | undefined {
  const trimmed = query.replaceAll('：', ':').trim()
  const match = trimmed.match(/^([^@:\s/]+):(.*)$/u)
  if (!match) return trimmed
  const named = options.shortcuts?.[match[1]!.toLocaleLowerCase()]
  if (named === undefined) return trimmed
  const ours = typeof named === 'string' ? named === groupId : named.includes(groupId)
  return ours ? (match[2] ?? '').trim() : undefined
}

/**
 * The text a browser group inserts for a picked item. The model sees it in
 * the user's message and reads the item through `external_reference_read`.
 * @param ref - the item, as the Host source names it.
 * @param label - what the user sees in place of the URI.
 */
export function formatReferenceMention(ref: ReferenceRef, label: string): string {
  const escaped = label.replace(/[\\\]]/gu, match => `\\${match}`)
  return `@[${escaped}](${encodeReferenceUri(ref)})`
}
