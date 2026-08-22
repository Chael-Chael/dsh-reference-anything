/**
 * Which drives this package can talk to, and how a reference names one.
 *
 * Kept pure — no cordis, no `node:fs` — so the routing rules can be tested
 * without mounting a plugin or reaching a network.
 *
 * @module dsh-reference-anything/cloud-drive/registry
 */

import { ReferenceAnythingError } from '../../errors.ts'
import { OpenListDriveProvider } from './providers/openlist.ts'
import type { DriveKind, DriveProvider, DriveProviderOptions } from './types.ts'

/** Every drive the package supports. */
export const DRIVE_KINDS: readonly DriveKind[] = ['openlist']

/**
 * Constructors for the drives that actually work.
 *
 * `Partial` keeps startup validation explicit if a future declared drive has no
 * implementation.
 */
export const DRIVE_PROVIDERS: Partial<Record<DriveKind, (options?: DriveProviderOptions) => DriveProvider>> = {
  openlist: options => new OpenListDriveProvider(options),
}

/**
 * Build the provider for one drive.
 *
 * @param kind - which drive.
 * @param options - transport and clock seams passed through to the provider.
 * @returns the provider, or `undefined` when that drive has no implementation.
 */
export function providerFor(
  kind: DriveKind,
  options?: DriveProviderOptions,
): DriveProvider | undefined {
  return DRIVE_PROVIDERS[kind]?.(options)
}

/** Separator between the drive name and the drive's own file id. */
const REF_SEPARATOR = ':'

/**
 * Compose the `id` half of a reference to one drive file.
 *
 * The drive name is carried in the id rather than in the source id so that all
 * drives share one `ReferenceSource`, one grant gate, and one menu group.
 *
 * @param kind - which drive owns the file.
 * @param fileId - the provider's own opaque id.
 */
export function encodeDriveId(kind: DriveKind, fileId: string): string {
  if (kind !== 'openlist') throw new ReferenceAnythingError('cloud-drive: unsupported drive', 'REFERENCE_INVALID_URI')
  const path = normalizeOpenListPath(fileId)
  return `${kind}${REF_SEPARATOR}${Buffer.from(JSON.stringify({ v: 1, path }), 'utf8').toString('base64url')}`
}

/**
 * Split a reference id back into a drive and the provider's file id.
 *
 * Splits on the *first* separator only: a provider's id may itself contain
 * one.
 *
 * @param id - the `id` half of a `dsh-ref:` reference this source owns.
 * @throws ReferenceAnythingError when the id names no known drive.
 */
export function decodeDriveId(id: string): { kind: DriveKind, fileId: string } {
  if (id.startsWith('baidu:') || id.startsWith('pds:')) {
    throw new ReferenceAnythingError(
      'cloud-drive: 旧版百度网盘/PDS 引用不能再读取；请在 OpenList 中重新选择该文件以迁移引用。',
      'REFERENCE_INVALID_URI',
    )
  }
  const cut = id.indexOf(REF_SEPARATOR)
  const kind = cut === -1 ? '' : id.slice(0, cut)
  const payload = cut === -1 ? '' : id.slice(cut + 1)
  if (payload === '' || !isDriveKind(kind)) {
    throw new ReferenceAnythingError(`cloud-drive: malformed reference id`, 'REFERENCE_INVALID_URI')
  }
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error('not base64url')
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!isOpenListRef(decoded)) throw new Error('invalid shape')
    return { kind, fileId: normalizeOpenListPath(decoded.path) }
  } catch {
    throw new ReferenceAnythingError('cloud-drive: malformed OpenList reference id', 'REFERENCE_INVALID_URI')
  }
}

/** Whether a string is one of the declared drive names. */
export function isDriveKind(value: string): value is DriveKind {
  return (DRIVE_KINDS as readonly string[]).includes(value)
}

/** Normalize absolute OpenList paths and reject traversal rather than resolving it. */
export function normalizeOpenListPath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || !value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new ReferenceAnythingError('cloud-drive: OpenList path must be absolute', 'REFERENCE_INVALID_URI')
  }
  const parts = value.split('/')
  if (parts.some(part => part === '..')) {
    throw new ReferenceAnythingError('cloud-drive: OpenList path traversal is not allowed', 'REFERENCE_INVALID_URI')
  }
  const clean = parts.filter(part => part !== '' && part !== '.')
  return clean.length === 0 ? '/' : `/${clean.join('/')}`
}

function isOpenListRef(value: unknown): value is { v: 1, path: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.v === 1 && typeof row.path === 'string' && Object.keys(row).length === 2
}
