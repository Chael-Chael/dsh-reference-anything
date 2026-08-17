/** JSON-compatible schema shared by the Host Remote and browser client. */
import { z } from 'zod'

export const providerSchema = z.enum(['chatgpt', 'claude', 'gemini', 'deepseek', 'grok'])
export type ChatProvider = z.infer<typeof providerSchema>

export const settingsRecordSchema = z.object({
  opencliPath: z.string(),
  profile: z.string(),
  detailConcurrency: z.number().int().min(1).max(8),
})
export type SettingsRecord = z.infer<typeof settingsRecordSchema>
