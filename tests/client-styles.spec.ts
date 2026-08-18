// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { adoptConversationMentionProjection, adoptConversationSyncActionProjection, adoptReferenceIconProjection, adoptStyles } from '../src/client/styles.ts'
import type { SyncStatus } from '../src/client/remote.ts'

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
    expect(text).toContain('.dsh_ref_chip{display:inline-flex')
    expect(text).toContain('border-radius:14px')
    expect(text).toContain('background:var(--dsw-alias-bg-layer-1)')
    expect(text).toContain('.dsh_ref_remove:hover{background:var(--dsw-alias-interactive-bg-hover)')
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

  it('adds a live sync-all action to the external conversation group header', () => {
    let status: SyncStatus | undefined
    let listener = (): void => {}
    let starts = 0
    document.body.innerHTML = '<div role="listbox"><div role="presentation" data-source="External conversations">External conversations</div></div>'
    const dispose = adoptConversationSyncActionProjection({
      source: 'External conversations', idleLabel: '立即全部同步', listingLabel: '正在查询来源…',
      progressLabel: (completed, total) => `同步 ${String(completed)}/${String(total)}`,
      start: async () => { starts++ }, getStatus: () => status,
      subscribe: next => { listener = next; return () => {} },
    })
    const button = document.querySelector('[data-dsh-ref-sync-all]') as HTMLButtonElement
    expect(button.textContent).toContain('立即全部同步')

    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(starts).toBe(1)
    status = {
      jobId: 'job', status: 'running', providers: ['chatgpt'], completed: 2, total: 5,
      providerProgress: [{ provider: 'chatgpt', phase: 'syncing', completed: 2, total: 5 }],
    }
    listener()
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('同步 2/5')
    expect(button.style.getPropertyValue('--dsh-ref-sync-progress')).toBe('0.4')
    dispose()
  })
})
