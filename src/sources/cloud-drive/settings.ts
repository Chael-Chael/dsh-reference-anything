/** User settings owned by the cloud-drive source. Shared by Host and client. */
import { z } from 'zod'

export const CLOUD_DRIVE_SETTINGS_ID = 'cloud-drive'

export const cloudDriveSettingsSchema = z.object({
  /** Empty keeps the system temporary directory. */
  downloadDirectory: z.string().max(4096).default(''),
  /**
   * Mount paths the source may list and read. Undefined means every enabled
   * mount; an explicit empty array means none.
   */
  enabledMounts: z.array(z.string().startsWith('/')).optional(),
})
export type CloudDriveSettings = z.infer<typeof cloudDriveSettingsSchema>

export function defaultCloudDriveSettings(): CloudDriveSettings { return { downloadDirectory: '' } }

export function cloudDriveSettingsFromLegacy(legacy: Readonly<Record<string, unknown>>): CloudDriveSettings | undefined {
  const parsed = cloudDriveSettingsSchema.safeParse({
    downloadDirectory: legacy.cloudDriveDownloadDirectory ?? '',
    ...(legacy.enabledDriveMounts === undefined ? {} : { enabledMounts: legacy.enabledDriveMounts }),
  })
  return parsed.success ? parsed.data : undefined
}

/** Whether a display path lies inside one of the enabled mounts. */
export function mountAllowed(path: string, enabled: readonly string[] | undefined): boolean {
  if (enabled === undefined) return true
  return enabled.some(mount => mount === '/' || path === mount || path.startsWith(`${mount}/`))
}
