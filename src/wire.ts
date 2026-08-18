/** JSON-compatible schema shared by the Host Remote and browser client. */
import { z } from 'zod'

export const providerSchema = z.enum(['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi'])
export type ChatProvider = z.infer<typeof providerSchema>

export const pickerSourceSchema = z.enum(['commands', 'skills', 'files', 'sessions', 'conversations'])
export type PickerSource = z.infer<typeof pickerSourceSchema>

const pickerSourceSettingsSchema = z.object({
  enabled: z.boolean(),
  order: z.number().int().min(0).max(100),
  limit: z.number().int().min(1).max(50),
})
export type PickerSourceSettings = z.infer<typeof pickerSourceSettingsSchema>

export const pickerSettingsSchema = z.object({
  commands: pickerSourceSettingsSchema,
  skills: pickerSourceSettingsSchema,
  files: pickerSourceSettingsSchema,
  sessions: pickerSourceSettingsSchema,
  conversations: pickerSourceSettingsSchema,
})
export type PickerSettings = z.infer<typeof pickerSettingsSchema>

/** Defaults preserve the pre-settings @ menu ordering and result counts. */
export function defaultPickerSettings(): PickerSettings {
  return {
    commands: { enabled: true, order: 0, limit: 12 },
    skills: { enabled: true, order: 5, limit: 12 },
    files: { enabled: true, order: 10, limit: 12 },
    sessions: { enabled: true, order: 20, limit: 12 },
    conversations: { enabled: true, order: 30, limit: 12 },
  }
}

export const settingsRecordSchema = z.object({
  opencliPath: z.string(),
  profile: z.string(),
  detailConcurrency: z.number().int().min(1).max(8),
  autoSync: z.boolean().default(false),
  autoSyncMinutes: z.number().int().min(15).max(1440).default(60),
  historyMode: z.enum(['metadata-only', 'offline-mirror']).default('metadata-only'),
  // Optional keeps existing on-disk settings forward-compatible. The client
  // uses defaultPickerSettings() until the user saves the General section.
  picker: pickerSettingsSchema.optional(),
})
export type SettingsRecord = z.infer<typeof settingsRecordSchema>
