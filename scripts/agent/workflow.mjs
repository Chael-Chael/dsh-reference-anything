import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const state = join(root, '.codex-tmp/agent-workflow')
const recordPath = join(state, 'release.json')
const lastVerifyPath = join(state, 'last-verify.json')
// Every release proves these; the acceptance report holds the evidence, the record only points at it.
const manualChecks = ['browser', 'desktop', 'packageContents', 'cleanInstall', 'changeReview', 'readme', 'releaseNotes', 'demos']
// Needed only when the change calls for them: PASS, or N/A with the reason.
const conditionalChecks = ['upgrade', 'redGreen', 'breakCheck', 'ci']
const SYNC_TARGETS = ['web', 'desktop', 'all']
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

/** Text the user reviews: both READMEs, the release folder (notes, feature card, demos) and README images. */
export function copyFiles(names, version) {
  return names.filter(name => name === 'README.md' || name === 'README_zh-CN.md' || name.startsWith(`docs/release/${version}/`) || name.startsWith('images/'))
}

function copyDigest(version) {
  const names = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean)
  return digestFiles(root, copyFiles(names, version))
}

/**
 * Check the release record against the current candidate. `report` is the
 * acceptance report's text: every check must name an item the report holds.
 */
export function assertRelease(record, current, report) {
  if (record.schema !== 2 || record.version !== current.version) throw new Error('Release version/schema changed')
  if (record.head !== current.head || record.sourceDigest !== current.sourceDigest || record.buildDigest !== current.buildDigest) {
    throw new Error('Candidate changed: prepare and validate again')
  }
  if (!record.package?.sha256 || record.package.sha256 !== current.packageHash) throw new Error('Package changed or missing')
  if (!record.automatic?.check || !record.automatic?.sync || !record.automatic?.pack) throw new Error('Automatic checks missing')
  if (!record.report || report === undefined) throw new Error('Acceptance report missing')
  const referenced = (name, check) => {
    if (!check.ref?.trim()) throw new Error(`${name}: report item reference required`)
    if (!report.includes(check.ref)) throw new Error(`${name}: report has no item ${check.ref}`)
  }
  for (const name of manualChecks) {
    const check = record.checks?.[name]
    if (check?.status !== 'PASS') throw new Error(`${name}: PASS required`)
    referenced(name, check)
  }
  for (const name of conditionalChecks) {
    const check = record.checks?.[name]
    if (check?.status === 'PASS') referenced(name, check)
    else if (check?.status !== 'N/A' || !check.reason?.trim()) throw new Error(`${name}: PASS, or N/A with a reason, required`)
  }
  const approval = record.editorialApproval
  if (approval?.status !== 'APPROVED' || !approval.userMessage?.trim() || !approval.ref?.trim() || !report.includes(approval.ref)) {
    throw new Error('Final editorial review by the user is required')
  }
  // Approval covers the reviewed text only: code changes after it need no new review.
  if (approval.copyDigest !== current.copyDigest) throw new Error('Editorial approval belongs to other copy: review again')
}

function sync(log, targets = 'web') {
  if (!SYNC_TARGETS.includes(targets)) throw new Error(`Sync targets: ${SYNC_TARGETS.join(', ')}`)
  if (process.platform !== 'win32') throw new Error('Dual-environment sync needs the configured Windows host')
  // Background Electron descendants must not hold the orchestrator's output pipes open.
  const output = openSync(log, 'w')
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-File', join(root, 'scripts/agent/sync-environments.ps1'), '-Targets', targets], {
      cwd: root, windowsHide: true, stdio: ['ignore', output, output], timeout: 120000,
    })
    if (result.error || result.status !== 0) throw new Error(`Environment sync failed; see ${relative(root, log)}`)
  } finally { closeSync(output) }
  return readFileSync(log, 'utf8')
}

/** The candidate a check ran on; any edit after it makes the check stale. */
const candidate = () => ({ head: git('rev-parse', 'HEAD'), sourceDigest: sourceDigest() })

function check(directory) {
  mkdirSync(directory, { recursive: true })
  console.log('Running full check; output is saved in', relative(root, directory))
  const before = candidate()
  run('git', ['diff', '--check'], join(directory, 'diff-check.log'))
  run('npm', ['run', 'check'], join(directory, 'check.log'))
  const after = { ...candidate(), buildDigest: buildDigest(), check: relative(root, join(directory, 'check.log')) }
  if (before.head !== after.head || before.sourceDigest !== after.sourceDigest) throw new Error('Source changed during the check; run it again')
  writeFileSync(lastVerifyPath, JSON.stringify(after, null, 2) + '\n')
  return after
}

/** The last passing check, if it ran on exactly this candidate and build. */
export function reusableCheck(last, current) {
  return last && last.head === current.head && last.sourceDigest === current.sourceDigest && last.buildDigest === current.buildDigest ? last : undefined
}

function verify(directory, targets) {
  check(directory)
  sync(join(directory, 'sync.log'), targets)
  console.log(`Automated checks passed; refreshed: ${targets}. Real UI acceptance is still required.`)
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
    console.log(sync(join(state, 'sync.log'), argument ?? 'web'))
  } else if (command === 'verify') {
    verify(join(state, `verify-${Date.now()}`), argument ?? 'web')
  } else if (command === 'release-prepare') {
    const directory = join(state, `release-${Date.now()}`)
    mkdirSync(directory, { recursive: true })
    const current = { ...candidate(), buildDigest: existsSync(join(root, 'lib')) ? buildDigest() : '' }
    const last = reusableCheck(existsSync(lastVerifyPath) ? json(lastVerifyPath) : undefined, current)
    if (last) console.log('Reusing the passing check of this exact candidate:', last.check)
    const checked = last ?? check(directory)
    // Pack the build the check produced; the pack hooks would only build it again.
    const output = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', relative(root, directory).replaceAll('\\', '/')], join(directory, 'pack.log'))
    const [pack] = JSON.parse(output)
    if (pack.name !== manifest.name || pack.version !== manifest.version) throw new Error('Packed unexpected name/version')
    sync(join(directory, 'sync.log'), 'all')
    const after = { ...candidate(), buildDigest: buildDigest() }
    if (!reusableCheck(checked, after)) throw new Error('Source or build changed during preparation; retry on a stable candidate')
    const tarball = join(directory, pack.filename)
    const copy = copyDigest(manifest.version)
    // A review of unchanged copy carries over to the new candidate.
    const previous = existsSync(recordPath) ? json(recordPath) : undefined
    const approval = previous?.editorialApproval?.status === 'APPROVED' && previous.editorialApproval.copyDigest === copy
      ? previous.editorialApproval : { status: 'PENDING', userMessage: '', ref: '', copyDigest: '' }
    const record = {
      schema: 2, createdAt: new Date().toISOString(), version: manifest.version,
      head: after.head, sourceDigest: after.sourceDigest, buildDigest: after.buildDigest, copyDigest: copy,
      package: { path: relative(root, tarball), sha256: sha(readFileSync(tarball)), integrity: pack.integrity },
      automatic: { check: checked.check, sync: relative(root, join(directory, 'sync.log')), pack: relative(root, join(directory, 'pack.log')) },
      report: `docs/testing/releases/${manifest.version}-acceptance-report.md`,
      checks: Object.fromEntries([
        ...manualChecks.map(name => [name, { status: 'NOT_RUN', ref: '' }]),
        ...conditionalChecks.map(name => [name, { status: 'NOT_RUN', ref: '', reason: '' }]),
      ]),
      editorialApproval: approval,
    }
    writeFileSync(join(directory, 'release.json'), JSON.stringify(record, null, 2) + '\n')
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
    console.log(`Prepared ${manifest.version}${approval.status === 'APPROVED' ? ' (copy unchanged: editorial approval kept)' : ''}. Record results in ${record.report} and point ${relative(root, recordPath)} at its items; nothing published.`)
  } else if (command === 'release-gate') {
    const record = json(recordPath)
    const isFile = path => typeof path === 'string' && existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile()
    for (const path of Object.values(record.automatic ?? {})) if (!isFile(path)) throw new Error('Automatic log missing')
    const report = isFile(record.report) ? readFileSync(resolve(root, record.report), 'utf8') : undefined
    assertRelease(record, { version: manifest.version, head: git('rev-parse', 'HEAD'), sourceDigest: sourceDigest(),
      buildDigest: buildDigest(), packageHash: sha(readFileSync(resolve(root, record.package.path))), copyDigest: copyDigest(manifest.version),
    }, report)
    console.log(`PASS: ${record.package.path}\nSHA256: ${record.package.sha256}\nGate checks consistency, not the truth of handwritten evidence. Publish only with user authorization.`)
  } else if (command === 'retro') {
    if (argument?.startsWith('-')) throw new Error('Expected git revision range, not flags')
    const args = argument ? [argument] : ['--since=1 day ago']
    const output = git('log', ...args, '--format=fuller', '--stat', '--no-renames', '--')
    const path = join(state, `retro-${Date.now()}.txt`)
    writeFileSync(path, output)
    console.log(`${output}\nReview material: ${relative(root, path)}\nRead actual diffs before updating LESSONS.md.`)
  } else throw new Error('Commands: context, sync [web|desktop|all], verify [web|desktop|all], release-prepare, release-gate, retro [revision-range]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2], process.argv[3]) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
