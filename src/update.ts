import { execFile as nodeExecFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { access, readFile, readdir, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFile = promisify(nodeExecFile)
export const PACKAGE_NAME = 'dsh-reference-anything'
export const NPM_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const UPDATE_TIMEOUT_MS = 5 * 60_000
const CHECK_TIMEOUT_MS = 10_000

export interface PackageUpdateStatus {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  checkedAt: number
  error?: string
}

export interface PackageUpdateResult {
  version: string
  restartRequired: boolean
}

interface UpdateManagerOptions {
  packageRoot?: string
  dshHome?: string
  fetchLatest?: (signal?: AbortSignal) => Promise<string>
  install?: (profileDir: string, version: string, signal?: AbortSignal) => Promise<void>
  afterInstall?: (profileDir: string, version: string, signal?: AbortSignal) => Promise<void>
}

/** One startup/manual-check cache and the confirmed profile-local updater. */
export class PackageUpdateManager {
  private readonly packageRoot: string
  private readonly dshHome?: string
  private readonly fetchLatest: (signal?: AbortSignal) => Promise<string>
  private readonly install: (profileDir: string, version: string, signal?: AbortSignal) => Promise<void>
  private readonly afterInstall?: (profileDir: string, version: string, signal?: AbortSignal) => Promise<void>
  private cached?: PackageUpdateStatus
  private checking?: Promise<PackageUpdateStatus>

  constructor(options: UpdateManagerOptions = {}) {
    this.packageRoot = resolve(options.packageRoot ?? PACKAGE_ROOT)
    this.dshHome = options.dshHome
    this.fetchLatest = options.fetchLatest ?? fetchLatestVersion
    this.install = options.install ?? installPackageVersion
    this.afterInstall = options.afterInstall
  }

  /** Return the startup result, waiting for it when it is still in flight. */
  status(signal?: AbortSignal): Promise<PackageUpdateStatus> {
    if (this.checking) return this.checking
    if (this.cached) return Promise.resolve(this.cached)
    return this.check(signal)
  }

  /** Force a registry read, while collapsing concurrent startup/manual clicks. */
  check(signal?: AbortSignal): Promise<PackageUpdateStatus> {
    if (this.checking) return this.checking
    const request = this.runCheck(signal).finally(() => {
      if (this.checking === request) this.checking = undefined
    })
    this.checking = request
    return request
  }

  /** Install only the exact version returned by a fresh registry check. */
  async update(signal?: AbortSignal): Promise<PackageUpdateResult> {
    const status = await this.check(signal)
    if (status.error) throw new Error(status.error)
    if (!status.updateAvailable) return { version: status.currentVersion, restartRequired: false }
    const profileDir = await findOwningProfileDir(this.packageRoot, this.dshHome)
    await this.install(profileDir, status.latestVersion, signal)
    await this.afterInstall?.(profileDir, status.latestVersion, signal)
    this.cached = {
      currentVersion: status.latestVersion,
      latestVersion: status.latestVersion,
      updateAvailable: false,
      checkedAt: Date.now(),
    }
    return { version: status.latestVersion, restartRequired: true }
  }

  private async runCheck(signal?: AbortSignal): Promise<PackageUpdateStatus> {
    const checkedAt = Date.now()
    let currentVersion = '0.0.0'
    try {
      currentVersion = await readPackageVersion(this.packageRoot)
      const latestVersion = await this.fetchLatest(signal)
      const status: PackageUpdateStatus = {
        currentVersion,
        latestVersion,
        updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
        checkedAt,
      }
      this.cached = status
      return status
    } catch (error) {
      const status: PackageUpdateStatus = {
        currentVersion,
        latestVersion: '',
        updateAvailable: false,
        checkedAt,
        error: `Unable to check npm for updates: ${error instanceof Error ? error.message : String(error)}`,
      }
      this.cached = status
      return status
    }
  }
}

export async function fetchLatestVersion(signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS)
  const response = await fetch(NPM_LATEST_URL, {
    // The registry's package metadata endpoint accepts the install-v1 media
    // type, but its `/latest` dist-tag endpoint responds 406 to that same
    // header. Request ordinary JSON because this endpoint returns one manifest.
    headers: { accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`npm registry returned HTTP ${String(response.status)}`)
  const body = await response.json() as { version?: unknown }
  if (typeof body.version !== 'string' || !isVersion(body.version)) throw new Error('npm registry returned an invalid version')
  return body.version
}

export async function readPackageVersion(packageRoot = PACKAGE_ROOT): Promise<string> {
  const manifest = await readJson(join(packageRoot, 'package.json'))
  if (typeof manifest.version !== 'string' || !isVersion(manifest.version)) throw new Error('installed package has an invalid version')
  return manifest.version
}

/** Find the profile that owns this exact installed package, including pnpm links. */
export async function findOwningProfileDir(packageRoot = PACKAGE_ROOT, configuredDshHome?: string): Promise<string> {
  const resolvedRoot = resolve(packageRoot)
  for (let cursor = resolvedRoot; dirname(cursor) !== cursor; cursor = dirname(cursor)) {
    if (await isOwningProfile(cursor, resolvedRoot)) return cursor
  }

  const dshHome = resolve(configuredDshHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const profilesRoot = join(dshHome, 'profiles')
  let entries: Dirent[] = []
  try { entries = await readdir(profilesRoot, { withFileTypes: true }) } catch { /* handled below */ }
  const matches: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const profileDir = join(profilesRoot, entry.name)
    if (await isOwningProfile(profileDir, resolvedRoot)) matches.push(profileDir)
  }
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) throw new Error('more than one DSH profile points to this installation; update it from the command line')
  throw new Error('the owning DSH profile could not be identified; update it with dsh plugin --profile <name> add dsh-reference-anything@latest')
}

export async function installPackageVersion(profileDir: string, version: string, signal?: AbortSignal): Promise<void> {
  if (!isVersion(version)) throw new Error('refusing to install an invalid package version')
  try {
    await execFile('pnpm', ['add', `${PACKAGE_NAME}@${version}`], {
      cwd: profileDir,
      encoding: 'utf8',
      timeout: UPDATE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      shell: process.platform === 'win32',
      signal,
    })
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string }
    const output = String(detail.stderr || detail.stdout || '').trim().slice(0, 2_000)
    throw new Error(output || 'pnpm could not update the DSH profile package', { cause: error })
  }
}

export function compareVersions(left: string, right: string): number {
  if (!isVersion(left) || !isVersion(right)) throw new Error('cannot compare an invalid package version')
  const [leftCore, leftPre] = left.split('-', 2)
  const [rightCore, rightPre] = right.split('-', 2)
  const a = leftCore!.split('.').map(Number)
  const b = rightCore!.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1
  }
  if (leftPre === rightPre) return 0
  if (leftPre === undefined) return 1
  if (rightPre === undefined) return -1
  return leftPre.localeCompare(rightPre, 'en', { numeric: true })
}

function isVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)
}

async function isOwningProfile(profileDir: string, packageRoot: string): Promise<boolean> {
  let manifest: Record<string, unknown>
  try { manifest = await readJson(join(profileDir, 'package.json')) } catch { return false }
  const dsh = manifest.dsh as { profile?: unknown } | undefined
  const dependencies = manifest.dependencies as Record<string, unknown> | undefined
  if (!dsh?.profile || typeof dependencies?.[PACKAGE_NAME] !== 'string') return false
  const installedRoot = join(profileDir, 'node_modules', PACKAGE_NAME)
  try {
    await access(join(installedRoot, 'package.json'))
    return await realpath(installedRoot) === await realpath(packageRoot)
  } catch { return false }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}
