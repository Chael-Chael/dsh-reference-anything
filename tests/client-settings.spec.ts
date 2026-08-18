import { describe, expect, it } from 'vitest'
import { defaultPickerSettings, samePickerSettings, settingsRecordSchema } from '../src/wire.ts'
import { OPENCLI_EXTENSION_STORE_URL, setupReady } from '../src/client/health.ts'
import type { Health } from '../src/client/remote.ts'

const healthy: Health = {
  version: '1.8.6', daemon: 'Daemon: running (PID 1)', pluginInstalled: true,
  daemonRunning: true, extensionConnected: true, extensionState: 'connected',
}

describe('settings source registration guard', () => {
  it('defaults every @ source to six visible items', () => {
    const picker = defaultPickerSettings()
    expect(Object.values(picker).map(source => source.limit)).toEqual([6, 6, 6, 6, 6])
  })

  it('migrates an older settings record to the new safe defaults', () => {
    const value = settingsRecordSchema.parse({
      opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false,
      autoSyncMinutes: 60, historyMode: 'metadata-only',
    })
    expect(value).toMatchObject({ syncOnStartup: false, maxReadTurns: 10 })
    expect(value.enabledProviders).toEqual(['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi'])
  })
  it('treats an unchanged picker returned by an unrelated settings save as equal', () => {
    const original = defaultPickerSettings()
    const roundTripped = structuredClone(original)

    expect(samePickerSettings(original, roundTripped)).toBe(true)
  })

  it('detects picker behavior changes', () => {
    const original = defaultPickerSettings()
    const changed = structuredClone(original)
    changed.conversations.enabled = false

    expect(samePickerSettings(original, changed)).toBe(false)
  })
})

describe('browser extension install', () => {
  it('points the store URL at the OpenCLI Browser Bridge extension', () => {
    expect(OPENCLI_EXTENSION_STORE_URL).toBe('https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk')
  })

  it('is ready only when every bridge prerequisite is satisfied', () => {
    expect(setupReady(healthy)).toBe(true)
    expect(setupReady(undefined)).toBe(false)
    expect(setupReady({ ...healthy, version: '' })).toBe(false)
    expect(setupReady({ ...healthy, daemonRunning: false })).toBe(false)
    expect(setupReady({ ...healthy, extensionConnected: false })).toBe(false)
    expect(setupReady({ ...healthy, pluginInstalled: false })).toBe(false)
  })
})
