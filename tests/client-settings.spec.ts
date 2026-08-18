import { describe, expect, it } from 'vitest'
import { defaultPickerSettings, samePickerSettings, settingsRecordSchema } from '../src/wire.ts'

describe('settings source registration guard', () => {
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
