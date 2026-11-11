import { describe, expect, it } from 'vitest'
import { REFERENCE_ANYTHING_INVOCATIONS, REMOTE_SERVICE_KEYS } from '../src/contract.ts'
import { REFERENCE_ANYTHING_REMOTES, composeRemoteFace } from '../src/client/remote.ts'

describe('client Remote face', () => {
  it('routes each method to the Remote that owns it and fails softly when that Remote is absent', async () => {
    const face = composeRemoteFace({ [REMOTE_SERVICE_KEYS.core]: { settingsGet: async () => ({ ok: true, value: 'core' }) } })
    await expect(face.settingsGet()).resolves.toEqual({ ok: true, value: 'core' })
    await expect(face.search({ query: '', limit: 1 })).resolves.toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } })
    await expect(face.driveSearch({ query: '', limit: 1 })).resolves.toMatchObject({ ok: false })
  })

  it('assigns every invocation to exactly one Remote', () => {
    const methods = REFERENCE_ANYTHING_REMOTES.flatMap(item => item.contribution.descriptors.map(descriptor => descriptor.method))
    expect(new Set(methods).size).toBe(methods.length)
    expect(methods.length).toBe(REFERENCE_ANYTHING_INVOCATIONS.length)
    for (const item of REFERENCE_ANYTHING_REMOTES) {
      expect(item.contribution.descriptors.every(descriptor => descriptor.service === item.key)).toBe(true)
    }
  })
})

describe('Typert identities', () => {
  it('gives every Remote its own package, which Typert requires', async () => {
    const { CORE_TYPERT_MANIFEST, DRIVE_TYPERT_MANIFEST, LOCAL_AGENT_TYPERT_MANIFEST, LOCAL_PLUGIN_TYPERT_MANIFEST, WEB_CHAT_TYPERT_MANIFEST } = await import('../src/typert.ts')
    const hosts = [CORE_TYPERT_MANIFEST, WEB_CHAT_TYPERT_MANIFEST, LOCAL_AGENT_TYPERT_MANIFEST, DRIVE_TYPERT_MANIFEST, LOCAL_PLUGIN_TYPERT_MANIFEST].map(item => item.package)
    expect(new Set(hosts).size).toBe(5)
    const clients = REFERENCE_ANYTHING_REMOTES.map(item => item.contribution.package)
    expect(new Set(clients).size).toBe(5)
  })
})
