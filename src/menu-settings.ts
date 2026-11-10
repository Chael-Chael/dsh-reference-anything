/** `@` menu layout settings owned by the core menu. Shared by Host and client. */
import { defaultPickerSettings, pickerSettingsSchema, type PickerSettings } from './wire.ts'

export const MENU_SETTINGS_ID = 'menu'

export const menuSettingsSchema = pickerSettingsSchema
export type MenuSettings = PickerSettings
export const defaultMenuSettings = defaultPickerSettings

export function menuSettingsFromLegacy(legacy: Readonly<Record<string, unknown>>): MenuSettings | undefined {
  if (legacy.picker === undefined) return undefined
  const parsed = pickerSettingsSchema.safeParse(legacy.picker)
  return parsed.success ? parsed.data : undefined
}
