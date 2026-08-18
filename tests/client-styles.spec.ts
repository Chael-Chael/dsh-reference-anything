// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { adoptConversationMentionProjection, adoptReferenceIconProjection, adoptStyles } from '../src/client/styles.ts'

afterEach(() => {
  document.body.replaceChildren()
  document.getElementById('dsh-reference-anything-style')?.remove()
})

describe('plugin-owned DSH presentation overrides', () => {
  it('styles the public trigger-menu contract to match the composer', () => {
    adoptStyles()
    const text = document.getElementById('dsh-reference-anything-style')?.textContent ?? ''
    expect(text).toContain('[data-composer-card] [role="listbox"]:has')
    expect(text).toContain('box-sizing:border-box!important')
    expect(text).toContain('border-radius:22px!important')
    expect(text).toContain('[role="presentation"][data-source]:not(:first-child)')
    expect(text).toContain('[data-decoration="chip"]')
    expect(text).toContain('var(--dsw-alias-state-business-primary)')
    expect(text).toContain('width:max-content!important')
    expect(text).toContain('[data-decoration="chip"]:before{display:none!important}')
    expect(text).toContain('position:static!important')
    expect(text).toContain('font-size:inherit!important')
    expect(text).toContain('.dsh_ref_adaptive_caret')
    expect(text).toContain('width:1px')
    expect(text).toContain('animation:dsh_ref_caret_blink 1.06s step-end infinite')
    expect(text).toContain('.dsh_ref_adaptive_caret[hidden]')
  })

  it('projects a logged dsh-ref mention without exposing its opaque URI', () => {
    document.body.innerHTML = '<div data-time-hover-root><div>请参考 @[项目聊天导出](dsh-ref:YWJj) 继续</div></div>'
    const dispose = adoptConversationMentionProjection()
    const projected = document.querySelector('[data-dsh-ref-projection="conversation"]')
    expect(projected?.textContent).toBe('项目聊天导出')
    expect(document.body.textContent).not.toContain('dsh-ref:')
    dispose()
  })

  it('projects the same provider logo marker in menu items and chips', () => {
    document.body.innerHTML = '<div role="listbox"><span>\uE101</span></div><span data-decoration="chip"><span>\uE101 Claude · Design</span></span>'
    const dispose = adoptReferenceIconProjection()
    const projected = document.querySelectorAll('[data-dsh-ref-provider-icon="claude"]')
    expect(projected).toHaveLength(2)
    expect(projected[0]?.textContent).toBe('')
    expect(projected[1]?.textContent).toBe('Claude · Design')
    expect(document.querySelector('[data-decoration="chip"]')?.getAttribute('title')).toBe('Claude · Design')
    dispose()
  })

  it('projects the LobeHub Kimi mark', () => {
    document.body.innerHTML = '<div role="listbox"><span>\uE105 Kimi · World model</span></div>'
    const dispose = adoptReferenceIconProjection()
    const projected = document.querySelector('[data-dsh-ref-provider-icon="kimi"]')
    expect(projected?.textContent).toBe('Kimi · World model')
    expect(projected?.getAttribute('style')).toContain('--dsh-ref-provider-icon')
    dispose()
  })
})
