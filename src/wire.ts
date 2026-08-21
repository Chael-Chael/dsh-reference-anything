/** JSON-compatible schema shared by the Host Remote and browser client. */
import { z } from 'zod'

export const providerSchema = z.enum(['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi'])
export type ChatProvider = z.infer<typeof providerSchema>
export const ALL_PROVIDERS: readonly ChatProvider[] = providerSchema.options

export const pickerSourceSchema = z.enum(['commands', 'skills', 'files', 'sessions', 'agents', 'conversations', 'drives'])
export type PickerSource = z.infer<typeof pickerSourceSchema>

const pickerSourceSettingsSchema = z.object({
  enabled: z.boolean(),
  order: z.number().int().min(0).max(100),
  limit: z.number().int().min(1).max(50),
  maxCandidates: z.number().int().min(1).max(50).default(50),
})
export type PickerSourceSettings = z.infer<typeof pickerSourceSettingsSchema>

export const pickerSettingsSchema = z.object({
  displayMode: z.enum(['collapse', 'native-scroll']).default('collapse'),
  commands: pickerSourceSettingsSchema,
  skills: pickerSourceSettingsSchema,
  files: pickerSourceSettingsSchema,
  sessions: pickerSourceSettingsSchema,
  // Defaulted, unlike its neighbours, because this key arrived after settings
  // were already on disk. `settingsRecordSchema` is the durable read boundary:
  // a saved record that has `picker` but predates this key would fail the whole
  // parse without it, and the medium — every setting in it — would be rejected.
  // Any key added here from now on needs the same treatment.
  agents: pickerSourceSettingsSchema.default({ enabled: true, order: 25, limit: 6, maxCandidates: 50 }),
  conversations: pickerSourceSettingsSchema,
  // Defaulted for the same reason as `agents` above: it arrived later still.
  drives: pickerSourceSettingsSchema.default({ enabled: true, order: 35, limit: 6, maxCandidates: 50 }),
})
export type PickerSettings = z.infer<typeof pickerSettingsSchema>
export type PickerDisplayMode = PickerSettings['displayMode']
export const inputRenderModeSchema = z.enum(['pill', 'raw-text'])
export type InputRenderMode = z.infer<typeof inputRenderModeSchema>
export const referenceUiModeSchema = z.enum(['plugin', 'official'])
export type ReferenceUiMode = z.infer<typeof referenceUiModeSchema>

/** Defaults used before the user saves the General section. */
export function defaultPickerSettings(): PickerSettings {
  return {
    displayMode: 'collapse',
    commands: { enabled: true, order: 0, limit: 6, maxCandidates: 50 },
    skills: { enabled: true, order: 5, limit: 6, maxCandidates: 50 },
    files: { enabled: true, order: 10, limit: 6, maxCandidates: 50 },
    sessions: { enabled: true, order: 20, limit: 6, maxCandidates: 50 },
    agents: { enabled: true, order: 25, limit: 6, maxCandidates: 50 },
    conversations: { enabled: true, order: 30, limit: 6, maxCandidates: 50 },
    drives: { enabled: true, order: 35, limit: 6, maxCandidates: 50 },
  }
}

/** Picker settings have a fixed schema, so explicit comparison is cheap and stable. */
export function samePickerSettings(left: PickerSettings, right: PickerSettings): boolean {
  if (left.displayMode !== right.displayMode) return false
  return pickerSourceSchema.options.every(key =>
    left[key].enabled === right[key].enabled &&
    left[key].order === right[key].order &&
    left[key].limit === right[key].limit &&
    left[key].maxCandidates === right[key].maxCandidates)
}

export const settingsRecordSchema = z.object({
  opencliPath: z.string(),
  profile: z.string(),
  detailConcurrency: z.number().int().min(1).max(8),
  autoSync: z.boolean().default(false),
  syncOnStartup: z.boolean().default(false),
  autoSyncMinutes: z.number().int().min(15).max(1440).default(60),
  historyMode: z.enum(['metadata-only', 'offline-mirror']).default('metadata-only'),
  enabledProviders: z.array(providerSchema).default([...ALL_PROVIDERS]),
  maxReadTurns: z.number().int().min(1).max(100).default(10),
  inputRenderMode: inputRenderModeSchema.default('pill'),
  // Optional keeps settings written by earlier plugin versions readable.
  referenceUiMode: referenceUiModeSchema.optional(),
  // Optional keeps existing on-disk settings forward-compatible. The client
  // uses defaultPickerSettings() until the user saves the General section.
  picker: pickerSettingsSchema.optional(),
})
export type SettingsRecord = z.infer<typeof settingsRecordSchema>
