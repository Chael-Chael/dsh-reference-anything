import { randomUUID } from 'node:crypto'

export interface Entry { getPassword(): Promise<string | null>; setPassword(value: string): Promise<void>; deletePassword(): Promise<boolean> }
interface Parts { generation: string; count: number }
interface Manifest extends Parts { previous?: Parts }
const prefix = 'dsh-web-credential-parts-v1:'
function manifest(raw: string | null): Manifest | undefined {
  if (!raw?.startsWith(prefix)) return
  const value = JSON.parse(raw.slice(prefix.length))
  for (const parts of [value, ...(value.previous ? [value.previous] : [])]) {
    if (!/^[a-f0-9-]{36}$/.test(parts.generation) || !Number.isInteger(parts.count) || parts.count < 1 || parts.count > 128) throw new Error('Invalid credential manifest')
  }
  return value
}

/** Windows limits one credential to 2560 bytes of UTF-16 data; all parts remain in the OS keyring. */
export function credentialEntry(id: string, native: (id: string) => Entry): Entry {
  const root = native(id)
  const part = (parts: Parts, index: number) => native(`${id}:${parts.generation}:${index}`)
  const remove = async (parts: Parts) => { for (let index = 0; index < parts.count; index++) await part(parts, index).deletePassword() }
  return {
    async getPassword() {
      const raw = await root.getPassword()
      const parts = manifest(raw)
      if (!parts) return raw
      const values = []
      for (let index = 0; index < parts.count; index++) {
        const value = await part(parts, index).getPassword()
        if (value === null || value.length > 1000) throw new Error('Incomplete saved credential')
        values.push(value)
      }
      return Buffer.from(values.join(''), 'base64').toString('utf8')
    },
    async setPassword(value) {
      if (value.length > 128000) throw new Error('Credential exceeds storage limit')
      const previous = manifest(await root.getPassword())
      if (previous?.previous) await remove(previous.previous)
      if (value.length <= 1000 && !previous) { await root.setPassword(value); return }
      const encoded = Buffer.from(value, 'utf8').toString('base64')
      if (encoded.length > 128000) throw new Error('Credential exceeds storage limit')
      const next: Manifest = { generation: randomUUID(), count: Math.max(1, Math.ceil(encoded.length / 1000)),
        ...(previous ? { previous: { generation: previous.generation, count: previous.count } } : {}) }
      let written = 0
      try {
        for (; written < next.count; written++) await part(next, written).setPassword(encoded.slice(written * 1000, (written + 1) * 1000))
        await root.setPassword(prefix + JSON.stringify(next))
      } catch (error) {
        for (let index = 0; index < written; index++) await part(next, index).deletePassword()
        throw error
      }
      // Keep the prior generation recorded until cleanup succeeds, so disconnect/retry can finish it.
      if (next.previous) {
        await remove(next.previous)
        delete next.previous
        await root.setPassword(prefix + JSON.stringify(next))
      }
    },
    async deletePassword() {
      const parts = manifest(await root.getPassword())
      if (parts) { if (parts.previous) await remove(parts.previous); await remove(parts) }
      return root.deletePassword()
    },
  }
}
