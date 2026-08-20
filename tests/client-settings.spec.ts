import { describe, expect, it } from 'vitest'
import { defaultPickerSettings, samePickerSettings, settingsRecordSchema } from '../src/wire.ts'
import { OPENCLI_EXTENSION_STORE_URL, runSetupSequence, setupReady } from '../src/client/health.ts'
import type { Health } from '../src/client/remote.ts'

const healthy: Health = {
  version: '1.8.6', daemon: 'Daemon: running (PID 1)', pluginInstalled: true,
  daemonRunning: true, extensionConnected: true, extensionState: 'connected',
  opencliCompatible: true, daemonStale: false, connectivityOk: true, connectivityChecked: true, adapterCommandsReady: true, adapterCompatible: true,
}

describe('settings source registration guard', () => {
  it('defaults every @ source to six visible items', () => {
    const picker = defaultPickerSettings()
    // Keyed rather than positional so adding a group does not require editing a
    // literal, and so a failure names the group that broke the rule.
    const groups = Object.entries(picker)
      .flatMap(([key, source]) => typeof source === 'object' ? [[key, source] as const] : [])
    expect(groups.map(([key, source]) => [key, source.limit]))
      .toEqual(groups.map(([key]) => [key, 6]))
    expect(picker.displayMode).toBe('collapse')
    expect(groups.map(([key, source]) => [key, source.maxCandidates]))
      .toEqual(groups.map(([key]) => [key, 50]))
  })

  it('migrates an older settings record to the new safe defaults', () => {
    const value = settingsRecordSchema.parse({
      opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false,
      autoSyncMinutes: 60, historyMode: 'metadata-only',
    })
    expect(value).toMatchObject({ syncOnStartup: false, maxReadTurns: 10, inputRenderMode: 'pill' })
    expect(value.referenceUiMode).toBeUndefined()
    expect(value.enabledProviders).toEqual(['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi'])
  })
  it('fills in a picker key that arrived after the record was written', () => {
    // `settingsRecordSchema` is the durable read boundary for the domain global,
    // so a missing key does not degrade one group — it rejects the whole medium
    // and takes every other setting with it. Any @ group added from now on needs
    // the same `.default()` and belongs in this list.
    const saved = defaultPickerSettings() as Record<string, unknown>
    delete saved['agents']
    const value = settingsRecordSchema.parse({
      opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false,
      autoSyncMinutes: 60, historyMode: 'metadata-only', picker: saved,
    })
    expect(value.picker?.agents).toEqual({ enabled: true, order: 25, limit: 6, maxCandidates: 50 })
    expect(value.picker?.conversations).toEqual(defaultPickerSettings().conversations)
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
    expect(samePickerSettings(original, { ...original, displayMode: 'native-scroll' })).toBe(false)
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
    expect(setupReady({ ...healthy, daemonStale: true })).toBe(false)
    expect(setupReady({ ...healthy, extensionConnected: false })).toBe(false)
    expect(setupReady({ ...healthy, connectivityOk: false })).toBe(false)
    expect(setupReady({ ...healthy, pluginInstalled: false })).toBe(false)
    expect(setupReady({ ...healthy, adapterCompatible: false })).toBe(false)
  })

  it('runs recovery steps in dependency order and rechecks between them', async () => {
    const order: string[] = []
    let current: Health = {
      ...healthy, version: '', opencliCompatible: false, pluginInstalled: false, adapterCompatible: false,
      daemonRunning: false, daemonStale: false, extensionConnected: false, extensionState: 'daemon-offline', connectivityOk: false,
    }
    await runSetupSequence({
      health: () => current,
      refresh: async () => { order.push('refresh') },
      discoverOpenCli: async () => { order.push('discover'); return { found: true, executable: 'found-opencli', version: '1.8.6' } },
      selectOpenCli: async () => { order.push('select'); current = { ...current, version: '1.8.6', opencliCompatible: true } },
      installOpenCli: async () => { order.push('install-opencli') },
      installAdapter: async () => { order.push('adapter'); current = { ...current, pluginInstalled: true, adapterCompatible: true } },
      restartDaemon: async () => { order.push('daemon'); current = { ...current, daemonRunning: true, extensionState: 'disconnected' } },
      stage: value => { order.push(`stage:${value}`) },
    })
    expect(order).toEqual([
      'stage:checking', 'stage:opencli', 'discover', 'select', 'refresh',
      'stage:adapter', 'adapter', 'refresh', 'stage:daemon', 'daemon', 'stage:checking', 'refresh',
    ])
  })

  it('does not rewrite healthy dependencies during setup', async () => {
    const called: string[] = []
    await runSetupSequence({
      health: () => healthy,
      refresh: async () => { called.push('refresh') },
      discoverOpenCli: async () => { called.push('discover'); return { found: false, executable: '', version: '' } },
      selectOpenCli: async () => { called.push('select') }, installOpenCli: async () => { called.push('opencli') },
      installAdapter: async () => { called.push('adapter') }, restartDaemon: async () => { called.push('daemon') },
      stage: value => { called.push(`stage:${value}`) },
    })
    expect(called).toEqual(['stage:checking', 'stage:checking', 'refresh'])
  })

  it('repairs an installed adapter when its modules failed to load', async () => {
    const called: string[] = []
    let current: Health = { ...healthy, adapterCommandsReady: false, adapterCompatible: false, pluginError: 'import failed' }
    await runSetupSequence({
      health: () => current,
      refresh: async () => { called.push('refresh') },
      discoverOpenCli: async () => ({ found: true, executable: 'opencli', version: '1.8.6' }),
      selectOpenCli: async () => {}, installOpenCli: async () => {},
      installAdapter: async () => { called.push('repair'); current = { ...healthy } },
      restartDaemon: async () => {}, stage: value => { called.push(`stage:${value}`) },
    })

    expect(called).toEqual(['stage:checking', 'stage:adapter', 'repair', 'refresh', 'stage:checking', 'refresh'])
  })
})
