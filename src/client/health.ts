import type { Health } from './remote.ts'

/**
 * Chrome Web Store listing for the OpenCLI Browser Bridge extension. Chrome
 * does not let a web page install an extension silently, so the "one-click
 * install" step for the browser extension is opening this page — the user only
 * has to press "Add to Chrome" there. Extension id: `ildkmabpimmkaediidaifkhjpohdnifk`.
 */
export const OPENCLI_EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk'

/** The viability panel is green only when every bridge prerequisite is satisfied. */
export function setupReady(health?: Health): boolean {
  return Boolean(health && health.version && health.daemonRunning && health.extensionConnected && health.pluginInstalled)
}
