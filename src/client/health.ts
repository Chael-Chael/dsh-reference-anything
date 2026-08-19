import type { Health, OpenCliDiscovery } from './remote.ts'

/**
 * Chrome Web Store listing for the OpenCLI Browser Bridge extension. Chrome
 * does not let a web page install an extension silently, so the "one-click
 * install" step for the browser extension is opening this page — the user only
 * has to press "Add to Chrome" there. Extension id: `ildkmabpimmkaediidaifkhjpohdnifk`.
 */
export const OPENCLI_EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk'

/** Keep the automatic viability probe to one attempt for one client-plugin lifetime. */
export function createSettingsOpenHealthCheck(check: () => Promise<void>): (enabled: boolean) => Promise<void> {
  let attempted = false
  return async enabled => {
    if (!enabled || attempted) return
    attempted = true
    await check()
  }
}

/** The viability panel is green only when every bridge prerequisite is satisfied. */
export function setupReady(health?: Health): boolean {
  return Boolean(health && health.version && health.opencliCompatible && health.daemonRunning && !health.daemonStale
    && health.extensionConnected && health.connectivityOk && health.pluginInstalled && health.adapterCompatible)
}

/** Open synchronously from the click handler so Chrome keeps the user activation. */
export function openExtensionStore(): boolean {
  let opened: Window | null
  try { opened = window.open(OPENCLI_EXTENSION_STORE_URL, '_blank') } catch { return false }
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
