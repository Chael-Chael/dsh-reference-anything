import { constants } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { ReferenceAnythingError } from './errors.ts'

/**
 * Unlike `path.isAbsolute`, this excludes Windows paths rooted on the current
 * drive (`\foo`) and drive-relative paths (`C:foo`). Those forms can silently
 * resolve somewhere other than the directory displayed in Settings.
 */
export function isFullyQualifiedDownloadDirectory(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return value.startsWith('/')
  // Device and NT namespaces bypass ordinary filesystem parsing and can name
  // objects outside the selected volume/share boundary. This feature only
  // accepts conventional DOS drive paths and UNC shares.
  if (/^\\\\[?.][\\/]/.test(value)) return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  return /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/.test(value)
}

/** Append an mkdtemp prefix without lexically resolving symlinks or `..`. */
export function appendDownloadDirectoryPrefix(
  directory: string,
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!isFullyQualifiedDownloadDirectory(directory, platform) || directory.includes('\0')) {
    throw new ReferenceAnythingError('Cloud-drive download directory is invalid', 'REFERENCE_INVALID_CONFIG')
  }
  if (prefix === '' || prefix === '.' || prefix === '..' || prefix.includes('\0') || /[\\/]/.test(prefix)) {
    throw new ReferenceAnythingError('Cloud-drive temporary-directory prefix is invalid', 'REFERENCE_INVALID_CONFIG')
  }
  const hasSeparator = platform === 'win32' ? /[\\/]$/.test(directory) : directory.endsWith('/')
  return `${directory}${hasSeparator ? '' : platform === 'win32' ? '\\' : '/'}${prefix}`
}

export interface DownloadDirectoryValidationOptions {
  platform?: NodeJS.Platform
  lstatPath?: (path: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>
  accessPath?: (path: string, mode: number) => Promise<void>
}

/** Validate the user-selected base without changing its filesystem semantics. */
export async function validateDownloadDirectory(
  value: string,
  options: DownloadDirectoryValidationOptions = {},
): Promise<string> {
  if (value === '') return ''
  const platform = options.platform ?? process.platform
  if (value.includes('\0') || !isFullyQualifiedDownloadDirectory(value, platform)) {
    throw new ReferenceAnythingError(
      'Cloud-drive download directory must be a fully-qualified absolute path',
      'REFERENCE_INVALID_CONFIG',
    )
  }

  const lstatPath = options.lstatPath ?? (async (path: string) => lstat(path))
  const accessPath = options.accessPath ?? (async (path: string, mode: number) => access(path, mode))
  try {
    const metadata = await lstatPath(value)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ReferenceAnythingError(
        'Cloud-drive download directory must name a real directory, not a symbolic link',
        'REFERENCE_INVALID_CONFIG',
      )
    }
    await accessPath(value, constants.W_OK | constants.X_OK)
  } catch (cause) {
    if (cause instanceof ReferenceAnythingError) throw cause
    throw new ReferenceAnythingError(
      'Cloud-drive download directory does not exist or is not writable',
      'REFERENCE_INVALID_CONFIG',
      { cause },
    )
  }
  return value
}
