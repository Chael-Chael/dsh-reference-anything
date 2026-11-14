import { createHash } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { NewWebChatClient, parseNewWebDetail, credentialEndpoints } from '../src/web-chat-new-providers.ts'
import { parseProviderQuery } from '../src/search.ts'

const scope = (provider: string, id = 'account') => createHash('sha256').update(`${provider}\0${id}`).digest('hex')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const credential = (provider: 'qianwen' | 'doubao') => JSON.stringify(Object.fromEntries(Object.entries(credentialEndpoints[provider]).map(([key,url]) => [key, {
  url, method: provider === 'qianwen' && key === 'detail' ? 'GET' : 'POST', headers: { Cookie: 'synthetic=secret' },
  body: JSON.stringify(provider === 'doubao' ? { uplink_body: { pull_singe_chain_uplink_body: { conversation_id: 'old' } } } : { limit: 50 }),
}])))

describe('new website providers', () => {
  it('paginates Qwen ordinary history and does not claim an account-wide inventory', async () => {
    const fetcher = vi.fn(async (url: any) => json(String(url).includes('auth.qwen.ai') ? { success: true, data: { id: 'account' } }
      : { success: true, data: String(url).includes('page=1') ? [{ id: 'c', title: 'test', updated_at: 1700000000 }] : [] }))
    const rows = await new NewWebChatClient('qwen', 'synthetic', fetcher).run('sync-index', [], scope('qwen'))
    expect(rows[0]).toMatchObject({ identity: 'account', listingComplete: false })
    expect(rows[1]).toMatchObject({ id: 'c', provider: 'qwen', kind: 'conversation' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('rejects a changed account before any detail read', async () => {
    const fetcher = vi.fn(async () => json({ success: true, data: { id: 'other' } }))
    await expect(new NewWebChatClient('qwen', 'synthetic', fetcher).run('detail', ['c'], scope('qwen'))).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_MISMATCH' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([401, 403, 429])('sanitizes HTTP %s without exposing secrets', async status => {
    const client = new NewWebChatClient('qwen', 'private-token', vi.fn(async () => json({ text: 'private-response' }, status)))
    await expect(client.identity()).rejects.toMatchObject({ code: status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_NOT_LOGGED_IN' })
    try { await client.identity() } catch (e) { expect(String(e)).not.toMatch(/private-token|private-response/) }
  })
  it('never forwards captured cookies to another origin or endpoint', () => {
    const value = JSON.parse(credential('qianwen'))
    value.identity.url = 'https://evil.example/growth/user/benefit/user/member/info'
    expect(() => new NewWebChatClient('qianwen', JSON.stringify(value))).toThrow('Provider URL rejected')
    value.identity.url = 'https://api.qianwen.com/delete-account'
    expect(() => new NewWebChatClient('qianwen', JSON.stringify(value))).toThrow('Provider URL rejected')
  })
  it('uses server account identity for Qianwen and tolerates its observed final absent data page', async () => {
    let lists = 0
    const fetcher = vi.fn(async (url: any) => json(String(url).includes('member/info') ? { success: true, data: { userId: 'account' } }
      : ++lists === 1 ? { success: true, code: 0, data: { list: [{ session_id: 'c', title: 'test' }], have_next_page: true, next_token: 'next' } }
        : { success: true, code: 0 }))
    const rows = await new NewWebChatClient('qianwen', credential('qianwen'), fetcher).run('sync-index', [], scope('qianwen'))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.listingComplete).toBe(false)
  })
  it('rejects repeated pagination rather than hanging or declaring success', async () => {
    const fetcher = vi.fn(async (url: any) => json(String(url).includes('auth.qwen.ai') ? { data: { id: 'account' } } : { data: [{ id: 'same' }] }))
    await expect(new NewWebChatClient('qwen', 'synthetic', fetcher).run('sync-index', [], scope('qwen'))).rejects.toThrow('pagination did not advance')
  })
  it('reads Qwen active messages rather than regenerated graph alternatives', () => {
    expect(parseNewWebDetail('qwen', 'c', { data: { id: 'c', chat: { messages: [{ id: 'm', role: 'assistant', content: 'active' }], history: { messages: { discarded: { content: 'wrong branch' } } } } } })).toMatchObject([{ text: 'active', role: 'assistant' }])
  })
  it('combines Qianwen answer blocks into one assistant turn and marks unsupported content partial', () => {
    const rows = parseNewWebDetail('qianwen', 'c', { data: { have_next_page: false, list: [{ session_id: 'c', req_id: 'r', request_messages: [{ mime_type: 'text/plain', content: 'question' }], response_messages: [{ mime_type: 'text/plain', content: 'one' }, { mime_type: 'text/markdown', content: 'two' }, { mime_type: 'image/png' }] }] } })
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ text: 'one\ntwo', role: 'assistant', partial: true })
  })
  it('refuses incomplete long conversations and cross-conversation rows', () => {
    expect(() => parseNewWebDetail('qianwen', 'c', { data: { list: [], have_next_page: true } })).toThrow('pagination')
    expect(() => parseNewWebDetail('qwen', 'c', { data: { id: 'other', chat: { messages: [] } } })).toThrow()
  })
  it('orders Doubao IM messages and preserves human/bot roles', () => {
    const rows = parseNewWebDetail('doubao', 'c', { downlink_body: { pull_singe_chain_downlink_body: { has_more: false, messages: [
      { conversation_id: 'c', user_type: 2, index_in_conv: '2', content: 'answer' },
      { conversation_id: 'c', user_type: 1, index_in_conv: '1', content: 'question' },
    ] } } })
    expect(rows.map(row => [row.role, row.text])).toEqual([['user', 'question'], ['assistant', 'answer']])
  })
  it('reads Doubao block-based text when legacy content is empty, marking omitted media partial', () => {
    const rows = parseNewWebDetail('doubao', 'c', { downlink_body: { pull_singe_chain_downlink_body: { messages: [
      { user_type: 2, content: '', content_block: [{ content: { text_block: { text: 'answer' } } }, { content: { attachment_block: {} } }] },
    ] } } })
    expect(rows[0]).toMatchObject({ text: 'answer', partial: true })
  })
  it.each([['qwen:', 'qwen'], ['千问:', 'qianwen'], ['豆包:', 'doubao']])('recognizes provider prefix %s', (query, provider) => {
    expect(parseProviderQuery(query).provider).toBe(provider)
  })
})
