/**
 * Which drives this package can talk to, and how a reference names one.
 *
 * Kept pure — no cordis, no `node:fs` — so the routing rules can be tested
 * without mounting a plugin or reaching a network.
 *
 * @module dsh-reference-anything/cloud-drive/registry
 */

import { ReferenceAnythingError } from '../../errors.ts'
import { BaiduDriveProvider } from './providers/baidu.ts'
import { PdsDriveProvider } from './providers/pds.ts'
import type { DriveKind, DriveProvider, DriveProviderOptions } from './types.ts'

/** Every drive named in the design, whether or not it is implemented yet. */
export const DRIVE_KINDS: readonly DriveKind[] = ['baidu', 'pds']

/**
 * Constructors for the drives that actually work.
 *
 * Still `Partial`, and deliberately so: {@link DRIVE_KINDS} is the reference
 * vocabulary, which must keep naming a drive whose transport is removed or not
 * yet written so that stored references and saved settings survive. Configuring
 * a kind that is absent here produces a clear startup error rather than a menu
 * group that silently returns nothing.
 */
export const DRIVE_PROVIDERS: Partial<Record<DriveKind, (options?: DriveProviderOptions) => DriveProvider>> = {
  baidu: options => new BaiduDriveProvider(options),
  pds: options => new PdsDriveProvider(options),
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
  return `${kind}${REF_SEPARATOR}${fileId}`
}

/**
 * Split a reference id back into a drive and the provider's file id.
 *
 * Splits on the *first* separator only: a provider's id may itself contain
 * one, and PDS's composite `driveId/fileId` almost certainly will.
 *
 * @param id - the `id` half of a `dsh-ref:` reference this source owns.
 * @throws ReferenceAnythingError when the id names no known drive.
 */
export function decodeDriveId(id: string): { kind: DriveKind, fileId: string } {
  const cut = id.indexOf(REF_SEPARATOR)
  const kind = cut === -1 ? '' : id.slice(0, cut)
  const fileId = cut === -1 ? '' : id.slice(cut + 1)
  if (fileId === '' || !isDriveKind(kind)) {
    throw new ReferenceAnythingError(`cloud-drive: malformed reference id`, 'REFERENCE_INVALID_URI')
  }
  return { kind, fileId }
}

/** Whether a string is one of the declared drive names. */
export function isDriveKind(value: string): value is DriveKind {
  return (DRIVE_KINDS as readonly string[]).includes(value)
}
