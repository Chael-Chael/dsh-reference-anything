import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareVersions, fetchLatestVersion, findOwningProfileDir, NPM_LATEST_URL, PackageUpdateManager } from '../src/update.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function installedProfile(version = '0.2.1'): Promise<{ packageRoot: string; profileDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reference-update-'))
  temporaryRoots.push(root)
  const profileDir = join(root, 'profiles', 'web')
  const packageRoot = join(profileDir, 'node_modules', 'dsh-reference-anything')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-reference-anything': `^${version}` },
    dsh: { profile: true },
  }))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-reference-anything', version }))
  return { packageRoot, profileDir }
}

describe('package update manager', () => {
  it('requests ordinary JSON from the npm latest endpoint', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ version: '0.2.2' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', request)

    await expect(fetchLatestVersion()).resolves.toBe('0.2.2')
    expect(request).toHaveBeenCalledWith(NPM_LATEST_URL, expect.objectContaining({
      headers: { accept: 'application/json' },
    }))
  })

  it('compares stable and prerelease versions', () => {
    expect(compareVersions('0.2.2', '0.2.1')).toBe(1)
    expect(compareVersions('0.2.1', '0.2.1')).toBe(0)
    expect(compareVersions('0.2.1-beta.2', '0.2.1-beta.10')).toBe(-1)
    expect(compareVersions('0.2.1', '0.2.1-beta.10')).toBe(1)
  })

  it('finds the DSH profile that owns the exact installed package', async () => {
    const { packageRoot, profileDir } = await installedProfile()
    await expect(findOwningProfileDir(packageRoot)).resolves.toBe(profileDir)
  })

  it('checks on demand, caches status, then installs only a freshly checked exact version', async () => {
    const { packageRoot, profileDir } = await installedProfile()
    const fetchLatest = vi.fn(async () => '0.2.2')
    const install = vi.fn(async () => {})
    const manager = new PackageUpdateManager({ packageRoot, fetchLatest, install })

    await expect(manager.check()).resolves.toMatchObject({
      currentVersion: '0.2.1', latestVersion: '0.2.2', updateAvailable: true,
    })
    await manager.status()
    expect(fetchLatest).toHaveBeenCalledTimes(1)

    await expect(manager.update()).resolves.toEqual({ version: '0.2.2', restartRequired: true })
    expect(fetchLatest).toHaveBeenCalledTimes(2)
    expect(install).toHaveBeenCalledWith(profileDir, '0.2.2', undefined)
    await expect(manager.status()).resolves.toMatchObject({
      currentVersion: '0.2.2', latestVersion: '0.2.2', updateAvailable: false,
    })
  })

  it('does not invoke pnpm when npm reports the installed version', async () => {
    const { packageRoot } = await installedProfile()
    const install = vi.fn(async () => {})
    const manager = new PackageUpdateManager({ packageRoot, fetchLatest: async () => '0.2.1', install })

    await expect(manager.update()).resolves.toEqual({ version: '0.2.1', restartRequired: false })
    expect(install).not.toHaveBeenCalled()
  })

  it('returns a displayable status when the registry is unavailable', async () => {
    const { packageRoot } = await installedProfile()
    const manager = new PackageUpdateManager({ packageRoot, fetchLatest: async () => { throw new Error('offline') } })

    await expect(manager.check()).resolves.toMatchObject({
      currentVersion: '0.2.1', latestVersion: '', updateAvailable: false,
      error: expect.stringContaining('offline'),
    })
  })
})
