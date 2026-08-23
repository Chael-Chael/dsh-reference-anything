import { constants } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendDownloadDirectoryPrefix, isFullyQualifiedDownloadDirectory, validateDownloadDirectory } from '../src/download-directory.ts'
import WebChatHistoryService from '../src/sources/web-chat/index.ts'
import { settingsRecordSchema, type SettingsRecord } from '../src/wire.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-download-directory-test-'))
  roots.push(root)
  return root
}

function settings(overrides: Partial<SettingsRecord> = {}): SettingsRecord {
  return settingsRecordSchema.parse({
    opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false,
    autoSyncMinutes: 60, historyMode: 'metadata-only', ...overrides,
  })
}

function serviceWith(current: SettingsRecord) {
  let persisted = current
  const setSettings = vi.fn(async (value: SettingsRecord) => { persisted = value })
  const service = Object.create(WebChatHistoryService.prototype) as WebChatHistoryService
  Object.defineProperty(service, 'storeValue', { value: {
    get settings() { return persisted },
    setSettings,
    clearMirrorContent: vi.fn(async () => {}),
  }, configurable: true })
  const armAutoSync = vi.fn()
  ;(service as unknown as { armAutoSync(): void }).armAutoSync = armAutoSync
  return { service, setSettings, armAutoSync, persisted: () => persisted }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('cloud-drive download directory validation', () => {
  it('treats slash-rooted paths as absolute only on POSIX hosts', () => {
    expect(isFullyQualifiedDownloadDirectory('/downloads', 'linux')).toBe(true)
    expect(isFullyQualifiedDownloadDirectory('/downloads', 'darwin')).toBe(true)
    expect(isFullyQualifiedDownloadDirectory('/rooted-on-current-drive', 'win32')).toBe(false)
  })

  it('accepts only drive-qualified or complete UNC paths on Windows', () => {
    expect(isFullyQualifiedDownloadDirectory('C:\\downloads', 'win32')).toBe(true)
    expect(isFullyQualifiedDownloadDirectory('C:downloads', 'win32')).toBe(false)
    expect(isFullyQualifiedDownloadDirectory('\\\\server\\share', 'win32')).toBe(true)
    expect(isFullyQualifiedDownloadDirectory('\\\\server', 'win32')).toBe(false)
  })

  it.each([
    '\\\\.\\C:\\downloads',
    '\\\\.\\pipe\\name',
    '\\\\?\\C:\\downloads',
    '\\\\?\\UNC\\server\\share',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1',
  ])('rejects a Windows device or NT namespace: %s', value => {
    expect(isFullyQualifiedDownloadDirectory(value, 'win32')).toBe(false)
  })

  it('preserves legal POSIX spaces instead of changing which directory was selected', async () => {
    const selected = '/tmp/ leading-and-trailing '
    const lstatPath = vi.fn(async () => ({ isDirectory: () => true, isSymbolicLink: () => false }))
    const accessPath = vi.fn(async () => {})

    await expect(validateDownloadDirectory(selected, { platform: 'linux', lstatPath, accessPath }))
      .resolves.toBe(selected)
    expect(lstatPath).toHaveBeenCalledWith(selected)
    expect(accessPath).toHaveBeenCalledWith(selected, constants.W_OK | constants.X_OK)
    expect(isFullyQualifiedDownloadDirectory(' /tmp/leading-space-before-root', 'linux')).toBe(false)
  })

  it('validates and returns an existing fully-qualified directory exactly as selected', async () => {
    const root = await temporaryRoot()
    const input = `${root}${sep}.${sep}`

    await expect(validateDownloadDirectory(input)).resolves.toBe(input)
  })

  it('does not lexically redirect a POSIX symlink/../downloads selection', async () => {
    const selected = '/srv/reference-root/link/../downloads'
    const lstatPath = vi.fn(async () => ({ isDirectory: () => true, isSymbolicLink: () => false }))
    const accessPath = vi.fn(async () => {})

    await expect(validateDownloadDirectory(selected, { platform: 'linux', lstatPath, accessPath }))
      .resolves.toBe(selected)
    expect(lstatPath).toHaveBeenCalledWith(selected)
    expect(accessPath).toHaveBeenCalledWith(selected, constants.W_OK | constants.X_OK)
    expect(appendDownloadDirectoryPrefix(selected, 'dsh-reference-drive-', 'linux'))
      .toBe('/srv/reference-root/link/../downloads/dsh-reference-drive-')
  })

  it.each(['../escape', 'nested/prefix', 'nested\\prefix', '', '.'])
  ('rejects an unsafe temporary-directory prefix: %s', prefix => {
    expect(() => appendDownloadDirectoryPrefix('/selected', prefix, 'linux'))
      .toThrow(/prefix/i)
  })

  it('accepts only the exact empty value as the system-temp reset', async () => {
    await expect(validateDownloadDirectory('')).resolves.toBe('')
    await expect(validateDownloadDirectory('   ')).rejects.toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
  })

  it.each([
    'relative/path',
    'C:drive-relative',
    '\\rooted-on-current-drive',
    '\\\\server',
    '\\\\server\\',
  ])('rejects a path that is not fully qualified: %s', async value => {
    await expect(validateDownloadDirectory(value)).rejects.toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
  })

  it('rejects a missing directory', async () => {
    const root = await temporaryRoot()
    await expect(validateDownloadDirectory(join(root, 'missing')))
      .rejects.toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
  })

  it('rejects an ordinary file', async () => {
    const root = await temporaryRoot()
    const file = join(root, 'ordinary-file')
    await writeFile(file, 'not a directory')

    await expect(validateDownloadDirectory(file))
      .rejects.toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
  })

  it('requires both write and child-creation access', async () => {
    const accessPath = vi.fn(async (_path: string, mode: number) => {
      expect(mode).toBe(constants.W_OK | constants.X_OK)
      throw new Error('not searchable')
    })

    await expect(validateDownloadDirectory('/selected', {
      platform: 'linux',
      lstatPath: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      accessPath,
    })).rejects.toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
    expect(accessPath).toHaveBeenCalledOnce()
  })

  it('rejects a final directory that is itself a symbolic link or junction', async () => {
    const lstatPath = vi.fn(async () => ({ isDirectory: () => true, isSymbolicLink: () => true }))
    const accessPath = vi.fn(async () => {})

    await expect(validateDownloadDirectory('/selected-link', {
      platform: 'linux', lstatPath, accessPath,
    })).rejects.toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
    expect(lstatPath).toHaveBeenCalledWith('/selected-link')
    expect(accessPath).not.toHaveBeenCalled()
  })
})

describe('download directory settings boundary', () => {
  it('validates a changed directory before persisting any settings', async () => {
    const root = await temporaryRoot()
    const current = settings()
    const { service, setSettings } = serviceWith(current)

    await expect(service.updateSettings({ ...current, cloudDriveDownloadDirectory: join(root, 'missing') }))
      .rejects.toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('persists a changed valid directory exactly as selected', async () => {
    const root = await temporaryRoot()
    const current = settings()
    const { service, setSettings } = serviceWith(current)
    const input = `${root}${sep}.${sep}`

    const saved = await service.updateSettings({ ...current, cloudDriveDownloadDirectory: input })

    expect(saved.cloudDriveDownloadDirectory).toBe(input)
    expect(setSettings).toHaveBeenCalledWith(saved)
  })

  it('does not trim a changed directory before validating or persisting it', async () => {
    const root = await temporaryRoot()
    const current = settings()
    const { service, setSettings } = serviceWith(current)

    await expect(service.updateSettings({ ...current, cloudDriveDownloadDirectory: ` ${root}` }))
      .rejects.toMatchObject({ code: 'REFERENCE_INVALID_CONFIG' })
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('does not revalidate an unchanged directory during an unrelated save', async () => {
    const root = await temporaryRoot()
    const unavailable = join(root, 'later-removed')
    const current = settings({ cloudDriveDownloadDirectory: unavailable })
    const { service, setSettings } = serviceWith(current)

    const saved = await service.updateSettings({ ...current, autoSync: true })

    expect(saved).toMatchObject({ cloudDriveDownloadDirectory: unavailable, autoSync: true })
    expect(setSettings).toHaveBeenCalledWith(saved)
  })

  it('merges concurrent full-record saves so unrelated changes are both preserved', async () => {
    const current = settings()
    const { service, setSettings, persisted } = serviceWith(current)
    const validationStarted = deferred()
    const releaseValidation = deferred()
    const firstDirectory = 'C:\\first-download-directory'
    const validator = vi.fn(async (value: string) => {
      if (value === firstDirectory) {
        validationStarted.resolve()
        await releaseValidation.promise
      }
      return value
    })
    ;(service as unknown as { validateDownloadDirectoryValue(value: string): Promise<string> })
      .validateDownloadDirectoryValue = validator

    const first = service.updateSettings({ ...current, cloudDriveDownloadDirectory: firstDirectory })
    void first.catch(() => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(validator).toHaveBeenCalledWith(firstDirectory)
    await validationStarted.promise
    const second = service.updateSettings({ ...current, cloudDriveDownloadDirectory: '', autoSync: true })

    expect(setSettings).not.toHaveBeenCalled()
    releaseValidation.resolve()
    await Promise.all([first, second])

    expect(setSettings.mock.calls.map(([value]) => value.cloudDriveDownloadDirectory)).toEqual([firstDirectory, firstDirectory])
    expect(persisted()).toMatchObject({ cloudDriveDownloadDirectory: firstDirectory, autoSync: true })
  })

  it('lets the later request win when both concurrent saves change the same field', async () => {
    const current = settings()
    const { service, persisted } = serviceWith(current)
    const validationStarted = deferred()
    const releaseValidation = deferred()
    const firstDirectory = 'C:\\first-download-directory'
    const secondDirectory = 'C:\\second-download-directory'
    const validator = vi.fn(async (value: string) => {
      if (value === firstDirectory) {
        validationStarted.resolve()
        await releaseValidation.promise
      }
      return value
    })
    ;(service as unknown as { validateDownloadDirectoryValue(value: string): Promise<string> })
      .validateDownloadDirectoryValue = validator

    const first = service.updateSettings({ ...current, cloudDriveDownloadDirectory: firstDirectory })
    await validationStarted.promise
    const second = service.updateSettings({ ...current, cloudDriveDownloadDirectory: secondDirectory })
    releaseValidation.resolve()
    await Promise.all([first, second])

    expect(persisted().cloudDriveDownloadDirectory).toBe(secondDirectory)
  })

  it('preserves a direct store update made while directory validation is paused', async () => {
    const current = settings()
    const { service, setSettings, persisted } = serviceWith(current)
    const validationStarted = deferred()
    const releaseValidation = deferred()
    const firstDirectory = 'C:\\first-download-directory'
    const validator = vi.fn(async (value: string) => {
      validationStarted.resolve()
      await releaseValidation.promise
      return value
    })
    ;(service as unknown as { validateDownloadDirectoryValue(value: string): Promise<string> })
      .validateDownloadDirectoryValue = validator

    const directorySave = service.updateSettings({ ...current, cloudDriveDownloadDirectory: firstDirectory })
    await validationStarted.promise
    await setSettings({ ...current, opencliPath: 'newly-installed-opencli' })
    releaseValidation.resolve()
    await directorySave

    expect(persisted()).toMatchObject({
      cloudDriveDownloadDirectory: firstDirectory,
      opencliPath: 'newly-installed-opencli',
    })
  })

  it('continues the settings queue after a validation rejection', async () => {
    const current = settings()
    const { service, setSettings, persisted } = serviceWith(current)
    const firstDirectory = 'C:\\invalid-download-directory'
    const validator = vi.fn(async (value: string) => {
      if (value === firstDirectory) throw new Error('invalid for test')
      return value
    })
    ;(service as unknown as { validateDownloadDirectoryValue(value: string): Promise<string> })
      .validateDownloadDirectoryValue = validator

    const first = service.updateSettings({ ...current, cloudDriveDownloadDirectory: firstDirectory })
    const second = service.updateSettings({ ...current, autoSync: true })

    await expect(first).rejects.toThrow('invalid for test')
    await expect(second).resolves.toMatchObject({ autoSync: true })
    expect(setSettings).toHaveBeenCalledOnce()
    expect(persisted().autoSync).toBe(true)
  })
})
