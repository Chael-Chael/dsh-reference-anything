// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { en } from '../src/client/locale.ts'
import { PLUGIN_SOURCE } from '../src/client/source.ts'
import { defaultPickerSettings, settingsRecordSchema, type SettingsRecord } from '../src/wire.ts'

it('removes and restores the plugin source immediately through the settings save action', async () => {
  let settings = settingsRecordSchema.parse({
    opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false,
    autoSyncMinutes: 60, historyMode: 'metadata-only', picker: defaultPickerSettings(),
  })
  const ok = <T,>(value: T) => ({ ok: true, value })
  const remote = {
    settingsGet: async () => ok(settings),
    settingsUpdate: vi.fn(async (value: SettingsRecord) => ok(settings = settingsRecordSchema.parse(value))),
    storageStats: async () => ok({}), stats: async () => ok([]), agentStats: async () => ok([]),
    openListStatus: async () => ok({}), updateStatus: async () => ok({ updateAvailable: false }),
    localPlugins: vi.fn(async () => ok([{ id: 'local', name: 'local', label: 'local', status: 'live' }])),
  }
  const sources = new Map<string, InputTriggerSource>()
  const effects: Array<Promise<unknown>> = []
  let save!: (settings: SettingsRecord) => Promise<boolean>
  const ctx = {
    effect: (run: () => unknown) => { effects.push(Promise.resolve(run())) },
    remote: { $mount: async () => () => {} }, reflect: { get: () => remote },
    get: () => ({ registerSource: (source: InputTriggerSource) => {
      sources.set(source.name, source)
      return () => { sources.delete(source.name) }
    } }),
    locale: { register: () => () => {}, bind: () => (key: keyof typeof en) => en[key] },
    sessions: {},
    slots: {
      inject: (_name: string, run: () => unknown) => run(),
      register: (section: { inject: () => { save: typeof save } }) => { save = section.inject().save },
    },
  } as unknown as Context
  apply(ctx)
  const disposers = await Promise.all(effects)
  try {
    expect(sources.has(PLUGIN_SOURCE)).toBe(true)
    const originalSources = [...sources.keys()]
    expect(await save({ ...settings, picker: { ...settings.picker!, plugins: { ...settings.picker!.plugins, enabled: false } } })).toBe(true)
    expect(sources.has(PLUGIN_SOURCE)).toBe(false)
    expect([...sources.keys()]).toEqual(originalSources.filter(name => name !== PLUGIN_SOURCE))
    expect(settings.picker?.plugins.enabled).toBe(false)
    expect(await save({ ...settings, picker: { ...settings.picker!, plugins: { ...settings.picker!.plugins, enabled: true } } })).toBe(true)
    expect([...sources.keys()]).toEqual(originalSources)
  } finally {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose()
  }
})
