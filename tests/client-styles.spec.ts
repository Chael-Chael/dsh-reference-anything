// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adoptMenuGroupTitleProjection, adoptMenuViewportTracking, adoptReferenceIconProjection, adoptStyles,
  mutateActiveTriggerMenu, refreshActiveTriggerMenu,
} from '../src/client/styles.ts'
import { LOCAL_AGENT_ICON_MARKER, PICKER_ICON_MARKER, PROVIDER_ICON_PATH } from '../src/client/provider-icons.tsx'

afterEach(() => {
  document.body.replaceChildren()
  document.getElementById('dsh-reference-anything-style')?.remove()
})

describe('reference DOM customization', () => {
  it('keeps @ menu and settings styles and scopes the Composer override to the icon slot', () => {
    adoptStyles()
    const text = document.getElementById('dsh-reference-anything-style')?.textContent ?? ''
    expect(text).toContain('[data-composer-card] [role="listbox"]:has')
    expect(text).toContain('[role="presentation"][data-source]{position:sticky;top:0')
    expect(text).toContain('padding-top:6px!important')
    expect(text).toContain('background:var(--dsw-alias-background-primary,var(--dsw-alias-bg-layer-1,#fff))')
    expect(text).toContain('body[data-ds-dark-theme] [data-composer-card] [role="listbox"] [role="presentation"][data-source]{background:#343438}')
    expect(text).toContain('[role="presentation"][data-source]:not(:first-child)')
    expect(text).toContain('[data-dsh-ref-menu-settling]{overflow-anchor:none!important}')
    expect(text).toContain('[aria-selected="false"]:hover{background:transparent!important}')
    expect(text).toContain('[data-dsh-ref-menu-action]{color:var(--dsw-alias-label-tertiary')
    expect(text).toContain('[data-dsh-ref-menu-action]>span:last-child:not(:first-child){display:none!important}')
    expect(text).toContain('.dsh_ref_projected_icon')
    expect(text).toContain('.dsh_ref_picker_icon')
    expect(text).toContain('.dsh_ref_settings')
    expect(text).toContain('--dsh-ref-card-surface:#2c2c30;--dsh-ref-control-surface:var(--dsw-alias-bg-layer-2,#363640)')
    expect(text).toContain('body[data-ds-dark-theme] .dsh_ref_workspace>.dsh_ref_panel,body[data-ds-dark-theme] .dsh_ref_workspace>.dsh_ref_sources{background:#242428}')
    expect(text).not.toContain('.dsh_ref_panel.dsh_ref_general_settings{padding:0;border:0')
    expect(text).toContain('grid-template-columns:minmax(150px,1fr) auto auto auto')
    expect(text).toContain('[data-decoration="chip"][data-dsh-ref-chip-icon]')
    expect(text).toContain('--dsh-ref-chip-icon-mask')
    expect(text).not.toContain('[data-decoration="text-ref"]')
    expect(text).not.toContain('dsh_ref_adaptive_caret')
    expect(text).not.toContain('dsh_ref_message_reference')
    expect(text).not.toContain('dsh_ref_menu_sync')
    expect(text).not.toContain('dsh_ref_menu_expand')
  })

  it.skip('projects Provider, file, and DSH-session logos inside the legacy @ menu', () => {
    document.body.innerHTML = `
      <div data-composer-card><div role="listbox">
        <button role="option"><span>\uE101</span><span>Claude chat</span></button>
        <button role="option"><span>\uE10D</span><span>index.ts</span></button>
        <button role="option"><span>\uE106</span><span>Session</span></button>
        <button role="option"><span>\uE115</span><span>Sync</span></button>
      </div></div>
    `
    const dispose = adoptReferenceIconProjection()
    expect(document.querySelector('[role="listbox"] [data-dsh-ref-menu-icon="claude"]')).not.toBeNull()
    expect(document.querySelector('[role="listbox"] [data-dsh-ref-menu-icon="code"]')).not.toBeNull()
    expect(document.querySelector('[role="listbox"] [data-dsh-ref-menu-icon="session"]')).not.toBeNull()
    expect(document.querySelector('[role="listbox"] [data-dsh-ref-menu-icon="refresh"]')).not.toBeNull()
    expect(document.querySelector('[role="listbox"] [data-dsh-ref-menu-icon="claude"] > svg')).not.toBeNull()
    dispose()
  })

  it.skip('projects Agent and drive source logos inside the legacy @ menu', () => {
    document.body.innerHTML = `<div data-composer-card><div role="listbox">
      <button role="option"><span>${LOCAL_AGENT_ICON_MARKER.codex}</span><span>Codex</span></button>
      <button role="option"><span>${PICKER_ICON_MARKER.drive}${PICKER_ICON_MARKER.text}</span><span>Drive</span></button>
    </div></div>`
    const dispose = adoptReferenceIconProjection()
    expect(document.querySelector('[data-dsh-ref-menu-icon="codex"] > svg')).not.toBeNull()
    expect(document.querySelector('[data-dsh-ref-menu-icon="drive"] > svg')).not.toBeNull()
    expect(document.querySelectorAll('[data-dsh-ref-menu-icon="drive"] > svg')).toHaveLength(2)
    dispose()
  })

  it('reuses Provider and file-type menu glyphs without changing chip geometry nodes', () => {
    document.body.innerHTML = `
      <div data-composer-card>
        <span id="conversation" data-decoration="chip" data-reference-appearance="session">
          <span><span>@</span><svg width="16" height="16"><path d="native-session" /></svg></span><span>Claude·Design</span>
        </span>
        <span id="file" data-decoration="chip" data-reference-appearance="file">
          <span><span>@</span><svg width="16" height="16"><path d="native-file" /></svg></span><span>index.ts</span>
        </span>
        <span id="session" data-decoration="chip" data-reference-appearance="session">
          <span><span>@</span><svg width="16" height="16"><path d="native-session" /></svg></span><span>Local task</span>
        </span>
      </div>
    `
    const conversation = document.getElementById('conversation')!
    const file = document.getElementById('file')!
    const session = document.getElementById('session')!
    const conversationSvg = conversation.querySelector('svg')
    const fileSvg = file.querySelector('svg')
    const dispose = adoptReferenceIconProjection()

    expect(conversation.dataset.dshRefChipIcon).toBe('claude')
    expect(conversation.style.getPropertyValue('--dsh-ref-chip-icon-mask')).toContain('data:image/svg+xml')
    expect(file.dataset.dshRefChipIcon).toBe('code')
    expect(file.style.getPropertyValue('--dsh-ref-chip-icon-mask')).toContain('stroke-width')
    expect(session.dataset.dshRefChipIcon).toBe('session')
    expect(session.style.getPropertyValue('--dsh-ref-chip-icon-mask')).toContain('stroke-width')
    expect(conversation.textContent?.replace(/\s/gu, '')).toBe('@Claude·Design')
    expect(file.textContent?.replace(/\s/gu, '')).toBe('@index.ts')
    expect(conversation.querySelector('svg')).toBe(conversationSvg)
    expect(file.querySelector('svg')).toBe(fileSvg)
    expect(conversation.children).toHaveLength(2)
    expect(file.children).toHaveLength(2)
    dispose()
  })

  it('uses source logos on Agent and Baidu input chips', () => {
    document.body.innerHTML = `<div data-composer-card>
      <span id="agent" data-decoration="chip" data-reference-appearance="session" data-reference-source="Local agent conversations"><span>Codex·Task</span></span>
      <span id="drive" data-decoration="chip" data-reference-appearance="file" data-reference-source="Cloud drive files"><span>BaiduNetdisk·notes.pdf</span></span>
    </div>`
    const dispose = adoptReferenceIconProjection()
    expect(document.getElementById('agent')?.dataset.dshRefChipIcon).toBe('codex')
    expect(document.getElementById('drive')?.dataset.dshRefChipIcon).toBe('drive')
    dispose()
  })

  it('projects local-agent chips with their logo without confusing same-named Web providers', () => {
    document.body.innerHTML = `<div data-composer-card>
      <span id="agent" data-decoration="chip" data-reference-appearance="session"><span><svg/></span><span>Kimi CLI·Agent task</span></span>
      <span id="web" data-decoration="chip" data-reference-appearance="session" data-reference-source="Web conversations"><span><svg/></span><span>Kimi·Web chat</span></span>
    </div>`
    const dispose = adoptReferenceIconProjection()
    expect(document.getElementById('agent')?.dataset.dshRefChipIcon).toBe('kimi')
    expect(document.getElementById('web')?.dataset.dshRefChipIcon).toBe('kimi')
    dispose()
  })

  it('projects a file chip added after the observer starts', async () => {
    document.body.innerHTML = '<div data-composer-card></div>'
    const dispose = adoptReferenceIconProjection()
    const chip = document.createElement('span')
    chip.dataset.decoration = 'chip'
    chip.dataset.referenceAppearance = 'file'
    chip.innerHTML = '<span><span>@</span><svg width="16" height="16"></svg></span><span>report.xlsx</span>'
    document.querySelector('[data-composer-card]')?.append(chip)
    await Promise.resolve()

    expect(chip.dataset.dshRefChipIcon).toBe('spreadsheet')
    expect(chip.textContent).toBe('@report.xlsx')
    dispose()
  })

  it.skip('projects a logo when React inserts an option inside the legacy listbox', async () => {
    document.body.innerHTML = '<div data-composer-card><div role="listbox"><div></div></div></div>'
    const dispose = adoptReferenceIconProjection()
    const option = document.createElement('button')
    option.setAttribute('role', 'option')
    option.innerHTML = '<span>\uE108</span><span>plan</span>'
    document.querySelector('[role="listbox"] > div')?.append(option)
    await Promise.resolve()

    const icon = option.querySelector('[data-dsh-ref-menu-icon="command"]')
    expect(icon?.textContent).toBe('')
    expect(icon?.querySelector('svg')).not.toBeNull()
    dispose()
  })

  it.skip('reprojects the logo when a legacy result reuses an indexed menu row', async () => {
    document.body.innerHTML = `
      <div data-composer-card><div role="listbox"><div id="viewport">
        <button id="row" role="option"><span id="icon">\uE104</span><span>Older Grok row</span></button>
      </div></div></div>
    `
    const viewport = document.getElementById('viewport') as HTMLElement
    const row = document.getElementById('row')!
    const icon = document.getElementById('icon')!
    viewport.scrollTop = 48
    const dispose = adoptReferenceIconProjection()

    expect(icon.dataset.dshRefMenuIcon).toBe('grok')
    expect(icon.querySelector('svg')).not.toBeNull()

    // The host keeps the row and icon span, then writes the marker for the
    // newly inserted first result into that existing icon span.
    icon.replaceChildren(document.createTextNode('\uE100'))
    row.children[1]!.textContent = 'New ChatGPT row'
    await Promise.resolve()

    expect(document.getElementById('row')).toBe(row)
    expect(document.getElementById('icon')).toBe(icon)
    expect(icon.dataset.dshRefMenuIcon).toBe('chatgpt')
    expect(icon.textContent).toBe('')
    expect(icon.querySelector('svg path')?.getAttribute('d')).toBe(PROVIDER_ICON_PATH.chatgpt)
    expect(viewport.scrollTop).toBe(48)
    dispose()
  })

  it('localizes only plugin group headings inside the native @ menu', () => {
    document.body.innerHTML = `
      <div data-composer-card><div role="listbox">
        <div role="presentation" data-source="Files and folders">Files and folders</div>
        <div role="presentation" data-source="External conversations">External conversations</div>
      </div></div>
      <div role="presentation" data-source="Files and folders">Outside</div>
    `
    const t = ((key: string) => ({ 'source.files': '文件', 'source.conversations': '外部对话' }[key] ?? key)) as never
    const dispose = adoptMenuGroupTitleProjection(t)
    expect(document.querySelector('[role="listbox"] [data-source="Files and folders"]')?.textContent).toBe('文件')
    expect(document.querySelector('[role="listbox"] [data-source="External conversations"]')?.textContent).toBe('外部对话')
    expect(document.body.lastElementChild?.textContent).toBe('Outside')
    dispose()
  })

  it('shows expand and collapse as one muted label without their detail copy', async () => {
    adoptStyles()
    document.body.innerHTML = `
      <div data-composer-card><div role="listbox">
        <button id="expand" role="option"><span>Show 5 more</span><span>Expand this group</span></button>
        <button id="collapse" role="option"><span>Collapse</span><span>Show the compact group</span></button>
        <button id="ordinary" role="option"><span>Regular row</span><span>Description</span></button>
      </div></div>
    `
    const t = ((key: string, params?: { count?: number }) => ({
      'menu.collapse': 'Collapse',
      'menu.collapseDetail': 'Show the compact group',
      'menu.showMore': `Show ${String(params?.count)} more`,
      'menu.showMoreDetail': 'Expand this group',
    }[key] ?? key)) as never
    const dispose = adoptMenuGroupTitleProjection(t)
    const expand = document.getElementById('expand')!
    const collapse = document.getElementById('collapse')!
    const ordinary = document.getElementById('ordinary')!

    expect(expand.dataset.dshRefMenuAction).toBe('')
    expect(collapse.dataset.dshRefMenuAction).toBe('')
    expect(ordinary.dataset.dshRefMenuAction).toBeUndefined()
    expect(getComputedStyle(expand.lastElementChild!).display).toBe('none')
    expect(getComputedStyle(collapse.lastElementChild!).display).toBe('none')
    expand.replaceChildren(document.createElement('span'), document.createElement('span'))
    expand.children[0]!.textContent = 'Regular row'
    expand.children[1]!.textContent = 'Description'
    await Promise.resolve()
    expect(expand.dataset.dshRefMenuAction).toBeUndefined()
    dispose()
  })

  it('makes every source heading sticky at the menu viewport top', () => {
    adoptStyles()
    document.body.innerHTML = `
      <div data-composer-card><div role="listbox"><div>
        <div id="commands-heading" role="presentation" data-source="Commands">Commands</div>
        <button role="option">command</button>
        <div id="skills-heading" role="presentation" data-source="Skills">Skills</div>
      </div></div></div>
    `
    for (const id of ['commands-heading', 'skills-heading']) {
      const style = getComputedStyle(document.getElementById(id)!)
      expect(style.position).toBe('sticky')
      expect(style.top).toBe('0px')
      expect(style.zIndex).toBe('2')
      expect(style.paddingTop).toBe('6px')
    }
    expect(getComputedStyle(document.querySelector('[role="option"]')!).scrollMarginBlockStart).toBe('30px')
  })

  it('refreshes an active @ query without changing the visible input or caret', async () => {
    document.body.innerHTML = '<div data-composer-card><textarea>@cache</textarea></div>'
    const input = document.querySelector('textarea')!
    input.focus()
    input.setSelectionRange(6, 6)
    let events = 0
    input.addEventListener('input', () => { events++ })
    expect(refreshActiveTriggerMenu()).toBe(true)
    await Promise.resolve()
    expect(input.value).toBe('@cache')
    expect(input.selectionStart).toBe(6)
    expect(input.selectionEnd).toBe(6)
    expect(events).toBe(2)
  })

  it('restores the pre-click viewport and suppresses recycled hover until a real pointer move', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div data-composer-card>
        <textarea>@</textarea>
        <div role="listbox"><div><button id="expand" role="option" aria-selected="false">expand</button></div></div>
      </div>
    `
    const input = document.querySelector('textarea')!
    const viewport = document.querySelector('[role="listbox"] > div') as HTMLElement
    const action = document.getElementById('expand')!
    const disposeTracking = adoptMenuViewportTracking()
    input.focus()
    viewport.scrollTop = 1138
    action.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 700, clientY: 312 }))
    viewport.scrollTop = 1155
    action.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 700, clientY: 312 }))

    mutateActiveTriggerMenu('External conversations', 'viewport', () => {
      viewport.querySelector('[role="option"]')!.textContent = 'new row'
    })
    await Promise.resolve()

    expect(viewport.dataset.dshRefMenuSettling).toBe('')
    expect(viewport.scrollTop).toBe(1138)
    expect(viewport.textContent).toBe('new row')
    viewport.dispatchEvent(new Event('pointerleave'))
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 700, clientY: 312 }))
    await vi.advanceTimersByTimeAsync(32)
    expect(viewport.dataset.dshRefMenuSettling).toBe('')
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 702, clientY: 312 }))
    expect(viewport.dataset.dshRefMenuSettling).toBeUndefined()
    disposeTracking()
    vi.useRealTimers()
  })

  it('keeps a replaced last source action at the same viewport position beneath sticky headings', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div data-composer-card>
        <textarea>@cache</textarea>
        <div role="listbox"><div>
          <div role="presentation" data-source="External conversations">External conversations</div>
          <button id="dsh-row-1" role="option">row</button>
          <button id="dsh-expand" role="option">expand</button>
        </div></div>
      </div>
    `
    const input = document.querySelector('textarea')!
    const composer = document.querySelector('[data-composer-card]')!
    const oldListbox = document.querySelector('[role="listbox"]')!
    const oldViewport = oldListbox.firstElementChild as HTMLElement
    const oldAction = document.getElementById('dsh-expand')!
    oldViewport.scrollTop = 137
    vi.spyOn(oldViewport, 'getBoundingClientRect').mockReturnValue(rect(0, 300))
    vi.spyOn(oldAction, 'getBoundingClientRect').mockReturnValue(rect(180, 220))
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)

    expect(refreshActiveTriggerMenu('External conversations', 'last')).toBe(true)
    oldListbox.remove()
    await Promise.resolve()

    const loadingListbox = document.createElement('div')
    loadingListbox.setAttribute('role', 'listbox')
    loadingListbox.innerHTML = '<div><div role="presentation" data-source="Skills">Skills</div><button id="skill-row" role="option">skill</button></div>'
    composer.append(loadingListbox)
    expect(refreshActiveTriggerMenu('External conversations')).toBe(true)
    await Promise.resolve()
    loadingListbox.remove()

    const listbox = document.createElement('div')
    listbox.setAttribute('role', 'listbox')
    const viewport = document.createElement('div')
    viewport.innerHTML = `
      <div role="presentation" data-source="External conversations">External conversations</div>
      <button id="dsh-row-1" role="option">row</button>
      <button id="dsh-row-2" role="option">new row</button>
      <button id="dsh-collapse" role="option">collapse</button>
    `
    const newAction = viewport.querySelector('#dsh-collapse') as HTMLElement
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(0, 300))
    vi.spyOn(newAction, 'getBoundingClientRect').mockImplementation(() => rect(517 - viewport.scrollTop, 557 - viewport.scrollTop))
    listbox.append(viewport)
    composer.append(listbox)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(250)
    expect(viewport.scrollTop).toBe(337)
    expect(newAction.getBoundingClientRect().top).toBe(180)
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
  })
})

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, x: 0, y: top, width: 100, height: bottom - top, toJSON: () => ({}) }
}
