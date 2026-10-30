import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { assertRegistry, registryVersion, waitForRegistry, verifyPackage } from '../scripts/agent/release-ci.mjs'

function fixture() {
  return { manifest: { name: 'dsh-reference-anything', version: '0.5.2', integrity: 'sha512-fixture' } }
}

describe('npm release verification', () => {
  it('rejects a modified tarball before publishing', () => {
    const bytes = Buffer.from('package fixture')
    const record = { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
    expect(() => verifyPackage(record, bytes)).not.toThrow()
    expect(() => verifyPackage(record, Buffer.from('changed'))).toThrow('integrity')
  })
  it('waits for registry processing and transient outages without retrying a mismatch or authorization failure', async () => {
    const { manifest } = fixture()
    const responses = [
      { status: 404 }, { status: 503 }, { status: 429 },
      new TypeError('fetch failed'), Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
      { ok: true, json: async () => ({ name: manifest.name, version: manifest.version, dist: { integrity: manifest.integrity } }) },
    ]
    let pauses = 0
    await waitForRegistry(manifest, async () => { const response = responses.shift(); if (response instanceof Error) throw response; return response }, async () => { pauses++ })
    expect(pauses).toBe(5)
    for (const response of [{ status: 401 }, { status: 403 }, { ok: true, json: async () => ({ name: 'wrong' }) }]) {
      await expect(waitForRegistry(manifest, async () => response, async () => { throw new Error('must not retry') })).rejects.toThrow(/Registry lookup failed|different identity/)
    }
    let attempts = 0
    await expect(waitForRegistry(manifest, async () => { attempts++; return { status: 404 } }, async () => {})).rejects.toThrow('not visible yet')
    expect(attempts).toBe(30)
  })
  it('only treats HTTP 404 as an absent npm version', async () => {
    expect(await registryVersion('pkg', '1.0.0', async () => ({ status: 404 }))).toBeNull()
    for (const status of [401, 403, 429, 500]) {
      await expect(registryVersion('pkg', '1.0.0', async () => ({ status, ok: false }))).rejects.toThrow('Registry lookup failed')
    }
    await expect(registryVersion('pkg', '1.0.0', async () => { throw new Error('offline') })).rejects.toThrow('offline')
  })
  it('requires the existing npm version to have the accepted integrity', async () => {
    const { manifest } = fixture()
    const remote = { name: manifest.name, version: manifest.version, dist: { integrity: manifest.integrity } }
    expect(await registryVersion(remote.name, remote.version, async () => ({ ok: true, json: async () => remote }))).toEqual(remote)
    expect(() => assertRegistry(remote, manifest)).not.toThrow()
    for (const changed of [{ ...remote, name: 'wrong' }, { ...remote, version: '2.0.0' }, { ...remote, dist: { integrity: 'wrong' } }]) {
      expect(() => assertRegistry(changed, manifest)).toThrow()
    }
  })
})
