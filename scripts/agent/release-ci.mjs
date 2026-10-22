import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main as workflow, root } from './workflow.mjs'

const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()

export function candidateManifest(record, name, notes, tarball) {
  if (record.package.sha256 !== hash(tarball)) throw new Error('Package changed')
  const integrity = `sha512-${hash(tarball, 'sha512', 'base64')}`
  if (record.package.integrity !== integrity) throw new Error('Package integrity mismatch')
  return {
    schema: 1, name, version: record.version, head: record.head,
    packageSha256: hash(tarball), integrity, notesSha256: hash(notes),
    // Export only the gate outcome; local evidence and user messages stay private.
    gate: 'PASS', editorialApproval: 'APPROVED',
  }
}

export function assertCandidate(manifest, pkg, head, tag, notes, tarball) {
  if (manifest.schema !== 1 || manifest.name !== pkg.name || manifest.version !== pkg.version ||
      tag !== `v${pkg.version}` || manifest.head !== head) throw new Error('Candidate identity mismatch')
  if (manifest.gate !== 'PASS' || manifest.editorialApproval !== 'APPROVED') throw new Error('Candidate approval missing')
  if (!notes.toString('utf8').trim() || manifest.notesSha256 !== hash(notes)) throw new Error('Release notes changed')
  if (manifest.packageSha256 !== hash(tarball) ||
      manifest.integrity !== `sha512-${hash(tarball, 'sha512', 'base64')}`) throw new Error('Package changed')
}

export async function registryVersion(name, version, request = fetch) {
  const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } })
  if (response.status === 404) return null
  if (!response.ok) throw Object.assign(new Error(`Registry lookup failed: HTTP ${response.status}`), { status: response.status })
  return response.json()
}

export function assertRegistry(remote, manifest) {
  if (remote.name !== manifest.name || remote.version !== manifest.version || remote.dist?.integrity !== manifest.integrity) {
    throw new Error('Published version has different identity or integrity; refusing to continue')
  }
}

export async function waitForRegistry(manifest, request = fetch, pause = () => new Promise(resolve => setTimeout(resolve, 10000))) {
  for (let attempt = 0; attempt < 30; attempt++) {
    let remote
    try {
      remote = await registryVersion(manifest.name, manifest.version, request)
    } catch (error) {
      if (!(error.status === 429 || error.status >= 500 || error instanceof TypeError || error.name === 'TimeoutError')) throw error
      if (attempt === 29) throw error
    }
    if (remote) { assertRegistry(remote, manifest); return }
    if (attempt < 29) await pause()
  }
  throw new Error('Published version not visible yet; inspect registry before retrying')
}

async function main(command, directory, tag) {
  const pkg = json(join(root, 'package.json'))
  if (command === 'export') {
    if (git('status', '--porcelain')) throw new Error('Commit the final candidate before preparing and exporting')
    workflow('release-gate')
    const record = json(join(root, '.codex-tmp/agent-workflow/release.json'))
    const notes = readFileSync(join(root, `docs/release/${pkg.version}/README.md`))
    if (!notes.toString('utf8').trim()) throw new Error('Empty release notes')
    const committedNotes = execFileSync('git', ['show', `HEAD:docs/release/${pkg.version}/README.md`], { cwd: root })
    if (!notes.equals(committedNotes)) throw new Error('Release notes must match committed bytes (use LF line endings)')
    const tarball = readFileSync(resolve(root, record.package.path))
    const manifest = candidateManifest(record, pkg.name, notes, tarball)
    const output = join(root, '.codex-tmp/agent-workflow', `ci-${pkg.version}`)
    mkdirSync(output) // Never overwrite an earlier approved handoff.
    writeFileSync(join(output, 'candidate.tgz'), tarball)
    writeFileSync(join(output, 'release-notes.md'), notes)
    writeFileSync(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    console.log(`Exported ${output}; nothing uploaded or published.`)
    return
  }
  const manifest = json(join(directory, 'release-manifest.json'))
  if (command === 'verify') {
    const notes = readFileSync(join(directory, 'release-notes.md'))
    const tarball = readFileSync(join(directory, 'candidate.tgz'))
    assertCandidate(manifest, pkg, git('rev-parse', 'HEAD'), tag, notes, tarball)
    const committedNotes = execFileSync('git', ['show', `HEAD:docs/release/${pkg.version}/README.md`], { cwd: root })
    if (!notes.equals(committedNotes)) throw new Error('Notes differ from the tagged source')
    const packed = JSON.parse(execFileSync('tar', ['-xOf', 'candidate.tgz', 'package/package.json'], { cwd: resolve(directory), encoding: 'utf8', windowsHide: true }))
    if (packed.name !== pkg.name || packed.version !== pkg.version) throw new Error('Wrong package inside tarball')
    console.log(`Verified ${tag} (${manifest.packageSha256})`)
  } else if (command === 'registry') {
    const remote = await registryVersion(manifest.name, manifest.version)
    if (remote) assertRegistry(remote, manifest)
    console.log(remote ? 'exists' : 'missing')
  } else if (command === 'confirm') {
    await waitForRegistry(manifest)
    console.log('Registry integrity verified')
  } else throw new Error('Commands: export, verify <directory> <tag>, registry <directory>, confirm <directory>')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
