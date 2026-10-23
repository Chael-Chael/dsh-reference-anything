import { beforeEach, describe, expect, it, vi } from 'vitest'
import WebChatHistoryService from '../src/sources/web-chat/index.ts'
import { OpenCliRunner } from '../src/opencli.ts'
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
    config: {}, tokenControllers: new Map(), tokenMutation: false,
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
