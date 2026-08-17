import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ChatProvider } from '../wire.ts'
import { encodeReferenceUri } from '../uri-codec.ts'
import type { SearchResult } from './remote.ts'

declare module '@deepseek-ai/dsh-client-ui-input-trigger/client' {
  interface InputTriggerCandidate {
    readonly conversation?: SearchResult
  }
}

const LABEL: Record<ChatProvider, string> = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok',
}
const CONVERSATION_SOURCE = 'Conversations'

interface ConversationReference {
  uriId: string
  label: string
}

function encodeConversationReference(reference: ConversationReference): string {
  return JSON.stringify(reference)
}

function decodeConversationReference(value: string): ConversationReference {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== 'object') throw new Error('invalid conversation reference')
  const { uriId, label } = parsed as { uriId?: unknown; label?: unknown }
  if (typeof uriId !== 'string' || typeof label !== 'string') throw new Error('invalid conversation reference')
  return { uriId, label }
}

function formatConversationMention(reference: ConversationReference): string {
  return `@[${reference.label}](${conversationReferenceUri(reference.uriId)})`
}

export function createConversationSource(search: (
  query: string, provider: ChatProvider | undefined, signal: AbortSignal,
) => Promise<readonly SearchResult[]>): InputTriggerSource {
  return {
    trigger: '@', name: CONVERSATION_SOURCE,
    async candidates(_session, { query, signal }) {
      const parsed = parseQuery(query)
      const rows = await search(parsed.query, parsed.provider, signal)
      return rows.map((row): InputTriggerCandidate => ({
        name: row.title,
        description: `${LABEL[row.provider]} · ${row.turnCount} turns · ${formatDate(row.updatedAt)}${row.partial ? ' · partial' : ''}`,
        icon: '💬', conversation: row,
      }))
    },
    onPick({ candidate }) {
      const row = candidate.conversation
      if (!row) return undefined
      const title = `${LABEL[row.provider]} · ${row.title}`.replace(/[\[\]]/g, '')
      const reference = { uriId: row.uriId, label: title }
      return {
        insert: {
          source: CONVERSATION_SOURCE,
          ref: encodeConversationReference(reference),
          // The input's object replacement chip keeps the transport URI out
          // of the textarea while retaining a compact, recognizable label.
          label: `💬 ${title}`,
          clipboardText: formatConversationMention(reference),
        },
      }
    },
    codec: {
      clipboardText(ref) { return formatConversationMention(decodeConversationReference(ref)) },
      serialize(ref) { return Promise.resolve(formatConversationMention(decodeConversationReference(ref))) },
    },
  }
}

export function conversationReferenceUri(uriId: string): string {
  return encodeReferenceUri({ source: 'web-chat', id: uriId })
}

export function parseQuery(value: string): { query: string; provider?: ChatProvider } {
  const match = value.trim().match(/^(chatgpt|claude|gemini|deepseek|grok)(?:\s+|$)(.*)$/i)
  return match ? { provider: match[1]!.toLowerCase() as ChatProvider, query: (match[2] || '').trim() } : { query: value.trim() }
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleDateString()
}
