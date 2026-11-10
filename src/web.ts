import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { ReferenceAnythingRemote, createPackageUpdates } from './host.ts'
import { CORE_TYPERT_MANIFEST } from './typert.ts'
import type {} from './index.ts'
import { MENU_SETTINGS_ID, defaultMenuSettings, menuSettingsFromLegacy, menuSettingsSchema } from './menu-settings.ts'

export const name = 'reference-anything-web'
// Only what the core Remote itself needs. Every source mounts its own Remote,
// so switching any source off leaves this one, and the settings panel, intact.
export const inject = ['typert', 'references']

export function apply(ctx: Context): void {
  const menu = ctx.references.defineSettings(MENU_SETTINGS_ID, { schema: menuSettingsSchema, defaults: defaultMenuSettings(), fromLegacy: menuSettingsFromLegacy })
  const packageUpdates = createPackageUpdates(ctx)
  new ReferenceAnythingRemote(ctx, { menu }, packageUpdates)
  ctx.effect(() => {
    const dispose = ctx.typert.register(CORE_TYPERT_MANIFEST)
    return () => { void dispose() }
  }, 'reference-anything-web.typert')
  ctx.effect(() => {
    const abort = new AbortController()
    void packageUpdates.check(abort.signal).then(status => {
      if (status.updateAvailable) ctx.logger.info(`reference anything update available: ${status.currentVersion} -> ${status.latestVersion}`)
    }, () => undefined)
    return () => { abort.abort() }
  }, 'reference-anything-web.updateCheck')
}
