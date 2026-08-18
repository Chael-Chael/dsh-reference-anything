// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { adoptConversationMentionProjection, adoptStyles } from '../src/client/styles.ts'

afterEach(() => {
  document.body.replaceChildren()
  document.getElementById('dsh-reference-anything-style')?.remove()
})

describe('plugin-owned DSH presentation overrides', () => {
  it('styles the public trigger-menu contract to match the composer', () => {
    adoptStyles()
    const text = document.getElementById('dsh-reference-anything-style')?.textContent ?? ''
    expect(text).toContain('[data-composer-card] [role="listbox"]:has')
    expect(text).toContain('border-radius:22px!important')
    expect(text).toContain('[role="presentation"][data-source]:not(:first-child)')
  })

  it('projects a logged dsh-ref mention without exposing its opaque URI', () => {
    document.body.innerHTML = '<div data-time-hover-root><div>请参考 @[项目聊天导出](dsh-ref:YWJj) 继续</div></div>'
    const dispose = adoptConversationMentionProjection()
    const projected = document.querySelector('[data-dsh-ref-projection="conversation"]')
    expect(projected?.textContent).toBe('项目聊天导出')
    expect(document.body.textContent).not.toContain('dsh-ref:')
    dispose()
  })
})
