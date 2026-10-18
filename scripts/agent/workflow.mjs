import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const state = join(root, '.codex-tmp/agent-workflow')
const recordPath = join(state, 'release.json')
const manualChecks = ['browser', 'desktop', 'packageContents', 'cleanInstall', 'upgrade', 'changeReview', 'readme', 'releaseNotes', 'demos']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()

function run(command, args, log) {
  const options = { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
  try {
    let result
    if (process.platform === 'win32' && command === 'npm') {
      // All npm arguments come from fixed commands or our timestamp directory.
      if (args.some(arg => /[^a-zA-Z0-9_./:@=-]/.test(arg))) throw new Error('Unsafe npm argument')
      result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], options)
    } else result = spawnSync(command, args, options)
    if (log) writeFileSync(log, `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    if (result.error || result.status !== 0) throw result.error ?? new Error(`exit ${result.status}; ${result.stderr?.slice(-1000) ?? ''}`)
    return result.stdout
  } catch (error) {
    if (log && !existsSync(log)) writeFileSync(log, error.message)
    throw new Error(`${command} failed${log ? `; see ${relative(root, log)}` : ''}: ${error.message}`)
  }
}

export function digestFiles(directory, names) {
  const hash = createHash('sha256')
  for (const name of [...new Set(names)].sort()) {
    const path = join(directory, name)
    hash.update(`${name}\0`)
    hash.update(existsSync(path) ? readFileSync(path) : '<deleted>')
    hash.update('\0')
  }
  return hash.digest('hex')
}

function sourceDigest() {
  const names = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean)
  return digestFiles(root, names.filter(name => !name.startsWith('docs/testing/releases/')))
}

function buildDigest() {
  const directory = join(root, 'lib')
  if (!existsSync(directory)) throw new Error('Missing lib: build first')
  const walk = folder => readdirSync(folder).flatMap(name => {
    const path = join(folder, name)
    return statSync(path).isDirectory() ? walk(path) : [relative(directory, path)]
  })
  return digestFiles(directory, walk(directory))
}

export function assertRelease(record, current, evidenceExists) {
  if (record.schema !== 1 || record.version !== current.version) throw new Error('Release version/schema changed')
  if (record.head !== current.head || record.sourceDigest !== current.sourceDigest || record.buildDigest !== current.buildDigest) {
    throw new Error('Candidate changed: prepare and validate again')
  }
  if (!record.package?.sha256 || record.package.sha256 !== current.packageHash) throw new Error('Package changed or missing')
  if (!record.automatic?.check || !record.automatic?.sync || !record.automatic?.pack) throw new Error('Automatic checks missing')
  for (const name of manualChecks) {
    const check = record.checks?.[name]
    if (check?.status !== 'PASS' || !check.summary?.trim() || !Array.isArray(check.evidence) || !check.evidence.length) {
      throw new Error(`${name}: PASS with summary and evidence required`)
    }
    if (check.evidence.some(path => typeof path !== 'string' || !path.trim() || !evidenceExists(path))) {
      throw new Error(`${name}: evidence file missing`)
    }
  }
  for (const name of ['redGreen', 'breakCheck', 'ci']) {
    const check = record.checks?.[name]
    if (!check?.summary?.trim() || !['PASS', 'N/A'].includes(check.status)) throw new Error(`${name}: result or N/A reason required`)
    if (check.status === 'PASS' && (!check.evidence?.length || check.evidence.some(path => !evidenceExists(path)))) {
      throw new Error(`${name}: evidence file missing`)
    }
  }
  const approval = record.editorialApproval
  if (approval?.status !== 'APPROVED' || !approval.userMessage?.trim() || !approval.evidence?.length ||
      approval.evidence.some(path => typeof path !== 'string' || !evidenceExists(path))) {
    throw new Error('Final editorial review by the user is required')
  }
  if (approval.sourceDigest !== record.sourceDigest || approval.packageSha256 !== record.package.sha256) {
    throw new Error('Editorial approval belongs to another candidate')
  }
}

function sync(log) {
  if (process.platform !== 'win32') throw new Error('Dual-environment sync needs the configured Windows host')
  // Background Electron descendants must not hold the orchestrator's output pipes open.
  const output = openSync(log, 'w')
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-File', join(root, 'scripts/agent/sync-environments.ps1')], {
      cwd: root, windowsHide: true, stdio: ['ignore', output, output], timeout: 120000,
    })
    if (result.error || result.status !== 0) throw new Error(`Environment sync failed; see ${relative(root, log)}`)
  } finally { closeSync(output) }
  return readFileSync(log, 'utf8')
}

function verify(directory) {
  mkdirSync(directory, { recursive: true })
  console.log('Running full check; output is saved in', relative(root, directory))
  run('git', ['diff', '--check'], join(directory, 'diff-check.log'))
  run('npm', ['run', 'check'], join(directory, 'check.log'))
  sync(join(directory, 'sync.log'))
  console.log('Automated checks and process refresh passed. Browser/Desktop acceptance is still required.')
}

export function main(command, argument) {
  mkdirSync(state, { recursive: true })
  const manifest = json(join(root, 'package.json'))
  if (command === 'context') {
    console.log(JSON.stringify({ root, version: manifest.version, head: git('rev-parse', 'HEAD'),
      status: git('status', '--short'),
      routes: ['AGENTS.md', 'LESSONS.md', 'docs/subsystems/README.md', 'docs/development/workflow.md'],
      commands: Object.fromEntries(Object.entries(manifest.scripts).filter(([key]) => key.startsWith('agent:'))),
    }, null, 2))
  } else if (command === 'sync') {
    console.log(sync(join(state, 'sync.log')))
  } else if (command === 'verify') {
    verify(join(state, `verify-${Date.now()}`))
  } else if (command === 'release-prepare') {
    const candidate = { head: git('rev-parse', 'HEAD'), sourceDigest: sourceDigest() }
    const directory = join(state, `release-${Date.now()}`)
    verify(directory)
    const output = run('npm', ['pack', '--json', '--pack-destination', relative(root, directory).replaceAll('\\', '/')], join(directory, 'pack.log'))
    const [pack] = JSON.parse(output)
    if (pack.name !== manifest.name || pack.version !== manifest.version) throw new Error('Packed unexpected name/version')
    // npm pack's prepare hook builds again; refresh both runtimes after that build.
    sync(join(directory, 'sync-after-pack.log'))
    if (candidate.head !== git('rev-parse', 'HEAD') || candidate.sourceDigest !== sourceDigest()) {
      throw new Error('Source changed during preparation; retry on a stable candidate')
    }
    const tarball = join(directory, pack.filename)
    const record = {
      schema: 1, createdAt: new Date().toISOString(), version: manifest.version,
      head: git('rev-parse', 'HEAD'), sourceDigest: sourceDigest(), buildDigest: buildDigest(),
      package: { path: relative(root, tarball), sha256: sha(readFileSync(tarball)), integrity: pack.integrity },
      automatic: { check: relative(root, join(directory, 'check.log')), sync: relative(root, join(directory, 'sync-after-pack.log')), pack: relative(root, join(directory, 'pack.log')) },
      checks: Object.fromEntries([...manualChecks, 'redGreen', 'breakCheck', 'ci'].map(name => [name, { status: 'NOT_RUN', summary: '', evidence: [] }])),
      editorialApproval: { status: 'PENDING', userMessage: '', evidence: [], sourceDigest: '', packageSha256: '' },
    }
    writeFileSync(join(directory, 'release.json'), JSON.stringify(record, null, 2) + '\n')
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
    console.log(`Prepared ${manifest.version}. Fill real acceptance evidence in ${relative(root, recordPath)}; nothing published.`)
  } else if (command === 'release-gate') {
    const record = json(recordPath)
    const evidenceExists = path => {
      const absolute = resolve(root, path)
      return existsSync(absolute) && statSync(absolute).isFile()
    }
    for (const path of Object.values(record.automatic ?? {})) {
      if (typeof path !== 'string' || !evidenceExists(path)) throw new Error('Automatic log missing')
    }
    assertRelease(record, { version: manifest.version, head: git('rev-parse', 'HEAD'), sourceDigest: sourceDigest(),
      buildDigest: buildDigest(), packageHash: sha(readFileSync(resolve(root, record.package.path))),
    }, evidenceExists)
    console.log(`PASS: ${record.package.path}\nSHA256: ${record.package.sha256}\nGate checks consistency, not the truth of handwritten evidence. Publish only with user authorization.`)
  } else if (command === 'retro') {
    if (argument?.startsWith('-')) throw new Error('Expected git revision range, not flags')
    const args = argument ? [argument] : ['--since=1 day ago']
    const output = git('log', ...args, '--format=fuller', '--stat', '--no-renames', '--')
    const path = join(state, `retro-${Date.now()}.txt`)
    writeFileSync(path, output)
    console.log(`${output}\nReview material: ${relative(root, path)}\nRead actual diffs before updating LESSONS.md.`)
  } else throw new Error('Commands: context, sync, verify, release-prepare, release-gate, retro [revision-range]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2], process.argv[3]) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
