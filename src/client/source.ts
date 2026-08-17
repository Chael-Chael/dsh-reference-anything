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

export function createConversationSource(search: (
  query: string, provider: ChatProvider | undefined, signal: AbortSignal,
) => Promise<readonly SearchResult[]>): InputTriggerSource {
  return {
    trigger: '@', name: 'Conversations',
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
      return { text: `@[${title}](${conversationReferenceUri(row.uriId)}) ` }
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
