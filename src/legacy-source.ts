/**
 * Every plain {@link ReferenceSource} — cloud drives, plugin listings, third-party
 * sources written against the older interface — answering the `reference` tool.
 *
 * Authors keep implementing `list`/`read`/`attachments`; the core pages the
 * whole item once per load into a {@link ReferenceDoc} and lets
 * {@link defineReferenceSource} do paging, search and revisions.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ReferenceAnythingError } from './errors.ts'
import { embeddedAttachment, MAX_DOWNLOAD_BYTES, type DocumentAttachment } from './local-reference.ts'
import { defineReferenceSource, referenceError, type ReferenceDoc, type ReferenceDocChild, type ReferenceSourcePlugin } from './reference-source.ts'
import type { ConversationItem, ReferenceRef, ReferenceSource } from './types.ts'

/** Turns one adapted load may hold; larger items are marked partial instead of growing without bound. */
export const MAX_ADAPTED_TURNS = 2_000
/** Turns requested per underlying read; the source may return fewer. */
const PAGE_TURNS = 100
/** Candidates one adapted listing asks its source for. */
const LIST_LIMIT = 200

/** Built-in sources keep their registry ids but answer under their plugin category. */
const NAMES: Readonly<Record<string, string>> = { 'cloud-drive': 'drive', 'local-plugin': 'plugin' }
/** The `reference` tool source a registered plain source answers under. */
export function legacyPluginName(id: string): string { return NAMES[id] ?? id }

interface LegacyChild { readonly attachmentId: string; readonly block?: DocumentAttachment['block'] }

/** Normalize the turns a source returned into a document with numbered attachment children. */
export function legacyDocument(title: string, turns: readonly ConversationItem[], partial: boolean): ReferenceDoc {
  const children: ReferenceDocChild[] = []
  const content = turns.map((turn, index) => {
    for (const image of turn.images ?? []) {
      children.push({ key: String(children.length + 1), title: image.name ?? 'image', kind: 'image', mimeType: image.mediaType, size: image.bytes, item: index + 1,
        data: { attachmentId: image.attachmentId, block: { type: 'image', attachment: image } } satisfies LegacyChild })
    }
    for (const attachment of turn.attachments ?? []) {
      children.push({ key: String(children.length + 1), title: attachment.name, kind: attachment.kind, item: index + 1,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(Number.isSafeInteger(attachment.size) && attachment.size > 0 ? { size: attachment.size } : {}),
        data: { attachmentId: attachment.attachmentId } satisfies LegacyChild })
    }
    return { role: turn.role, text: turn.text }
  })
  return { title, partial, content, children }
}

/**
 * Wrap a plain source as a `reference` plugin.
 * @param ctx - context whose attachment store holds images a source already saved.
 * @param source - the registered source; mentions keep its id, the tool sees {@link legacyPluginName}.
 */
export function legacySourcePlugin(ctx: Context, source: ReferenceSource): ReferenceSourcePlugin {
  const name = legacyPluginName(source.id)
  const usable = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    let available = false
    try { available = await source.available() } catch { available = false }
    if (!available) throw referenceError('SOURCE_UNAVAILABLE', `Reference source ${name} is not currently usable.`)
  }
  const item = (id: string): ReferenceRef => ({ source: source.id, id })
  return defineReferenceSource({
    source: name,
    ...(name !== source.id ? { mentionSources: [source.id] } : {}),
    usage: `${name} items: list or search titles to find ids, read an id for its text; images and files appear as children (list the id).`,
    claim: ref => ref.source === source.id ? ref.id : undefined,
    check: async (_id, signal) => usable(signal),
    files: {
      maxBytes: MAX_DOWNLOAD_BYTES,
      ...(source.attachments?.baseDirectory ? { baseDirectory: () => source.attachments!.baseDirectory!() } : {}),
      ...(source.attachments?.directoryPrefix ? { directoryPrefix: source.attachments.directoryPrefix } : {}),
    },
    async load(id, signal) {
      await usable(signal)
      const target = item(id)
      const limit = Math.max(1, Math.min(PAGE_TURNS, source.readLimit?.() ?? PAGE_TURNS))
      const pages: ConversationItem[][] = []
      let count = 0, title = id, partial = false
      let window: { limit: number; before?: number; cursor?: string } = { limit }
      for (;;) {
        signal.throwIfAborted()
        let snapshot
        try { snapshot = await source.read(target, window, signal) } catch (error) {
          signal.throwIfAborted()
          if (error instanceof ReferenceAnythingError) throw error
          throw new ReferenceAnythingError(`reference source ${name} failed to read this item`, 'REFERENCE_READ_FAILED', { cause: error })
        }
        title = snapshot.label || title
        partial ||= snapshot.partial
        const items = snapshot.body.items
        pages.unshift([...items])
        count += items.length
        const start = snapshot.body.startIndex
        if (!snapshot.body.hasOlder || start <= 0 || items.length === 0) break
        if (count >= MAX_ADAPTED_TURNS) { partial = true; break }
        window = snapshot.body.nextCursor ? { limit, cursor: snapshot.body.nextCursor } : { limit, before: start }
      }
      const turns = pages.flat()
      if (!turns.length) throw new ReferenceAnythingError(`reference source ${name} returned no content for this item`, 'REFERENCE_READ_FAILED')
      return legacyDocument(title, turns, partial)
    },
    async fetch(id, child, maxBytes, signal) {
      await usable(signal)
      const data = child.data as LegacyChild
      const embedded = await embeddedAttachment(ctx, { id: data.attachmentId, name: child.title, ...(child.mimeType ? { mimeType: child.mimeType } : {}),
        ...(data.block ? { block: data.block } : {}) }, maxBytes, signal)
      if (embedded) return embedded
      if (!source.attachments) throw referenceError('UNSUPPORTED_OP', `The ${name} source offers no file downloads.`)
      return source.attachments.fetch(item(id), data.attachmentId, maxBytes, signal)
    },
    async list(query, _args, call) {
      await usable(call.signal)
      const summaries = await source.list(query, LIST_LIMIT, call.signal)
      return { items: summaries.filter(summary => summary.ref.source === source.id && !summary.isDirectory).map(summary => ({
        id: summary.ref.id, title: summary.label, ...(summary.updatedAt !== undefined ? { updatedAt: summary.updatedAt } : {}),
      })) }
    },
  })
}
