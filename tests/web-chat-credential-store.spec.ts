import { describe, it, expect } from 'vitest'
import { credentialEntry } from '../src/web-chat-credential-store.ts'

function fixture() {
  const values = new Map<string, string>()
  let failAt = ''
  return { values, fail(key: string) { failAt = key }, entry: credentialEntry('root', id => ({
    getPassword: async () => values.get(id) ?? null,
    setPassword: async value => { if (id === failAt || Buffer.byteLength(value, 'utf16le') > 2560) throw new Error('write rejected'); values.set(id, value) },
    deletePassword: async () => { if (id === failAt) throw new Error('delete rejected'); return values.delete(id) },
  })) }
}
describe('segmented OS credentials', () => {
  it('round trips large Unicode credentials and deletes every part', async () => {
    const { entry, values } = fixture()
    const secret = 'credential-秘密😀'.repeat(1200)
    await entry.setPassword(secret)
    expect(values.size).toBeGreaterThan(2)
    expect([...values.values()].every(value => Buffer.byteLength(value, 'utf16le') <= 2560)).toBe(true)
    expect(await entry.getPassword()).toBe(secret)
    await entry.deletePassword()
    expect(values.size).toBe(0)
  })
  it('keeps legacy values readable and preserves the old secret when publishing new parts fails', async () => {
    const { entry, values, fail } = fixture()
    values.set('root', 'legacy')
    expect(await entry.getPassword()).toBe('legacy')
    fail('root')
    await expect(entry.setPassword('new'.repeat(3000))).rejects.toThrow()
    expect([...values.entries()]).toEqual([['root', 'legacy']])
  })
  it('removes superseded parts on reconnect', async () => {
    const { entry, values } = fixture()
    await entry.setPassword('first'.repeat(1500))
    const oldKeys = [...values.keys()].filter(key => key !== 'root')
    await entry.setPassword('replacement')
    expect(oldKeys.every(key => !values.has(key))).toBe(true)
    expect(await entry.getPassword()).toBe('replacement')
    await entry.deletePassword()
    expect(values.size).toBe(0)
  })
  it('rejects missing parts instead of returning a truncated credential', async () => {
    const { entry, values } = fixture()
    await entry.setPassword('secret'.repeat(1000))
    values.delete([...values.keys()].find(key => key !== 'root')!)
    await expect(entry.getPassword()).rejects.toThrow('Incomplete')
  })
})
