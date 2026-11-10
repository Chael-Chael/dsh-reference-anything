/** User settings owned by the local-plugin source. Shared by Host and client. */
import { z } from 'zod'

export const LOCAL_PLUGIN_SETTINGS_ID = 'local-plugin'

export const localPluginSettingsSchema = z.object({
  /** Offer only plugins that are running now. */
  onlyLive: z.boolean().default(false),
  /** Offer the official `@deepseek-ai/` packages too. */
  showDeepSeek: z.boolean().default(true),
})
export type LocalPluginSettings = z.infer<typeof localPluginSettingsSchema>

export function defaultLocalPluginSettings(): LocalPluginSettings { return { onlyLive: false, showDeepSeek: true } }

export function localPluginSettingsFromLegacy(legacy: Readonly<Record<string, unknown>>): LocalPluginSettings | undefined {
  const plugins = (legacy.picker as { plugins?: unknown } | undefined)?.plugins
  if (plugins === undefined) return undefined
  const parsed = localPluginSettingsSchema.safeParse(plugins)
  return parsed.success ? parsed.data : undefined
}

/** Whether a plugin row passes the user's filters. */
export function localPluginVisible(row: { name: string; status: string }, settings: LocalPluginSettings): boolean {
  return (!settings.onlyLive || row.status === 'live')
    && (settings.showDeepSeek || !row.name.toLowerCase().startsWith('@deepseek-ai/'))
}
