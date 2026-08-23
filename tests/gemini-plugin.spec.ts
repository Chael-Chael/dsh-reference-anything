import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JS adapter module, shipped to OpenCLI rather than compiled here.
import { whoamiScript } from '../opencli-plugin/gemini.js'

afterAll(() => {
  const registry = (globalThis as typeof globalThis & { __opencli_registry__?: Map<string, unknown> }).__opencli_registry__
  for (const command of ['whoami', 'sync-index', 'history-all', 'detail', 'attachment']) {
    registry?.delete(`dsh-gemini/${command}`)
  }
})

function compileWhoami(wiz: Record<string, unknown>, pathname: string) {
  const window = { __WIZ_global_data: wiz }
  const location = { pathname }
  return Function('window', 'location', `return (${whoamiScript})`)(window, location) as () => Promise<string>
}

describe('Gemini identity adapter', () => {
  it('does not treat the URL account slot as a stable account identity', async () => {
    const result = JSON.parse(await compileWhoami({}, '/u/0/')())

    expect(result.ok).toBe(false)
    expect(result.identity).toBeUndefined()
    expect(result.message).toMatch(/stable account identity/i)
  })

  it('returns a genuine WIZ account identifier', async () => {
    const result = JSON.parse(await compileWhoami({ oPEP7c: 'stable-wiz-user-id' }, '/u/0/')())

    expect(result).toEqual({ ok: true, identity: 'stable-wiz-user-id' })
  })
})
