import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
type T = TranslateNS<'reference-anything'>
import type { Health, OpenCliDiscovery } from './remote.ts'

/**
 * Chrome Web Store listing for the OpenCLI Browser Bridge extension. Chrome
 * does not let a web page install an extension silently, so the "one-click
 * install" step for the browser extension is opening this page — the user only
 * has to press "Add to Chrome" there. Extension id: `ildkmabpimmkaediidaifkhjpohdnifk`.
 */
export const OPENCLI_EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk'
export const OPENCLI_RELEASES_URL = 'https://github.com/jackwener/OpenCLI/releases'

/** The viability panel is green only when every bridge prerequisite is satisfied. */
export function setupReady(health?: Health): boolean {
  return Boolean(health && health.version && health.opencliCompatible && health.daemonRunning && !health.daemonStale
    && health.extensionConnected && health.extensionCompatible !== false && health.connectivityOk && health.pluginInstalled && health.adapterCompatible)
}

/** Open synchronously from the click handler so Chrome keeps the user activation. */
export function openExtensionStore(url = OPENCLI_EXTENSION_STORE_URL): boolean {
  let opened: Window | null
  try { opened = window.open(url, '_blank') } catch { return false }
  if (!opened) return false
  try { opened.opener = null } catch { /* Cross-origin navigation can race this assignment. */ }
  return true
}

export type SetupStage = 'checking' | 'opencli' | 'adapter' | 'daemon' | 'extension' | 'complete'

export interface SetupOperations {
  health(): Health | undefined
  refresh(): Promise<void>
  discoverOpenCli(): Promise<OpenCliDiscovery>
  selectOpenCli(executable: string): Promise<void>
  installOpenCli(): Promise<void>
  installAdapter(): Promise<void>
  restartDaemon(): Promise<void>
  stage(value: SetupStage): void
}

/** Deterministic, testable setup order; the UI remains responsible for confirmation and copy. */
export async function runSetupSequence(operations: SetupOperations): Promise<Health | undefined> {
  operations.stage('checking')
  if (!operations.health()) await operations.refresh()
  let health = operations.health()
  if (!health?.version) {
    operations.stage('opencli')
    const discovery = await operations.discoverOpenCli()
    if (discovery.found) await operations.selectOpenCli(discovery.executable)
    else await operations.installOpenCli()
    await operations.refresh(); health = operations.health()
  }
  if (health?.version && !health.opencliCompatible) {
    operations.stage('opencli')
    await operations.installOpenCli()
    await operations.refresh(); health = operations.health()
  }
  if (!health?.version || !health.opencliCompatible) return health
  if (!health.pluginInstalled || !health.adapterCompatible) {
    operations.stage('adapter')
    await operations.installAdapter()
    await operations.refresh(); health = operations.health()
  }
  if (!health?.daemonRunning || health.daemonStale || health.extensionState === 'disconnected') {
    operations.stage('daemon')
    await operations.restartDaemon()
  }
  operations.stage('checking')
  await operations.refresh()
  return operations.health()
}

export function openCliStateDetail(health: Health | undefined, t: T): string {
  if (!health?.version) return health?.versionError || t('settings.notDetected')
  if (!health.opencliCompatible) return t('settings.opencliVersionUnsupported', { version: health.version })
  return `v${health.version}`
}

export function daemonStateDetail(health: Health | undefined, t: T): string {
  if (!health?.daemonRunning) return health?.daemonError || t('settings.daemonNotRunning')
  if (health.daemonStale) return t('settings.daemonStale', { version: health.daemonVersion || t('settings.unknownVersion'), cliVersion: health.version || t('settings.unknownVersion') })
  return health.daemonVersion ? t('settings.daemonRunningVersion', { version: health.daemonVersion }) : t('settings.daemonRunning')
}

export function adapterStateDetail(health: Health | undefined, t: T): string {
  if (!health?.pluginInstalled) return health?.pluginError || t('settings.adapterMissing')
  if (health.pluginError) return t('settings.adapterLoadFailed', { error: health.pluginError })
  if (!health.adapterCommandsReady) return t('settings.adapterIncomplete')
  if (!health.adapterCompatible) return t('settings.adapterVersionUnsupported', { version: health.pluginVersion || t('settings.unknownVersion') })
  return health.pluginVersion ? t('settings.adapterInstalledVersion', { version: health.pluginVersion }) : t('settings.adapterInstalled')
}

export function extensionStateDetail(health: Health | undefined, t: T): string {
  if (health?.extensionCompatible === false) return t('settings.extensionIncompatible', { version: health.extensionVersion || t('settings.unknownVersion'), cliVersion: health.version })
  if (health?.extensionConnected && !health.extensionVersion) return t('settings.extensionConnectedUnknown')
  if (health?.extensionConnected && health.extensionUpdateAvailable) return t('settings.extensionUpdateAvailable', { version: health.extensionVersion || t('settings.unknownVersion'), latest: health.latestExtensionVersion || t('settings.unknownVersion') })
  if (!health) return t('settings.extensionDisconnected')
  if (health.extensionConnected && !health.connectivityChecked) return t('settings.extensionConnectivityUnchecked')
  if (health.extensionConnected && !health.connectivityOk) return health.doctorError || t('settings.extensionConnectivityFailed')
  switch (health.extensionState) {
    case 'connected': return health.extensionVersion ? t('settings.extensionConnected', { version: health.extensionVersion }) : t('settings.extensionConnectedUnknown')
    case 'profile-required': return t('settings.extensionProfileRequired', { count: health.profileCount ?? 0 })
    case 'profile-disconnected': return t('settings.extensionProfileDisconnected')
    case 'daemon-offline': return t('settings.daemonNotRunning')
    default: return t('settings.extensionDisconnected')
  }
}

export function healthAttention(health: Health | undefined, t: T): string[] {
  if (!health) return []
  const details: string[] = []
  if (!health.version || !health.opencliCompatible) details.push(`OpenCLI: ${openCliStateDetail(health, t)}`)
  if (health.updateAvailable) details.push(t('menu.opencliUpdate', { version: health.version, latest: health.latestVersion || t('settings.unknownVersion') }))
  if (!health.daemonRunning || health.daemonStale) details.push(`${t('check.browserBridge')}: ${daemonStateDetail(health, t)}`)
  if (!health.pluginInstalled || !health.adapterCompatible || !health.adapterCommandsReady || health.pluginError) details.push(`${t('check.conversationAdapter')}: ${adapterStateDetail(health, t)}`)
  if (!health.extensionConnected || health.extensionCompatible === false || !health.extensionVersion || !health.connectivityOk || health.extensionUpdateAvailable) details.push(`${t('check.browserExtension')}: ${extensionStateDetail(health, t)}`)
  return details
}
