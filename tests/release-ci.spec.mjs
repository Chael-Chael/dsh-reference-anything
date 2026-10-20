import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertCandidate, assertRegistry, candidateManifest, registryVersion } from '../scripts/agent/release-ci.mjs'

function fixture() {
  const tarball = Buffer.from('accepted package fixture')
  const notes = Buffer.from('中文\nEnglish\n')
  const record = { version: '1.0.0', head: 'abc', package: {
    sha256: createHash('sha256').update(tarball).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
  }, editorialApproval: { userMessage: 'private user message' }, checks: { evidence: 'private path' } }
  const pkg = { name: 'dsh-reference-anything', version: record.version }
  return { tarball, notes, record, pkg, manifest: candidateManifest(record, pkg.name, notes, tarball) }
}

describe('CI release handoff', () => {
  it('exports only public identity, hashes and gate outcomes', () => {
    const { manifest, record, notes, tarball, pkg } = fixture()
    expect(JSON.stringify(manifest)).not.toMatch(/private|userMessage|evidence/)
    expect(() => assertCandidate(manifest, pkg, 'abc', 'v1.0.0', notes, tarball)).not.toThrow()
    record.package.integrity = 'stale'
    expect(() => candidateManifest(record, pkg.name, notes, tarball)).toThrow(/integrity/)
  })
  it('rejects altered package, notes, source, version, approval and tag', () => {
    const { manifest, pkg, notes, tarball } = fixture()
    for (const key of ['schema', 'name', 'version', 'head', 'gate', 'editorialApproval', 'packageSha256', 'integrity', 'notesSha256']) {
      expect(() => assertCandidate({ ...manifest, [key]: 'changed' }, pkg, 'abc', 'v1.0.0', notes, tarball)).toThrow()
    }
    expect(() => assertCandidate(manifest, pkg, 'abc', 'v9.0.0', notes, tarball)).toThrow()
    expect(() => assertCandidate(manifest, pkg, 'abc', 'v1.0.0', Buffer.from('changed'), tarball)).toThrow()
    expect(() => assertCandidate(manifest, pkg, 'abc', 'v1.0.0', notes, Buffer.from('changed'))).toThrow()
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
  it('verifies a real tagged package and refuses notes inconsistent with Git even if rehashed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-release-ci-'))
    const run = (command, args) => execFileSync(command, args, { cwd: directory, encoding: 'utf8', windowsHide: true })
    try {
      mkdirSync(join(directory, 'scripts/agent'), { recursive: true })
      mkdirSync(join(directory, 'docs/release/1.0.0'), { recursive: true })
      mkdirSync(join(directory, 'package'))
      mkdirSync(join(directory, 'candidate'))
      for (const name of ['release-ci.mjs', 'workflow.mjs']) {
        copyFileSync(resolve('scripts/agent', name), join(directory, 'scripts/agent', name))
      }
      const pkg = { name: 'dsh-reference-anything', version: '1.0.0' }
      for (const path of ['package.json', 'package/package.json']) writeFileSync(join(directory, path), JSON.stringify(pkg))
      const notes = Buffer.from('Reviewed 中文 / English\n')
      writeFileSync(join(directory, 'docs/release/1.0.0/README.md'), notes)
      run('git', ['init', '-q'])
      run('git', ['-c', 'core.autocrlf=false', 'add', '.'])
      run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
      const head = run('git', ['rev-parse', 'HEAD']).trim()
      run('tar', ['-czf', 'candidate/candidate.tgz', 'package/package.json'])
      const tarball = readFileSync(join(directory, 'candidate/candidate.tgz'))
      const record = { head, version: pkg.version, package: {
        sha256: createHash('sha256').update(tarball).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
      } }
      const save = text => {
        writeFileSync(join(directory, 'candidate/release-notes.md'), text)
        writeFileSync(join(directory, 'candidate/release-manifest.json'), JSON.stringify(candidateManifest(record, pkg.name, text, tarball)))
      }
      save(notes)
      expect(run('node', ['scripts/agent/release-ci.mjs', 'verify', 'candidate', 'v1.0.0'])).toContain('Verified v1.0.0')
      save(Buffer.from('Unreviewed replacement'))
      const result = spawnSync('node', ['scripts/agent/release-ci.mjs', 'verify', 'candidate', 'v1.0.0'], { cwd: directory, encoding: 'utf8', windowsHide: true })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Notes differ from the tagged source')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
