import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ChatProvider } from '../wire.ts'
import { parseProviderQuery } from '../search.ts'
import { encodeReferenceUri } from '../uri-codec.ts'
import { formatRelative } from './format.ts'
import type { SearchResult } from './remote.ts'

declare module '@deepseek-ai/dsh-client-ui-input-trigger/client' {
  interface InputTriggerCandidate {
    readonly conversation?: SearchResult
  }
}

const LABEL: Record<ChatProvider, string> = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok',
}

/**
 * A distinct glyph per provider. The menu renders one 16px monochrome cell,
 * so these only have to be told apart at a glance — the provider is named in
 * full at the head of every description.
 */
const ICON: Record<ChatProvider, string> = {
  chatgpt: '◍', claude: '✳', gemini: '✦', deepseek: '◈', grok: '✕',
}

export function createConversationSource(search: (
  query: string, provider: ChatProvider | undefined, signal: AbortSignal,
) => Promise<readonly SearchResult[]>): InputTriggerSource {
  return {
    trigger: '@', name: 'Conversations',
    async candidates(_session, { query, signal }) {
      const parsed = parseProviderQuery(query)
      const rows = await search(parsed.query, parsed.provider, signal)
      return disambiguate(rows.map((row): InputTriggerCandidate => ({
        name: row.title.trim() || 'Untitled',
        description: describeRow(row),
        icon: ICON[row.provider], conversation: row,
      })))
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

/**
 * The dimmed trailing line of one menu row.
 *
 * A body hit shows its excerpt in place of the turn count: when the title did
 * not match, the excerpt is the only thing on the row that explains why it is
 * there.
 */
export function describeRow(row: SearchResult): string {
  const parts = [LABEL[row.provider], formatRelative(row.updatedAt)]
  parts.push(row.matchedVia === 'content' && row.snippet ? row.snippet : `${row.turnCount} turns`)
  if (row.partial) parts.push('partial')
  return parts.join(' · ')
}

/**
 * Suffix repeated names so each row in a batch is uniquely named.
 *
 * The menu keys its rows by `source:name` and resolves picks by exact name,
 * so the several conversations every provider leaves titled "New chat" would
 * otherwise collide.
 * @param rows - candidates in display order.
 * @returns the same rows, with the 2nd and later duplicate of a name numbered.
 */
export function disambiguate(rows: readonly InputTriggerCandidate[]): InputTriggerCandidate[] {
  const taken = new Set<string>()
  return rows.map((row) => {
    if (!taken.has(row.name)) { taken.add(row.name); return row }
    // Counting up rather than counting occurrences: a conversation genuinely
    // titled "New chat (2)" must not collide with a generated suffix.
    let ordinal = 2
    while (taken.has(`${row.name} (${ordinal})`)) ordinal++
    const name = `${row.name} (${ordinal})`
    taken.add(name)
    return { ...row, name }
  })
}

export { parseProviderQuery }
