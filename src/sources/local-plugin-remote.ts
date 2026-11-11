/** Remote for the local-plugin source: the plugin rows its `@` group lists. */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { REMOTE_SERVICE_KEYS } from '../contract.ts'
import { resolveLocalPlugins } from '../local-plugins.ts'
import { localPluginVisible, type LocalPluginSettings } from '../local-plugin-settings.ts'

export class LocalPluginRemote extends TypertRemoteService {
  private readonly settings: () => LocalPluginSettings

  constructor(ctx: Context, settings: () => LocalPluginSettings) {
    super(ctx, REMOTE_SERVICE_KEYS.localPlugin)
    this.settings = settings
  }

  /** Installed plugins, filtered by this source's settings. */
  async localPlugins(signal: AbortSignal) {
    signal.throwIfAborted()
    return (await resolveLocalPlugins(this.ctx)).filter(row => localPluginVisible(row, this.settings()))
  }
}
