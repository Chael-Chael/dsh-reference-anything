import { afterAll, describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- plain JS adapter module, shipped to OpenCLI rather than compiled here.
import { whoamiScript as chatgptWhoamiScript } from '../opencli-plugin/chatgpt.js'
// @ts-expect-error -- plain JS adapter module, shipped to OpenCLI rather than compiled here.
import { whoamiScript as deepseekWhoamiScript } from '../opencli-plugin/deepseek.js'
// @ts-expect-error -- plain JS adapter module, shipped to OpenCLI rather than compiled here.
import { whoamiScript as grokWhoamiScript } from '../opencli-plugin/grok.js'
// @ts-expect-error -- plain JS adapter module, shipped to OpenCLI rather than compiled here.
import { whoamiScript as kimiWhoamiScript } from '../opencli-plugin/kimi.js'

const registeredSites = ['dsh-chatgpt', 'dsh-deepseek', 'dsh-grok', 'dsh-kimi']

function compileWhoami(script: string, fetch: typeof globalThis.fetch) {
  const localStorage = { getItem: vi.fn(() => '') }
  return Function('fetch', 'localStorage', `return (${script})`)(fetch, localStorage) as () => Promise<string>
}

afterAll(() => {
  const registry = (globalThis as typeof globalThis & {
    __opencli_registry__?: Map<string, unknown>
  }).__opencli_registry__
  for (const site of registeredSites) {
    for (const command of ['whoami', 'sync-index', 'history-all', 'detail', 'attachment']) {
      registry?.delete(`${site}/${command}`)
    }
  }
})

describe('provider identity rate limits', () => {
  it('returns RATE_LIMIT when ChatGPT rejects the identity probe with 429', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 429 }))

    const result = JSON.parse(await compileWhoami(chatgptWhoamiScript, fetch as typeof globalThis.fetch)())

    expect(result).toEqual({ ok: false, code: 'RATE_LIMIT' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('returns RATE_LIMIT without probing a DeepSeek fallback endpoint after 429', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 429 }))

    const result = JSON.parse(await compileWhoami(deepseekWhoamiScript, fetch as typeof globalThis.fetch)())

    expect(result).toEqual({ ok: false, code: 'RATE_LIMIT' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('returns RATE_LIMIT without probing a Grok fallback endpoint after 429', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 429 }))

    const result = JSON.parse(await compileWhoami(grokWhoamiScript, fetch as typeof globalThis.fetch)())

    expect(result).toEqual({ ok: false, code: 'RATE_LIMIT' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('returns RATE_LIMIT when Kimi rejects the identity probe with 429', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 429 }))

    const result = JSON.parse(await compileWhoami(kimiWhoamiScript, fetch as typeof globalThis.fetch)())

    expect(result).toEqual({ ok: false, code: 'RATE_LIMIT' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
