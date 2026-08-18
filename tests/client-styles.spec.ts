// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { adoptConversationMentionProjection, adoptConversationSyncActionProjection, adoptMenuExpansionProjection, adoptMenuGroupTitleProjection, adoptReferenceIconProjection, adoptStyles, refreshActiveTriggerMenu } from '../src/client/styles.ts'
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
    expect(text).toContain('.dsh_ref_menu_sync{position:relative')
    expect(text).toContain('border-radius:999px;background:rgba(59,130,246,.11)')
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
    const chip = document.querySelector('[data-decoration="chip"]')
    expect(chip?.getAttribute('title')).toBe('Claude · Design')
    expect(chip?.classList.contains('dsh_ref_conversation_chip')).toBe(true)
    expect(chip?.getAttribute('data-dsh-ref-provider')).toBe('claude')
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
      source: 'External conversations', idleLabel: '立即全部同步', listingLabel: (completed, total) => `正在查询来源 ${String(completed)}/${String(total)}`,
      progressLabel: (completed, total) => `同步 ${String(completed)}/${String(total)}`,
      completeLabel: '同步完成', partialLabel: '同步完成但有错误', failedLabel: '同步失败', cancelledLabel: '同步已取消',
      start: async () => { starts++ }, getStatus: () => status,
      subscribe: next => { listener = next; return () => {} },
    })
    const button = document.querySelector('[data-dsh-ref-sync-all]') as HTMLButtonElement
    expect(button.textContent).toContain('立即全部同步')

    button.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(starts).toBe(1)
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    expect(button.tabIndex).toBe(-1)
    status = {
      jobId: 'job', status: 'running', providers: ['chatgpt'], completed: 2, total: 5,
      providerProgress: [{ provider: 'chatgpt', phase: 'syncing', completed: 2, total: 5 }],
    }
    listener()
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('同步 2/5')
    expect(button.style.getPropertyValue('--dsh-ref-sync-progress')).toBe('0.4')
    status = { ...status, status: 'complete', completed: 5, total: 5 }
    listener()
    expect(button.textContent).toContain('同步完成')
    dispose()
  })

  it('refreshes an open @ query after sync without changing the draft or caret', () => {
    const editor = document.createElement('textarea')
    editor.value = 'compare @chatgpt:cache'
    document.body.append(editor)
    editor.focus()
    editor.setSelectionRange(editor.value.length, editor.value.length)
    const values: string[] = []
    editor.addEventListener('input', () => { values.push(editor.value) })

    expect(refreshActiveTriggerMenu()).toBe(true)
    expect(values).toHaveLength(2)
    expect(values[0]).toContain('\u200B')
    expect(values[1]).toBe('compare @chatgpt:cache')
    expect(editor.value).toBe('compare @chatgpt:cache')
    expect(editor.selectionStart).toBe(editor.value.length)
    expect(document.activeElement).toBe(editor)
  })

  it('reveals external conversation rows in batches of five on demand', () => {
    document.body.innerHTML = '<div role="listbox"><div role="presentation" data-source="External conversations">External conversations</div><button role="option">1</button><button role="option">2</button><button role="option">3</button><button role="option">4</button><button role="option">5</button><button role="option">6</button><button role="option">7</button><button role="option">8</button><button role="option">9</button></div>'
    const dispose = adoptMenuExpansionProjection({ sources: ['External conversations'], label: '展开', getVisibleLimit: () => 3, batchSize: 5 })
    const rows = Array.from(document.querySelectorAll('[role="option"]')) as HTMLButtonElement[]
    expect(rows.slice(0, 3).every(row => !row.classList.contains('dsh_ref_menu_collapsed'))).toBe(true)
    expect(rows.slice(3).every(row => row.classList.contains('dsh_ref_menu_collapsed'))).toBe(true)
    const button = document.querySelector('[data-dsh-ref-menu-expand]') as HTMLButtonElement
    expect(button.textContent).toBe('展开')
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(rows.slice(0, 8).every(row => !row.classList.contains('dsh_ref_menu_collapsed'))).toBe(true)
    expect(rows[8]?.classList.contains('dsh_ref_menu_collapsed')).toBe(true)
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(rows.every(row => !row.classList.contains('dsh_ref_menu_collapsed'))).toBe(true)
    expect(document.querySelector('[data-dsh-ref-menu-expand]')).not.toBeNull()
    dispose()
  })

  it('hides the expansion control when the configured visible limit already includes every row', () => {
    document.body.innerHTML = '<div role="listbox"><div role="presentation" data-source="External conversations">External conversations</div><button role="option">1</button><button role="option">2</button><button role="option">3</button></div>'
    const dispose = adoptMenuExpansionProjection({ sources: ['External conversations'], label: '展开', getVisibleLimit: () => 3 })
    expect(document.querySelector('[data-dsh-ref-menu-expand]')).toBeNull()
    dispose()
  })

  it('hides the expansion control when search narrows the available rows', async () => {
    document.body.innerHTML = '<div role="listbox"><div role="presentation" data-source="External conversations">External conversations</div><button role="option">1</button><button role="option">2</button><button role="option">3</button><button role="option">4</button><button role="option">5</button></div>'
    const dispose = adoptMenuExpansionProjection({ sources: ['External conversations'], label: '展开', getVisibleLimit: () => 3 })
    expect(document.querySelector('[data-dsh-ref-menu-expand]')).not.toBeNull()
    const rows = Array.from(document.querySelectorAll('[role="option"]'))
    rows.slice(2).forEach(row => { row.remove() })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(document.querySelector('[data-dsh-ref-menu-expand]')).toBeNull()
    expect(rows.slice(0, 2).every(row => !row.classList.contains('dsh_ref_menu_collapsed'))).toBe(true)
    dispose()
  })

  it('adds an independent text-only expansion control to every configured group', () => {
    document.body.innerHTML = '<div role="listbox"><div role="presentation" data-source="Commands">Commands</div><button role="option">1</button><button role="option">2</button><div role="presentation" data-source="Skills">Skills</div><button role="option">A</button><button role="option">B</button></div>'
    const dispose = adoptMenuExpansionProjection({ sources: ['Commands', 'Skills'], label: '展开', getVisibleLimit: () => 1 })
    const buttons = Array.from(document.querySelectorAll('[data-dsh-ref-menu-expand]')) as HTMLButtonElement[]
    expect(buttons.map(button => button.dataset.dshRefMenuExpand)).toEqual(['Commands', 'Skills'])
    expect(buttons.every(button => button.className === 'dsh_ref_menu_expand')).toBe(true)
    dispose()
  })

  it('applies the configured initial limit when rows arrive after their group title', async () => {
    document.body.innerHTML = '<div role="listbox"><div role="presentation" data-source="External conversations">External conversations</div></div>'
    const dispose = adoptMenuExpansionProjection({ sources: ['External conversations'], label: '展开', getVisibleLimit: () => 5 })
    const listbox = document.querySelector('[role="listbox"]')!
    for (let index = 0; index < 8; index++) {
      const row = document.createElement('button'); row.setAttribute('role', 'option'); row.textContent = String(index); listbox.append(row)
    }
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const rows = Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[]
    expect(rows.filter(row => !row.classList.contains('dsh_ref_menu_collapsed'))).toHaveLength(5)
    expect(document.querySelector('[data-dsh-ref-menu-expand="External conversations"]')).not.toBeNull()
    dispose()
  })

  it('localizes plugin-owned @ menu group headings without changing source identities', () => {
    document.body.innerHTML = '<div role="presentation" data-source="External conversations">External conversations</div><div role="presentation" data-source="Files and folders">Files and folders</div>'
    const dispose = adoptMenuGroupTitleProjection(((key: string) => ({ 'source.conversations': '外部对话', 'source.files': '文件和文件夹' })[key] ?? key) as never)
    const headings = Array.from(document.querySelectorAll('[data-source]')) as HTMLElement[]
    expect(headings.map(item => item.textContent)).toEqual(['外部对话', '文件和文件夹'])
    expect(headings.map(item => item.dataset.source)).toEqual(['External conversations', 'Files and folders'])
    dispose()
  })
})
