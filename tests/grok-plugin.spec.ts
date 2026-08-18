import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- plain JS adapter module, shipped to OpenCLI rather than compiled here.
import { whoamiScript } from '../opencli-plugin/grok.js'

function compileWhoami(fetch: typeof globalThis.fetch) {
  return Function('fetch', `return (${whoamiScript})`)(fetch) as () => Promise<string>
}

describe('Grok identity adapter', () => {
  it('recognizes the current auth session response', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
      url === '/api/auth/session'
        ? { status: 'authenticated', session: { userId: 'stable-user-id', email: 'private@example.test' } }
        : { code: 404 },
    ), { status: url === '/api/auth/session' ? 200 : 404, headers: { 'content-type': 'application/json' } }))

    const result = JSON.parse(await compileWhoami(fetch as typeof globalThis.fetch)())

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/auth/session', {
      credentials: 'include', headers: { Accept: 'application/json' },
    })
    expect(result).toEqual({ ok: true, identity: 'stable-user-id' })
  })

  it('keeps the legacy identity endpoints as fallbacks', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
      url === '/rest/app-chat/users/me' ? { user: { id: 'legacy-user-id' } } : { code: 404 },
    ), { status: url === '/rest/app-chat/users/me' ? 200 : 404, headers: { 'content-type': 'application/json' } }))

    const result = JSON.parse(await compileWhoami(fetch as typeof globalThis.fetch)())

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: true, identity: 'legacy-user-id' })
  })
})
