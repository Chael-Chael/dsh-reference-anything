import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export async function waitForRegistry(manifest, request = fetch, pause = () => new Promise(resolve => setTimeout(resolve, 30000))) {
  for (let attempt = 0; attempt < 60; attempt++) {
    let remote
    try {
      remote = await registryVersion(manifest.name, manifest.version, request)
    } catch (error) {
      if (!(error.status === 429 || error.status >= 500 || error instanceof TypeError || error.name === 'TimeoutError')) throw error
      if (attempt === 59) throw error
    }
    if (remote) { assertRegistry(remote, manifest); return }
    if (attempt < 59) await pause()
  }
  throw new Error('Upload accepted, but published version not visible yet; re-run failed jobs to verify without uploading again')
}

export function verifyPackage(record, bytes) {
  if (record.integrity !== `sha512-${createHash('sha512').update(bytes).digest('base64')}`) {
    throw new Error('Package integrity mismatch')
  }
}

async function main(command) {
  if (!['upload', 'verify'].includes(command)) throw new Error('Expected upload or verify')
  const [record] = JSON.parse(readFileSync('pack.json', 'utf8'))
  const tarball = 'candidate.tgz'
  verifyPackage(record, readFileSync(tarball))
  const tag = record.version.includes('-') ? 'next' : 'latest'
  if (command === 'upload') {
    const existing = await registryVersion(record.name, record.version)
    if (existing) {
      assertRegistry(existing, record)
    } else {
      execFileSync('npm', ['publish', tarball, '--access', 'public', '--provenance', '--tag', tag], { stdio: 'inherit' })
    }
    console.log(`Upload accepted for ${record.name}@${record.version}; public verification is a separate job`)
    return
  }
  await waitForRegistry(record)
  const actual = execFileSync('npm', ['view', record.name, `dist-tags.${tag}`], { encoding: 'utf8' }).trim()
  if (actual !== record.version) throw new Error('dist-tag mismatch; inspect npm before changing tags')
  console.log(`Published and verified ${record.name}@${record.version}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1 })
}
