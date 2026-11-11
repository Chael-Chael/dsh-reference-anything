/** Remote for the core plugin: one settings object, loaded sources, and package updates. */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { REMOTE_SERVICE_KEYS } from './contract.ts'
import { LOCAL_PLUGIN_SETTINGS_ID, type LocalPluginSettings } from './local-plugin-settings.ts'
import { defaultMenuSettings, menuSettingsSchema, type MenuSettings } from './menu-settings.ts'
import { memorySettings, type SourceSettingsHandle } from './settings.ts'
import { referenceAnythingDomainSpec, settingsRecordSchema, type SettingsRecord } from './store/spec.ts'
import { PACKAGE_NAME, PackageUpdateManager, type PackageUpdateResult, type PackageUpdateStatus } from './update.ts'
import { ReferenceAnythingError } from './errors.ts'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {} from './index.ts'
import type {} from './sources/web-chat/index.ts'
import type {} from './sources/local-agent/index.ts'
import type {} from './sources/cloud-drive/index.ts'

/** Settings handles owned by the plugin that mounts this Remote. */
export interface RemoteSettings {
  readonly menu: SourceSettingsHandle<MenuSettings>
}

export class ReferenceAnythingRemote extends TypertRemoteService {
  private readonly owned: RemoteSettings
  private readonly packageUpdates: PackageUpdateManager

  constructor(ctx: Context, owned?: RemoteSettings, packageUpdates?: PackageUpdateManager) {
    super(ctx, REMOTE_SERVICE_KEYS.core)
    this.owned = owned ?? {
      menu: memorySettings(menuSettingsSchema, defaultMenuSettings()),
    }
    this.packageUpdates = packageUpdates ?? createPackageUpdates(ctx)
  }

  /** Ids of the reference sources and settings currently loaded. */
  sources(signal: AbortSignal): string[] {
    signal.throwIfAborted()
    const references = this.ctx.get('references')
    return references ? [...new Set([...references.sourceIds(), ...references.settingsIds()])] : []
  }

  updateStatus(signal: AbortSignal): Promise<PackageUpdateStatus> { return this.packageUpdates.status(signal) }
  checkUpdate(signal: AbortSignal): Promise<PackageUpdateStatus> { return this.packageUpdates.check(signal) }
  async installUpdate(signal: AbortSignal): Promise<PackageUpdateResult> {
    if (this.ctx.get('referenceChatHistory')?.sync.isRunning()) {
      throw new ReferenceAnythingError('wait for the current conversation sync to finish before updating', 'REFERENCE_SYNC_IN_PROGRESS')
    }
    return this.packageUpdates.update(signal)
  }

  /**
   * One settings object for the current settings panel, assembled from each
   * loaded source's own settings. A source that is not loaded contributes its
   * defaults and ignores what is submitted for it.
   */
  settingsGet(): SettingsRecord {
    const webChat = this.ctx.get('referenceChatHistory')?.getSettings()
      ?? settingsRecordSchema.parse(referenceAnythingDomainSpec.global.initial)
    const agents = this.ctx.get('referenceLocalAgents')?.preferences.get()
    const drives = this.ctx.get('referenceCloudDrive')?.preferences.get()
    const menu = this.owned.menu.get()
    const plugins = this.ctx.get('references')?.settingsOf(LOCAL_PLUGIN_SETTINGS_ID) as LocalPluginSettings | undefined
    const { cloudDriveDownloadDirectory: _directory, enabledDriveMounts: _mounts, enabledAgents: _agents, agentDirectories: _directories, picker: _picker, ...webChatOwn } = webChat
    return settingsRecordSchema.parse({
      ...webChatOwn,
      enabledAgents: agents?.enabledAgents ?? webChat.enabledAgents,
      agentDirectories: agents?.agentDirectories ?? {},
      cloudDriveDownloadDirectory: drives?.downloadDirectory ?? '',
      ...(drives?.enabledMounts === undefined ? {} : { enabledDriveMounts: drives.enabledMounts }),
      picker: {
        ...menu,
        agents: { ...menu.agents, ...(agents ? { showImport: agents.showImport, showSummary: agents.showSummary, skipConfirmation: agents.skipConfirmation } : {}) },
        plugins: { ...menu.plugins, ...(plugins ? { onlyLive: plugins.onlyLive, showDeepSeek: plugins.showDeepSeek } : {}) },
      },
    })
  }

  /** Split one submitted settings object back into each loaded source's own settings. */
  async settingsUpdate(value: SettingsRecord): Promise<SettingsRecord> {
    const settings = settingsRecordSchema.parse(value)
    // The download directory is validated first: it is the one field whose
    // rejection must leave every other setting unsaved.
    const drives = this.ctx.get('referenceCloudDrive')
    if (drives) {
      await drives.updatePreferences({
        downloadDirectory: settings.cloudDriveDownloadDirectory,
        ...(settings.enabledDriveMounts === undefined ? {} : { enabledMounts: settings.enabledDriveMounts }),
      })
    }
    const webChat = this.ctx.get('referenceChatHistory')
    if (webChat) await webChat.updateSettings({ ...webChat.getSettings(), ...settings, cloudDriveDownloadDirectory: webChat.getSettings().cloudDriveDownloadDirectory })
    const agents = this.ctx.get('referenceLocalAgents')
    if (agents) {
      await agents.preferences.update({
        enabledAgents: settings.enabledAgents, agentDirectories: settings.agentDirectories ?? {},
        ...(settings.picker ? { showImport: settings.picker.agents.showImport, showSummary: settings.picker.agents.showSummary, skipConfirmation: settings.picker.agents.skipConfirmation } : {}),
      })
    }
    if (settings.picker) {
      await this.owned.menu.update(settings.picker)
      if (this.ctx.get('references')?.settingsIds().includes(LOCAL_PLUGIN_SETTINGS_ID)) {
        await this.ctx.references.updateSettings(LOCAL_PLUGIN_SETTINGS_ID, { onlyLive: settings.picker.plugins.onlyLive, showDeepSeek: settings.picker.plugins.showDeepSeek })
      }
    }
    return this.settingsGet()
  }
}

/**
 * The package updater. After an update, the Web-chat source (when loaded)
 * reinstalls its OpenCLI adapter from the new package.
 */
export function createPackageUpdates(ctx: Context): PackageUpdateManager {
  return new PackageUpdateManager({
    afterInstall: async (profileDir, _version, signal) => {
      await ctx.get('referenceChatHistory')?.installAdapterFrom(pathToFileURL(join(profileDir, 'node_modules', PACKAGE_NAME, 'opencli-plugin')).href, signal)
    },
  })
}
