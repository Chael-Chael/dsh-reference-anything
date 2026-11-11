/**
 * The core plugin's browser surface: the settings panel, the loaded-source
 * roster and package updates. Mounted only while Typert is present, so the
 * registry itself still works without a Web host (tests, headless runs).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { ReferenceAnythingRemote, createPackageUpdates } from './host.ts'
import { MENU_SETTINGS_ID, defaultMenuSettings, menuSettingsFromLegacy, menuSettingsSchema } from './menu-settings.ts'
import { mountRemote } from './remote-mount.ts'
import type { SourceSettingsDefinition, SourceSettingsHandle } from './settings.ts'
import { CORE_TYPERT_MANIFEST } from './typert.ts'

/** What the core Remote needs from the registry that mounts it. */
export interface CoreRemoteOwner {
  defineSettings<T>(id: string, definition: SourceSettingsDefinition<T>): SourceSettingsHandle<T>
}

/**
 * @param ctx - the core plugin's context; everything here unloads with it.
 * @param owner - the registry, which keeps the `@` menu's own settings.
 */
export function mountCoreRemote(ctx: Context, owner: CoreRemoteOwner): void {
  // Defined for the core's whole life, not per Typert session: one definition per id.
  const menu = owner.defineSettings(MENU_SETTINGS_ID, { schema: menuSettingsSchema, defaults: defaultMenuSettings(), fromLegacy: menuSettingsFromLegacy })
  const packageUpdates = createPackageUpdates(ctx)
  mountRemote(ctx, scope => new ReferenceAnythingRemote(scope, { menu }, packageUpdates), CORE_TYPERT_MANIFEST)
  // The startup update check serves the settings panel, so it runs only where one exists.
  ctx.inject(['typert'], scope => {
    scope.effect(() => {
      const abort = new AbortController()
      void packageUpdates.check(abort.signal).then(status => {
        if (status.updateAvailable) scope.logger.info(`reference anything update available: ${status.currentVersion} -> ${status.latestVersion}`)
      }, () => undefined)
      return () => { abort.abort() }
    }, 'references.updateCheck')
  })
}
