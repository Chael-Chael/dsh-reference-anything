import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- plain JS adapter module, shipped to OpenCLI rather than compiled here.
import { detailScript } from '../opencli-plugin/kimi.js'

function compileDetail(fetch: typeof globalThis.fetch) {
  const localStorage = { getItem: vi.fn(() => 'token') }
  const location = { origin: 'https://www.kimi.com' }
  return Function('fetch', 'localStorage', 'location', `return (${detailScript})`)(fetch, localStorage, location) as
    (args: { id: string }) => Promise<string>
}

describe('Kimi detail adapter', () => {
  it('reads block text, follows pageToken, and restores chronological order', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { pageToken?: string }
      const payload = body.pageToken
        ? { messages: [{ id: 'old', parentId: '', role: 'user', blocks: [{ text: { content: 'old question' } }] }] }
        : {
            messages: [{ id: 'new', parentId: 'old', role: 'assistant', blocks: [{ text: { content: 'new answer' } }] }],
            nextPageToken: 'older-page',
          }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = JSON.parse(await compileDetail(fetch as typeof globalThis.fetch)({ id: 'chat-id' }))

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ chat_id: 'chat-id', pageToken: 'older-page' })
    expect(result.ok).toBe(true)
    expect(result.rows).toMatchObject([
      { ordinal: 0, messageId: 'old', role: 'user', text: 'old question' },
      { ordinal: 1, messageId: 'new', role: 'assistant', text: 'new answer' },
    ])
  })
})
