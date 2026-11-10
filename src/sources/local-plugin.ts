/**
 * Reference source over the DSH plugins installed in this profile. The model
 * gets each plugin's name, version and directory, never its source code.
 *
 * @module dsh-reference-anything/local-plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { createPluginReferenceSource } from '../local-plugins.ts'
import { LOCAL_PLUGIN_SETTINGS_ID, defaultLocalPluginSettings, localPluginSettingsFromLegacy, localPluginSettingsSchema } from '../local-plugin-settings.ts'
import type {} from '../index.ts'

export const name = 'reference-local-plugin'
export const inject = ['references']

export function apply(ctx: Context): void {
  const settings = ctx.references.defineSettings(LOCAL_PLUGIN_SETTINGS_ID, {
    schema: localPluginSettingsSchema, defaults: defaultLocalPluginSettings(), fromLegacy: localPluginSettingsFromLegacy,
  })
  ctx.effect(() => ctx.references.registerSource(createPluginReferenceSource(ctx, () => settings.get())), 'reference-local-plugin.source')
}
