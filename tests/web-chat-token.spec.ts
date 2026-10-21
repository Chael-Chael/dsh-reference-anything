import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { WebChatTokenClient } from '../src/web-chat-token.ts'
import { OpenCliRunner } from '../src/opencli.ts'

const scope = (provider: string, identity = 'account') => createHash('sha256').update(`${provider}\0${identity}`).digest('hex')
const json = (body: unknown, status = 200) => Response.json(body, { status })

describe('web chat token transport', () => {
  it('enumerates DeepSeek pages, deduplicates overlap and sends only bearer auth', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push(url.pathname)
      expect(url.origin).toBe('https://chat.deepseek.com')
      expect(init?.redirect).toBe('error')
      expect(init?.credentials).toBe('omit')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-token')
      expect(new Headers(init?.headers).has('Cookie')).toBe(false)
      if (url.pathname.endsWith('/current')) return json({ code: 0, data: { biz_data: { id: 'account' } } })
      return json({ code: 0, data: { biz_data: {
        chat_sessions: url.searchParams.has('lte_cursor.updated_at')
          ? [{ id: 'a', updated_at: 100 }, { id: 'b', updated_at: 90 }] : [{ id: 'a', updated_at: 100 }],
        has_more: !url.searchParams.has('lte_cursor.updated_at'),
      } } })
    })
    const client = new WebChatTokenClient('deepseek', 'synthetic-token', fetcher)
    const rows = await client.run('sync-index', [], scope('deepseek'))
    expect(rows.map(row => row.id).filter(Boolean)).toEqual(['a', 'b'])
    expect(calls).toHaveLength(3)
  })

  it('reads Kimi paginated messages in chronological order without a browser', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith('/api/user')) return json({ id: 'account' })
      const older = JSON.parse(String(init?.body)).pageToken
      return json(older ? { messages: [{ id: 'old', role: 'user', content: 'question' }] }
        : { messages: [{ id: 'new', role: 'assistant', content: 'answer' }], nextPageToken: 'older' })
    })
    const client = new WebChatTokenClient('kimi', 'synthetic-token', fetcher)
    const rows = await client.run('detail', ['chat', '--accountScope', scope('kimi')], scope('kimi'))
    expect(rows.map(row => row.text)).toEqual(['question', 'answer'])
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each([401, 403, 429])('rejects HTTP %s without leaking response text or token', async status => {
    const client = new WebChatTokenClient('kimi', 'synthetic-token', vi.fn(async () => json({ secret: 'server-secret' }, status)))
    await expect(client.identity()).rejects.toMatchObject({ code: status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_NOT_LOGGED_IN' })
    try { await client.identity() } catch (error) { expect(String(error)).not.toMatch(/synthetic-token|server-secret/) }
  })

  it('rejects DeepSeek business authentication errors, never interpreting them as empty history', async () => {
    const client = new WebChatTokenClient('deepseek', 'synthetic', vi.fn(async () => json({ code: 40003 })))
    await expect(client.run('sync-index', [], scope('deepseek'))).rejects.toMatchObject({ code: 'PROVIDER_NOT_LOGGED_IN' })
  })

  it('rejects an account mismatch before reading any messages', async () => {
    const fetcher = vi.fn(async () => json({ id: 'other-account' }))
    const client = new WebChatTokenClient('kimi', 'synthetic', fetcher)
    await expect(client.run('detail', ['chat'], scope('kimi'))).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_MISMATCH' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('fails a listing when a later page is malformed instead of returning partial success', async () => {
    let page = 0
    const client = new WebChatTokenClient('deepseek', 'synthetic', vi.fn(async input => {
      if (String(input).includes('/users/current')) return json({ data: { biz_data: { id: 'account' } } })
      return json(++page === 1 ? { data: { biz_data: { chat_sessions: [{ id: 'a', updated_at: 10 }], has_more: true } } } : {})
    }))
    await expect(client.run('sync-index', [], scope('deepseek'))).rejects.toMatchObject({ code: 'OPENCLI_FAILED' })
  })

  it('rejects foreign attachment URLs before sending the token', async () => {
    const fetcher = vi.fn(async () => json({ id: 'account' }))
    const client = new WebChatTokenClient('kimi', 'synthetic', fetcher)
    await expect(client.run('attachment', ['https://evil.example/file', '--maxBytes', '10', '--output', 'unused'], scope('kimi')))
      .rejects.toMatchObject({ code: 'OPENCLI_CONFIGURATION' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('maps oversized attachments to the attachment error without writing a file', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => String(input).endsWith('/api/user')
      ? json({ id: 'account' }) : new Response('oversized', { headers: { 'content-length': '9' } }))
    const client = new WebChatTokenClient('kimi', 'synthetic', fetcher)
    await expect(client.run('attachment', ['/file', '--maxBytes', '1', '--output', 'unused'], scope('kimi')))
      .rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' })
  })

  it('honors cancellation and rejects oversized responses', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(33 * 1024 * 1024) } }))
    const client = new WebChatTokenClient('kimi', 'synthetic', fetcher)
    await expect(client.identity()).rejects.toMatchObject({ code: 'OPENCLI_OUTPUT_TOO_LARGE' })
    fetcher.mockClear()
    await expect(client.identity(AbortSignal.abort())).rejects.toBeDefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('routes connected providers through the token transport and keeps CLI parsing', async () => {
    const runner = new OpenCliRunner({ executable: 'must-not-launch' })
    runner.tokenRequest = vi.fn(async () => [{ kind: 'identity', identity: 'account', sinceApplied: '' },
      { kind: 'conversation', id: 'chat', title: 'title', url: 'https://www.kimi.com/chat/chat' }])
    expect((await runner.syncIndex('kimi')).accountScope).toBe(scope('kimi'))
    expect(runner.tokenRequest).toHaveBeenCalledOnce()
  })
})
