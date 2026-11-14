import { beforeEach, describe, expect, it, vi } from 'vitest'
import WebChatHistoryService from '../src/sources/web-chat/index.ts'
import { OpenCliError, OpenCliRunner } from '../src/opencli.ts'
import { readToken, tokenEntry, WebChatTokenClient } from '../src/web-chat-token.ts'
import { settingsRecordSchema } from '../src/wire.ts'

const native = vi.hoisted(() => ({ constructor: vi.fn(), get: vi.fn(), set: vi.fn(), remove: vi.fn() }))
vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    constructor(...args: unknown[]) { native.constructor(...args) }
    getPassword = native.get
    setPassword = native.set
    deletePassword = native.remove
  },
}))

function serviceFixture() {
  let settings = settingsRecordSchema.parse({ opencliPath: 'opencli', profile: '', detailConcurrency: 2 })
  const writes: unknown[] = []
  const service = Object.create(WebChatHistoryService.prototype) as WebChatHistoryService
  Object.assign(service, {
    config: {}, tokenControllers: new Map(), tokenMutation: false, credentialStates: new Map(), renewals: new Map(),
    syncValue: { isRunning: () => false },
    storeValue: {
      get settings() { return settings },
      setSettings: async (value: unknown) => { writes.push(value); settings = settingsRecordSchema.parse(value) },
    },
  })
  vi.spyOn(service, 'ensureBrowser').mockResolvedValue()
  return { service, writes }
}

beforeEach(() => {
  vi.restoreAllMocks()
  native.constructor.mockReset()
  native.get.mockReset()
  native.set.mockReset().mockResolvedValue(undefined)
  native.remove.mockReset().mockResolvedValue(true)
})

describe('OS-only web credentials', () => {
  it('pins Linux to persistent Secret Service, without automatic keyutils fallback', async () => {
    await tokenEntry('test-id')
    expect(native.constructor).toHaveBeenCalledWith('dsh-reference-anything.web-chat', 'test-id', { linux: { store: 'secret-service' } })
  })

  it('stores the token only in the OS keyring and removes it on disconnect', async () => {
    const { service, writes } = serviceFixture()
    vi.spyOn(OpenCliRunner.prototype, 'captureToken').mockResolvedValue('synthetic-secret')
    vi.spyOn(WebChatTokenClient.prototype, 'identity').mockResolvedValue({ identity: 'account', accountScope: 'a'.repeat(64) })
    const settings = await service.connectToken('kimi', false)
    expect(settings.tokenAccounts?.kimi).toMatch(/^[a-f0-9-]{36}$/)
    expect(native.set).toHaveBeenCalledWith(JSON.stringify({ token: 'synthetic-secret', accountScope: 'a'.repeat(64) }))
    expect(JSON.stringify(writes)).not.toContain('synthetic-secret')
    expect(service.hasToken('kimi')).toBe(true)
    expect((await service.connectToken('kimi', true)).tokenAccounts?.kimi).toBeUndefined()
    expect(native.remove).toHaveBeenCalledOnce()
  })

  it('does not mark connected or save plaintext when the keyring rejects a write', async () => {
    const { service, writes } = serviceFixture()
    vi.spyOn(OpenCliRunner.prototype, 'captureToken').mockResolvedValue('synthetic-secret')
    vi.spyOn(WebChatTokenClient.prototype, 'identity').mockResolvedValue({ identity: 'account', accountScope: 'a'.repeat(64) })
    native.set.mockRejectedValue(new Error('native failure contains synthetic-secret'))
    await expect(service.connectToken('deepseek', false)).rejects.toThrow('Could not save')
    expect(service.hasToken('deepseek')).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it('does not fall back to the browser when a connected credential is missing or locked', async () => {
    const { service } = serviceFixture()
    vi.spyOn(OpenCliRunner.prototype, 'captureToken').mockResolvedValue('synthetic-secret')
    vi.spyOn(WebChatTokenClient.prototype, 'identity').mockResolvedValue({ identity: 'account', accountScope: 'a'.repeat(64) })
    await service.connectToken('kimi', false)
    native.get.mockRejectedValue(new Error('keyring locked synthetic-secret'))
    await expect(service.runner().syncIndex('kimi')).rejects.toMatchObject({ code: 'PROVIDER_NOT_LOGGED_IN' })
    await expect(readToken('id')).rejects.not.toThrow('synthetic-secret')
    expect(service.ensureBrowser).toHaveBeenCalledOnce()
  })
})

describe('renewing a refused token from the browser', () => {
  const scopeA = 'a'.repeat(64)
  async function connected() {
    const fixture = serviceFixture()
    const saved = new Map<string, string>()
    native.set.mockImplementation(async (value: string) => { saved.set('value', value) })
    native.get.mockImplementation(async () => saved.get('value') ?? null)
    const capture = vi.spyOn(OpenCliRunner.prototype, 'captureToken').mockResolvedValue('token-1')
    const identity = vi.spyOn(WebChatTokenClient.prototype, 'identity').mockResolvedValue({ identity: 'account', accountScope: scopeA })
    await fixture.service.connectToken('deepseek', false)
    return { ...fixture, saved, capture, identity }
  }
  const refused = () => Object.assign(new OpenCliError('Login expired; reconnect this account', 'PROVIDER_NOT_LOGGED_IN'))

  it('re-captures once for the same account, saves it and retries the request', async () => {
    const { service, saved, capture } = await connected()
    capture.mockResolvedValue('token-2')
    const run = vi.spyOn(WebChatTokenClient.prototype, 'run').mockRejectedValueOnce(refused()).mockResolvedValue([{ kind: 'identity', identity: 'account', sinceApplied: '' }])
    await service.runner().syncIndex('deepseek')
    expect(capture).toHaveBeenCalledTimes(2)
    expect(JSON.parse(saved.get('value')!)).toEqual({ token: 'token-2', accountScope: scopeA })
    expect(run).toHaveBeenCalledTimes(2)
    expect(service.credentialStateList()).toEqual([expect.objectContaining({ provider: 'deepseek', state: 'connected' })])
  })

  it('never saves a capture from a different account', async () => {
    const { service, saved, capture, identity } = await connected()
    capture.mockResolvedValue('token-other')
    identity.mockResolvedValue({ identity: 'someone-else', accountScope: 'b'.repeat(64) })
    vi.spyOn(WebChatTokenClient.prototype, 'run').mockRejectedValue(refused())
    await expect(service.runner().syncIndex('deepseek')).rejects.toThrow('different deepseek account')
    expect(JSON.parse(saved.get('value')!).token).toBe('token-1')
    expect(service.credentialStateList()[0]?.state).toBe('account_changed')
  })

  it('falls back to the browser adapter when the browser is not logged in', async () => {
    const { service, capture } = await connected()
    capture.mockRejectedValue(new Error('Login required'))
    vi.spyOn(WebChatTokenClient.prototype, 'run').mockRejectedValue(refused())
    const raw = vi.spyOn(OpenCliRunner.prototype as never, 'raw' as never).mockResolvedValue(JSON.stringify([{ kind: 'identity', identity: 'account', accountScope: scopeA, sinceApplied: '' }]) as never)
    await service.runner().syncIndex('deepseek').catch(() => undefined)
    expect(raw).toHaveBeenCalled()
    expect(service.credentialStateList()[0]?.state).toBe('needs_login')
  })

  it('shares one re-capture between concurrent refused requests', async () => {
    const { service, capture } = await connected()
    capture.mockClear()
    let release!: (value: string) => void
    capture.mockImplementation(() => new Promise<string>(accept => { release = accept }))
    vi.spyOn(WebChatTokenClient.prototype, 'run').mockImplementation(async function (this: { token?: string }) {
      if (native.get.mock.calls.length && JSON.parse((await native.get())).token === 'token-2') return []
      throw refused()
    })
    const calls = [service.runner().history('deepseek'), service.runner().history('deepseek'), service.runner().history('deepseek')]
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
    release('token-2')
    await Promise.all(calls)
    expect(capture).toHaveBeenCalledOnce()
  })
})
