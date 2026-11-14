/**
 * Web AI chats as the `web` source of the `reference` tool.
 *
 * The local index holds metadata only; every load fetches the conversation
 * live (token first, browser fallback) and normalizes it into a reference
 * document, so paging, search, previews and budgets come from the shared SDK.
 * Ids are `<provider>:<conversationId>`; the account is checked against the
 * local index on every call and never travels in the id. No body is cached.
 */
import { createHash } from 'node:crypto'
import { ReferenceAnythingError } from '../../errors.ts'
import { MAX_DOWNLOAD_BYTES } from '../../local-reference.ts'
import { defineReferenceSource, referenceError, type ReferenceDoc, type ReferenceDocChild, type ReferenceSourcePlugin } from '../../reference-source.ts'
import { webAttachmentFailure } from './attachments.ts'
import { ConversationStore, type ProviderTurnRow } from '../../store/store.ts'
import type { ChatProvider } from '../../store/spec.ts'
import type { ConversationAttachment, ConversationItem } from '../../types.ts'
import type WebChatHistoryService from './index.ts'
import { projectRemoteTurns } from './index.ts'

/** Routing key of web chats in the `reference` tool. */
export const WEB_SOURCE = 'web'
const PROVIDERS: readonly ChatProvider[] = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi', 'qwen', 'qianwen', 'doubao']
const OFFLINE_NOTICE = 'Offline copy from the last sync; the live conversation could not be read.'

type Turn = ConversationItem & { attachments?: Array<ConversationAttachment & { locator?: string }> }

/** The `web` id of one conversation. */
export function webId(provider: ChatProvider, conversationId: string): string { return `${provider}:${conversationId}` }

function parseWebId(id: string): { provider: ChatProvider; conversationId: string } | undefined {
  const at = id.indexOf(':')
  const provider = id.slice(0, at) as ChatProvider
  const conversationId = id.slice(at + 1)
  return at > 0 && PROVIDERS.includes(provider) && conversationId && conversationId.length <= 4096 ? { provider, conversationId } : undefined
}

/** Content fingerprint: role, text and attachment identity; never fetch time or signed URLs. */
export function webRevision(turns: readonly Turn[]): string {
  const canonical = turns.map(turn => [turn.role, turn.text, (turn.attachments ?? []).map(item => [item.kind, item.name])])
  return 'web:' + createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Normalize provider turns into a reference document; attachments become numbered children. */
export function webDocument(title: string, turns: readonly Turn[], partial: boolean, notice?: string): ReferenceDoc {
  const children: ReferenceDocChild[] = []
  const content = turns.map((turn, index) => {
    for (const attachment of turn.attachments ?? []) {
      children.push({ key: String(children.length + 1), title: attachment.name, kind: attachment.kind, item: index + 1,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(Number.isSafeInteger(attachment.size) && attachment.size > 0 ? { size: attachment.size } : {}),
        data: attachment.locator && attachment.status === 'available' ? attachment.locator : undefined })
    }
    return { role: turn.role === 'assistant' ? 'assistant' as const : 'user' as const, text: turn.text }
  })
  return { title, revision: webRevision(turns), partial, content, children, ...(notice ? { notice } : {}) }
}

/** The `web` plugin over the synced conversation index. */
export function webReferencePlugin(history: WebChatHistoryService): ReferenceSourcePlugin {
  const resolve = (id: string) => {
    const parsed = parseWebId(id)
    if (!parsed) throw referenceError('INVALID_ARGS', 'This is not a web chat id; copy it from @ guidance, list or search.')
    const { provider, conversationId } = parsed
    if (!history.providerEnabled(provider)) {
      throw new ReferenceAnythingError(`${provider} conversations are switched off in Reference Anything settings`, 'SOURCE_DISABLED')
    }
    const matches = [...history.store.conversations.entries()].filter(([, row]) => row.provider === provider && row.externalId === conversationId && !row.remoteMissing)
    const [match] = matches
    if (matches.length !== 1 || !match) {
      throw referenceError('NOT_FOUND', `This conversation is missing from the local ${provider} index (or exists under several accounts); ask the user to sync ${provider} and reselect it from the refreshed @ list.`, 'relist')
    }
    if (!/^[a-f0-9]{64}$/.test(match[1].accountScope)) {
      throw new ReferenceAnythingError(`conversation has no verified ${provider} account scope; ask the user to sync ${provider} and reselect it`, 'REFERENCE_ACCOUNT_MISMATCH')
    }
    return { key: match[0], conversation: match[1] }
  }
  return defineReferenceSource({
    source: WEB_SOURCE,
    mentionSources: [history.id],
    previewTimeoutMs: 8_000,
    usage: 'Web AI chats synced from DeepSeek, Kimi, ChatGPT and other providers. Ids look like deepseek:<conversationId>. list accepts provider to narrow to one provider. Files and images are children: list the id, then read a child with as="image" or as="file".',
    examples: ['{"source":"web","op":"list","args":{"provider":"deepseek"}}'],
    args: { provider: { type: 'string', description: `Only this provider: ${PROVIDERS.join(', ')}.`, ops: ['list', 'search'] } },
    files: { maxBytes: MAX_DOWNLOAD_BYTES, directoryPrefix: 'dsh-reference-attachment-' },
    claim(ref) {
      if (ref.source === WEB_SOURCE) return parseWebId(ref.id) ? ref.id : undefined
      if (ref.source !== history.id) return undefined
      try {
        const [provider, , conversationId] = ConversationStore.parseConversationKey(ref.id)
        return webId(provider, conversationId)
      } catch { return undefined }
    },
    async check(id, signal) { signal?.throwIfAborted(); resolve(id) },
    async load(id, signal) {
      const { key, conversation } = resolve(id)
      try {
        const rows: ProviderTurnRow[] = await history.liveDetail(conversation, signal)
        return webDocument(conversation.title, projectRemoteTurns(rows, history.store.settings.includeThinking), conversation.partial || rows.some(row => row.partial))
      } catch (error) {
        signal.throwIfAborted()
        // An opted-in offline mirror answers when the live read fails, labelled as such.
        if (history.store.settings.historyMode !== 'offline-mirror' || !conversation.currentRevision) throw error
        const snapshot = history.store.read(key, { limit: Number.MAX_SAFE_INTEGER })
        if (snapshot.body.kind !== 'conversation') throw error
        return webDocument(conversation.title, snapshot.body.items as Turn[], conversation.partial, OFFLINE_NOTICE)
      }
    },
    async fetch(id, child, _maxBytes, signal) {
      const { conversation } = resolve(id)
      const locator = child.data
      if (typeof locator !== 'string') throw referenceError('SOURCE_UNAVAILABLE', 'The provider supplied no readable file for this child.')
      return {
        name: child.title || 'file',
        mimeType: child.mimeType ?? 'application/octet-stream',
        async writeTo(localPath, maxBytes, writeSignal) {
          try { await history.runner().attachment(conversation.provider, locator, localPath, maxBytes, writeSignal ?? signal, conversation.accountScope) }
          catch (error) { throw webAttachmentFailure(error, writeSignal ?? signal, conversation.provider) }
          // The account or provider switch may have changed while bytes were in flight.
          resolve(id)
        },
      }
    },
    async list(query, args) {
      const provider = args.provider
      if (provider !== undefined && (typeof provider !== 'string' || !PROVIDERS.includes(provider as ChatProvider))) {
        throw referenceError('INVALID_ARGS', `Unknown provider; use one of ${PROVIDERS.join(', ')}.`)
      }
      if (provider && !history.providerEnabled(provider as ChatProvider)) {
        throw new ReferenceAnythingError(`${provider} conversations are switched off in Reference Anything settings`, 'SOURCE_DISABLED')
      }
      const items: Array<{ id: string; title: string; kind: string; updatedAt?: number }> = []
      for (const { row } of history.listEnabled('', provider as ChatProvider | undefined, 5_000)) {
        if (!/^[a-f0-9]{64}$/.test(row.accountScope)) continue
        if (query && ![row.title, row.externalId].some(value => value.includes(query))) continue
        const updated = Date.parse(row.updatedAt)
        items.push({ id: webId(row.provider, row.externalId), title: row.title, kind: row.provider, ...(Number.isNaN(updated) ? {} : { updatedAt: updated }) })
      }
      items.sort((a, b) => (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity) || (a.id < b.id ? -1 : 1))
      return { items }
    },
  })
}
