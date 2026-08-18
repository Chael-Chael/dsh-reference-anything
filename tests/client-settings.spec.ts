import { describe, expect, it } from 'vitest'
import { defaultPickerSettings, samePickerSettings } from '../src/wire.ts'

describe('settings source registration guard', () => {
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
