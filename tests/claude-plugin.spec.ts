import { afterAll, describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- plain JS adapter module, shipped to OpenCLI rather than compiled here.
import { whoamiScript } from '../opencli-plugin/claude.js'

afterAll(() => {
  const registry = (globalThis as typeof globalThis & { __opencli_registry__?: Map<string, unknown> }).__opencli_registry__
  for (const command of ['whoami', 'sync-index', 'history-all', 'detail', 'attachment']) {
    registry?.delete(`dsh-claude/${command}`)
  }
})

function compileWhoami(fetch: typeof globalThis.fetch) {
  return Function('fetch', `return (${whoamiScript})`)(fetch) as () => Promise<string>
}

function accountResponse(emailAddress: string | undefined, status = 200) {
  return new Response(JSON.stringify(emailAddress === undefined ? {} : { email_address: emailAddress }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Claude identity adapter', () => {
  it('distinguishes authenticated users without relying on an analytics cookie', async () => {
    const firstFetch = vi.fn(async () => accountResponse('first@example.test'))
    const secondFetch = vi.fn(async () => accountResponse('second@example.test'))

    const first = JSON.parse(await compileWhoami(firstFetch as typeof globalThis.fetch)())
    const second = JSON.parse(await compileWhoami(secondFetch as typeof globalThis.fetch)())

    expect(first).toEqual({ ok: true, identity: 'first@example.test' })
    expect(second).toEqual({ ok: true, identity: 'second@example.test' })
    expect(firstFetch).toHaveBeenCalledWith('/api/account', {
      credentials: 'include', headers: { Accept: 'application/json' },
    })
  })

  it('fails closed when the authenticated account has no stable email identity', async () => {
    const fetch = vi.fn(async () => accountResponse(undefined))

    const result = JSON.parse(await compileWhoami(fetch as typeof globalThis.fetch)())

    expect(result.ok).toBe(false)
    expect(result.identity).toBeUndefined()
    expect(result.code).toBeUndefined()
    expect(result.message).toMatch(/stable account identity/i)
  })

  it.each([401, 403])('preserves AUTH for an account HTTP %s response', async (status) => {
    const fetch = vi.fn(async () => accountResponse(undefined, status))

    const result = JSON.parse(await compileWhoami(fetch as typeof globalThis.fetch)())

    expect(result).toEqual({ ok: false, code: 'AUTH' })
  })

  it('reports rate limiting as RATE_LIMIT', async () => {
    const fetch = vi.fn(async () => accountResponse(undefined, 429))

    const result = JSON.parse(await compileWhoami(fetch as typeof globalThis.fetch)())

    expect(result).toEqual({ ok: false, code: 'RATE_LIMIT' })
  })
})
