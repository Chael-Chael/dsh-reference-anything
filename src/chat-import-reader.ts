import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { ReferenceAnythingError } from './errors.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { agentKind } from './chat-import-discovery.ts'
import { localAgentSchema } from './wire.ts'
import { readLocalConversation } from './local-conversation-reader.ts'
import type { ConversationItem, ReferenceRef, ReferenceSnapshot, ReferenceWindow } from './types.ts'

const targetSchema = z.object({ format: z.string().min(1), path: z.string().min(1), sessionId: z.string().min(1) })
export type ChatImportTarget = z.infer<typeof targetSchema>
export function chatImportReference(target: ChatImportTarget): string {
  return `${agentKind(target.format)}:chat-import:${Buffer.from(JSON.stringify(target)).toString('base64url')}`
}
export function chatImportTarget(id: string): ChatImportTarget | undefined {
  const marker = ':chat-import:'
  const index = id.indexOf(marker)
  if (index < 0) return undefined
  const target = targetSchema.parse(JSON.parse(Buffer.from(id.slice(index + marker.length), 'base64url').toString()))
  if (localAgentSchema.parse(agentKind(target.format)) !== id.slice(0, index)) throw new Error('Invalid conversation reference')
  return target
}

export const referenceImageSchema = z.object({
  attachmentId: z.string().min(1), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive(), name: z.string().optional(),
})
export type ReferenceImage = z.infer<typeof referenceImageSchema>
const pageSchema = z.object({
  title: z.string(), revision: z.string().min(1), startIndex: z.number().int().nonnegative(),
  totalMessages: z.number().int().nonnegative(), hasOlder: z.boolean(), partial: z.boolean(),
  items: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), data: z.string().max(24 * 1024 * 1024).optional(), mediaType: referenceImageSchema.shape.mediaType.optional(), attachment: referenceImageSchema.optional() }),
  ])) })),
})

export async function readChatImport(ctx: Context, ref: ReferenceRef, target: ChatImportTarget, window: ReferenceWindow, signal?: AbortSignal): Promise<ReferenceSnapshot> {
  let cursor: { id: string; before: number; revision: string } | undefined
  if (window.cursor) {
    try {
      cursor = z.object({ id: z.string(), before: z.number().int().nonnegative(), revision: z.string().min(1) }).parse(JSON.parse(Buffer.from(window.cursor, 'base64url').toString()))
    } catch {
      throw new ReferenceAnythingError('Pagination cursor is malformed. Copy nextCursor exactly from the previous result, or omit cursor to restart from the latest page.', 'REFERENCE_INVALID_CURSOR')
    }
    if (cursor.id !== ref.id) throw new ReferenceAnythingError('Pagination cursor does not match this reference; it may have been altered or copied from another conversation. Copy uri and nextCursor exactly from the same read, or omit cursor to restart.', 'REFERENCE_INVALID_CURSOR')
  }
  signal?.throwIfAborted()
  const input = { ...target, limit: Math.min(window.limit, 100), before: cursor?.before ?? window.before, revision: cursor?.revision, detail: window.detail ?? 'summary' }
  let page: z.infer<typeof pageSchema>
  try {
    page = pageSchema.parse(await readLocalConversation(input, signal))
  } catch (cause) {
    signal?.throwIfAborted()
    if (cause instanceof ReferenceAnythingError) throw cause
    const message = cause instanceof Error ? cause.message : ''
    const code = (cause as NodeJS.ErrnoException | null)?.code
    if (message === 'Conversation changed; read its latest page again') throw new ReferenceAnythingError('Conversation content changed since this cursor was issued. Call external_reference_read with the same uri and omit cursor, then use the newly returned nextCursor.', 'REFERENCE_CURSOR_EXPIRED')
    if (code === 'ENOENT' || message.startsWith('Conversation source not found:')) throw new ReferenceAnythingError('The conversation source file no longer exists. Refresh the local conversation list and reselect the conversation; do not search unrelated files.', 'REFERENCE_NOT_FOUND')
    if (message.startsWith('Conversation body unavailable:')) throw new ReferenceAnythingError('This conversation contains metadata only; its transcript is unavailable. Open it in the original client to restore its transcript, then refresh and reselect it. Do not retry or substitute another conversation.', 'REFERENCE_NOT_FOUND')
    if (code === 'EACCES' || code === 'EPERM') throw new ReferenceAnythingError('Permission denied while reading the conversation source. Check the source file permissions and DSH access; retry after access is restored.', 'REFERENCE_READ_FAILED')
    // Parser errors can contain transcript snippets; expose the failure stage, not raw content.
    throw new ReferenceAnythingError(cause instanceof z.ZodError
      ? 'The local conversation parser returned an invalid response. Check the plugin version and report this source format.'
      : 'The local conversation parser could not read this source. The file may be invalid or its format unsupported. Check it in the original client; do not repeatedly retry or substitute another conversation.', 'REFERENCE_READ_FAILED')
  }
  let partial = page.partial
  let imageCount = 0
  const items: ConversationItem[] = []
  for (const item of page.items) {
    const text: string[] = []
    const images: ReferenceImage[] = []
    for (const block of item.content) {
      signal?.throwIfAborted()
      if (block.type === 'text') { text.push(block.text); continue }
      try {
        if (++imageCount > 10) throw new Error('Read fewer messages to view additional images')
        const store = ctx.get('attachments')
        if (!store) throw new Error('DSH attachment service unavailable')
        if (block.attachment) {
          // 验证附件在当前宿主仍可读取；不把失效引用交给模型适配器。
          await store.readImage({ ...block.attachment, attachmentId: AttachmentId(block.attachment.attachmentId) }, signal)
          images.push(block.attachment)
        } else {
          if (!block.data || !block.mediaType) throw new Error('Source image bytes unavailable')
          images.push(referenceImageSchema.parse(await store.saveImage({ data: Buffer.from(block.data, 'base64'), mediaType: block.mediaType })))
        }
        text.push(`[image ${images.length} attached below]`)
      } catch (error) {
        signal?.throwIfAborted()
        partial = true
        text.push(`[image unavailable: ${error instanceof Error ? error.message : String(error)}]`)
      }
    }
    items.push({ role: item.role, text: text.join('\n'), ...(images.length ? { images } : {}) })
  }
  return { ref, label: page.title || target.sessionId, origin: target.path, provider: agentKind(target.format), capturedAt: Date.now(), partial, revision: page.revision,
    body: { kind: 'conversation', items, startIndex: page.startIndex, totalTurns: page.totalMessages, hasOlder: page.hasOlder,
      ...(page.hasOlder ? { nextCursor: Buffer.from(JSON.stringify({ id: ref.id, before: page.startIndex, revision: page.revision })).toString('base64url') } : {}) } }
}
