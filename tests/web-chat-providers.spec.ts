import { describe, expect, it } from 'vitest'
import WebChatHistoryService from '../src/sources/web-chat/index.ts'

function serviceWith(enabledProviders: string[]) {
  const rows = [
    { key: 'a', row: { provider: 'chatgpt', title: 'A', url: 'u', updatedAt: '2026-01-01T00:00:00Z', messageCount: 1, partial: false, syncedAt: '2026-01-01T00:00:00Z' } },
    { key: 'b', row: { provider: 'claude', title: 'B', url: 'u', updatedAt: '2026-01-01T00:00:00Z', messageCount: 1, partial: false, syncedAt: '2026-01-01T00:00:00Z' } },
  ]
  const service = Object.create(WebChatHistoryService.prototype) as WebChatHistoryService
  Object.defineProperty(service, 'id', { value: 'web-chat' })
  Object.defineProperty(service, 'storeValue', { value: {
    settings: { enabledProviders, historyMode: 'offline-mirror' },
    list: (_query: string, provider: string | undefined, limit: number) => rows.filter(item => !provider || item.row.provider === provider).slice(0, limit),
    conversations: new Map(rows.map(item => [item.key, item.row])),
    read: async () => ({ body: { items: [] } }),
  }, configurable: true })
  return service
}

describe('web-chat provider switches', () => {
  it('neither lists nor reads a switched-off provider', async () => {
    const service = serviceWith(['claude'])
    expect((await service.list('', 1)).map(row => row.ref.id)).toEqual(['b'])
    expect((await service.search('', undefined, 10)).map(row => row.uriId)).toEqual(['b'])
    expect(await service.search('', 'chatgpt', 10)).toEqual([])
    await expect(service.read({ source: 'web-chat', id: 'a' }, { limit: 1 })).rejects.toMatchObject({ code: 'SOURCE_DISABLED' })
    await expect(service.read({ source: 'web-chat', id: 'b' }, { limit: 1 })).resolves.toBeDefined()
  })
})
