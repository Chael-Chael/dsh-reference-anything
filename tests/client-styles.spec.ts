// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adoptMenuGroupTitleProjection, adoptMenuViewportTracking, adoptReferenceIconProjection, adoptSettingsIconProjection, adoptStyles,
  mutateActiveTriggerMenu, refreshActiveTriggerMenu,
} from '../src/client/styles.ts'
import { LOCAL_AGENT_ICON_MARKER, PICKER_ICON_MARKER, PROVIDER_ICON_PATH } from '../src/client/provider-icons.tsx'
import { AGENT_ICON_MONO_URI } from '../src/client/agent-icons.ts'
import { en, zh } from '../src/client/locale.ts'
import { ALL_LOCAL_AGENTS, LOCAL_AGENT_LABEL } from '../src/wire.ts'

afterEach(() => {
  document.body.replaceChildren()
  document.getElementById('dsh-reference-anything-style')?.remove()
})

describe('reference DOM customization', () => {
  it.each([
    ...ALL_LOCAL_AGENTS.map(agent => [agent, agent === 'kimi' ? 'Kimi CLI' : LOCAL_AGENT_LABEL[agent], 'Local agent conversations']),
    ...Object.entries({ chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok', kimi: 'Kimi' })
      .map(([provider, label]) => [provider, label, 'External conversations']),
  ])('keeps %s icons stable when an alpha row is refreshed', async (agent, label, source) => {
    document.body.innerHTML = `<div data-composer-card><div role="listbox">
      <div role="presentation" data-source="${source}"></div>
      <button role="option"><span></span><span>Task</span><span>Codex · today</span></button>
    </div></div>`
    const dispose = adoptReferenceIconProjection()
    const row = document.querySelector('[role="option"]')!
    const icon = row.firstElementChild!
    const replaceChildren = icon.replaceChildren.bind(icon)
    const replace = vi.spyOn(icon, 'replaceChildren')
    // Bound mutations so a regression fails instead of starving the test runner.
    replace.mockImplementation((...children) => {
      if (replace.mock.calls.length > 3) dispose()
      replaceChildren(...children)
    })
    try {
      row.children[2]!.textContent = `${label} · today`
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(icon.getAttribute('data-dsh-ref-menu-icon')).toBe(agent)
      expect(replace.mock.calls.length).toBeLessThanOrEqual(1)
      row.children[1]!.textContent = 'Updated task'
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(replace.mock.calls.length).toBeLessThanOrEqual(1)
    } finally { dispose(); replace.mockRestore() }
  })
  it.each(ALL_LOCAL_AGENTS.filter(agent => !['claude-code', 'codex', 'cursor', 'qoder', 'openclaw', 'kimi', 'grokbuild', 'hermes', 'gemini-cli', 'pi', 'opencode', 'mimocode', 'zcode', 'chatgpt'].includes(agent)))('reuses the settings logo for %s in menus and reference chips', agent => {
    document.body.innerHTML = `<div data-composer-card><div role="listbox">
      <button role="option"><span>${LOCAL_AGENT_ICON_MARKER[agent]}</span><span>Task</span></button>
      <div role="presentation" data-source="Local agent conversations"></div>
      <button role="option"><span></span><span>Task</span><span>${LOCAL_AGENT_LABEL[agent]} · today</span></button>
    </div><span id="agent-chip" data-composer-chip="Local agent conversations"><span><svg></svg><span>${LOCAL_AGENT_LABEL[agent]}·Task</span></span></span></div>`
    const dispose = adoptReferenceIconProjection()
    try {
      const icons = document.querySelectorAll(`[data-dsh-ref-menu-icon="${agent}"] img`)
      expect(icons).toHaveLength(2)
      for (const icon of Array.from(icons)) expect(icon.getAttribute('src')).toBe(AGENT_ICON_MONO_URI[agent])
      expect(document.getElementById('agent-chip')!.style.getPropertyValue('--dsh-ref-chip-icon-mask')).toBe(`url("${AGENT_ICON_MONO_URI[agent]}")`)
    } finally { dispose() }
  })

  it('preserves the WorkBuddy clipping region when removing its tile background', () => {
    const svg = new DOMParser().parseFromString(decodeURIComponent(AGENT_ICON_MONO_URI.workbuddy!.split(',')[1]!), 'image/svg+xml')
    expect(svg.querySelector('clipPath rect')).not.toBeNull()
    expect(svg.querySelector('svg > g > rect[width="280"]')).toBeNull()
  })

  it('uses the custom session bubble in ordinary and subagent menu sections', () => {
    document.body.innerHTML = `<div data-composer-card><div role="listbox">
      <div role="presentation">子 Agent</div>
      <button role="option" id="dsh-slash-option-DSH sessions-0"><span><svg><path d="native" /></svg></span><span>Child</span></button>
      <div role="presentation">DSH 对话</div>
      <button role="option" id="dsh-slash-option-DSH sessions-1"><span><svg><path d="native" /></svg></span><span>Task</span></button>
    </div></div>`
    const dispose = adoptReferenceIconProjection()
    try {
      for (const row of Array.from(document.querySelectorAll('[role="option"]'))) {
        expect(row.querySelector('path')?.getAttribute('d')).toBe('M7.9 20A9 9 0 1 0 4 16.1L2 22Z')
      }
    } finally { dispose() }
  })

  it.each(['Codex', 'Claude', 'ChatGPT'])('keeps imported %s sessions as DSH session bubbles', label => {
    document.body.innerHTML = `<div data-composer-card>
      <span id="session" data-composer-chip="DSH sessions"><span><svg></svg><span>${label}·Imported task</span></span></span>
    </div>`
    const dispose = adoptReferenceIconProjection()
    try {
      const chip = document.getElementById('session')!
      expect(chip.dataset.dshRefChipIcon).toBe('session')
      expect(decodeURIComponent(chip.style.getPropertyValue('--dsh-ref-chip-icon-mask'))).toContain('M7.9 20A9 9 0 1 0 4 16.1L2 22Z')
    } finally { dispose() }
  })

  it.each(['reference', 'session', ''])('does not infer an imported session logo from its title for source %s', source => {
    document.body.innerHTML = `<div data-composer-card><span id="imported" data-decoration="chip" data-reference-appearance="session" ${source ? `data-reference-source="${source}"` : ''}><span><svg/></span><span>Codex·Imported task</span></span></div>`
    const dispose = adoptReferenceIconProjection()
    try { expect(document.getElementById('imported')!.dataset.dshRefChipIcon).toBe('session') }
    finally { dispose() }
  })

  it.each(['probe.txt', 'folder/', 'Codex·Imported task'])('preserves the native icon for an untyped reference chip: %s', label => {
    document.body.innerHTML = `<div data-composer-card><span id="native" data-composer-chip="reference"><span><svg><path d="native"/></svg><span>${label}</span></span></span></div>`
    const dispose = adoptReferenceIconProjection()
    try {
      const chip = document.getElementById('native')!
      expect(chip.dataset.dshRefChipIcon).toBeUndefined()
      expect(chip.querySelector('path')?.getAttribute('d')).toBe('native')
    } finally { dispose() }
  })

  it('places each agent description on its own row and allows wrapping', () => {
    adoptStyles()
    document.body.innerHTML = '<div class="dsh_ref_settings"><article class="dsh_ref_agent_provider"><div class="dsh_ref_provider_main"><div class="dsh_ref_provider_summary"><h4>Antigravity</h4><strong>34</strong><small>Discovered by chat import</small><small>Import only</small></div></div></article></div>'
    for (const line of Array.from(document.querySelectorAll('small'))) {
      const style = getComputedStyle(line)
      expect(style.gridRow).toBe('auto')
      expect(style.whiteSpace).toBe('normal')
    }
  })

  it.each([zh, en])('updates the Desktop Tab hint from current agent action settings', async locale => {
    document.body.innerHTML = `<div data-composer-card><div role="listbox">
      <div role="presentation" data-source="Local agent conversations"></div>
      <div role="option"><span>Example</span><span>Codex · 2026/10/14</span><div><span class="drillHintText">进入目录</span><span role="button" aria-label="进入目录">Tab</span></div></div>
    </div></div>`
    const settings = { showImport: true, showSummary: false, skipConfirmation: false }
    const dispose = adoptMenuGroupTitleProjection(((key: keyof typeof zh) => locale[key]) as Parameters<typeof adoptMenuGroupTitleProjection>[0], () => settings)
    try {
      const hint = document.querySelector('.drillHintText')!
      expect(hint.textContent).toBe(locale['agent.importHint'])
      settings.showImport = false
      settings.showSummary = true
      hint.textContent = '进入目录'
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(hint.textContent).toBe(locale['settings.agentSummary'])
      settings.showImport = true
      hint.textContent = '进入目录'
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(hint.textContent).toBe(locale['agent.actions'])
      expect(document.querySelector('[role="button"]')?.getAttribute('aria-label')).toBe(locale['agent.actions'])
    } finally { dispose() }
  })
  it.each([zh, en])('keeps agent action icons through alpha row refreshes', async (locale) => {
    document.body.innerHTML = `<div data-composer-card><div role="listbox">
      <div role="presentation" data-source="Local agent conversations"></div>
      <button role="option"><span></span><span>${locale['agent.import']}</span></button>
      <button role="option"><span>${PICKER_ICON_MARKER.summary}</span><span>${locale['agent.resume']}</span></button>
      <button role="option"><span></span><span>${locale['agent.back']}</span></button>
    </div></div>`
    const dispose = adoptReferenceIconProjection()
    try {
      const rows = Array.from(document.querySelectorAll('[role="option"]'))
      rows[0]!.children[1]!.textContent = locale['agent.importing']
      rows[1]!.children[1]!.textContent = locale['agent.resuming']
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(rows.map(row => row.firstElementChild?.getAttribute('data-dsh-ref-menu-icon')))
        .toEqual(['import', 'summary', 'undo-2'])
      expect(rows.every(row => row.querySelector('svg path') !== null)).toBe(true)
    } finally { dispose() }
  })
  it('projects the logo only onto its settings entry and restores it on disposal', async () => {
    document.body.innerHTML = `<div data-shortcut-modal="settings"><nav>
      <button><svg></svg><span>Reference Anything</span></button>
      <button><svg></svg><span>Plugin market</span></button>
    </nav></div><nav><button>Reference Anything</button></nav>`
    const dispose = adoptSettingsIconProjection()
    expect(document.querySelectorAll('[data-dsh-ref-settings-icon]')).toHaveLength(1)
    const nav = document.querySelector('[data-shortcut-modal="settings"] nav')!
    const later = document.createElement('button')
    later.textContent = 'Reference Anything'
    nav.replaceChildren(later)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(later.hasAttribute('data-dsh-ref-settings-icon')).toBe(true)
    later.textContent = 'Plugin market'
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(later.hasAttribute('data-dsh-ref-settings-icon')).toBe(false)
    later.textContent = 'Reference Anything'
    await new Promise(resolve => setTimeout(resolve, 0))
    dispose()
    expect(document.querySelector('[data-dsh-ref-settings-icon]')).toBeNull()
  })

  it('keeps @ menu and settings styles and scopes the Composer override to the icon slot', () => {
    adoptStyles()
    const text = document.getElementById('dsh-reference-anything-style')?.textContent ?? ''
    expect(text).toContain('[data-composer-card] [role="listbox"]:has')
    expect(text).toContain('[data-trigger-menu]:has(> [role="listbox"] [role="presentation"][data-source]){border-radius:var(--dsw-radius-lg,22px)}')
    expect(text).not.toContain('border-radius:22px!important')
    expect(text).not.toContain('[role="presentation"][data-source]{position:sticky')
    expect(text).not.toContain('[role="presentation"][data-source]:not(:first-child)')
    expect(text).toContain('[data-dsh-ref-menu-settling]{overflow-anchor:none!important}')
    expect(text).toContain('[aria-selected="false"]:hover{background:transparent!important}')
    expect(text).toContain('[data-dsh-ref-menu-action]{color:var(--dsw-alias-label-tertiary')
    expect(text).toContain('[data-dsh-ref-menu-action]>span:last-child:not(:first-child){display:none!important}')
    expect(text).toContain('.dsh_ref_projected_icon')
    expect(text).toContain('.dsh_ref_picker_icon')
    expect(text).toContain('.dsh_ref_settings')
    expect(text).toContain('button[data-dsh-ref-settings-icon]::before')
    expect(text).toContain('background:url("__REFERENCE_ANYTHING_MONO_LOGO_DATA_URI__") center/contain no-repeat')
    expect(text).toContain('image-rendering:auto')
    expect(text).toContain('body[data-ds-dark-theme] [data-shortcut-modal="settings"] nav button[data-dsh-ref-settings-icon]::before{filter:invert(1)}')
    expect(text).toContain('--dsh-ref-card-surface:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));--dsh-ref-control-surface:var(--dsw-alias-bg-layer-2,#363640)')
    expect(text).toContain('body[data-ds-dark-theme] .dsh_ref_workspace>.dsh_ref_panel,body[data-ds-dark-theme] .dsh_ref_workspace>.dsh_ref_sources{background:#242428}')
    expect(text).toContain('body[data-ds-dark-theme] .dsh_ref_settings .dsh_ref_general_settings{background:var(--dsw-alias-bg-layer-2)}')
    expect(text).toContain('body[data-ds-dark-theme] .dsh_ref_picker_list{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}')
    expect(text).toContain('.dsh_ref_settings .dsh_ref_settings_card{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xl)!important;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));overflow:hidden}')
    expect(text).toContain('.dsh_ref_header h2{font-size:20px;line-height:28px;font-weight:500}')
    expect(text).toContain('.dsh_ref_settings button,.dsh_ref_settings input,.dsh_ref_settings select,.dsh_ref_settings textarea{font-family:inherit}')
    expect(text).toContain('.dsh_ref_section_head p,.dsh_ref_storage_header p{font-size:12px;line-height:18px}')
    expect(text).toContain('.dsh_ref_form_grid>label>span,.dsh_ref_render_mode b{font-size:14px;line-height:22px;font-weight:400}')
    expect(text).toContain('.dsh_ref_form_grid>label>.dsh_ref_field_note,.dsh_ref_render_mode small,.dsh_ref_field_note{font-size:12px;line-height:18px}')
    expect(text).toContain('.dsh_ref_manage_meta,.dsh_ref_badge,.dsh_ref_manage_row_actions a,.dsh_ref_manage_row_actions button,.dsh_ref_pagination{font-size:12px;line-height:18px}')
    expect(text).toContain('.dsh_ref_provider_summary{grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;align-items:baseline;gap:4px 8px}')
    expect(text).toContain('.dsh_ref_provider_summary>small{grid-column:1 / -1;grid-row:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}')
    expect(text).not.toContain('.dsh_ref_panel.dsh_ref_general_settings{padding:0;border:0')
    expect(text).toContain('grid-template-columns:minmax(150px,1fr) auto auto auto')
    expect(text).toContain('[data-decoration="chip"][data-dsh-ref-chip-icon]')
    expect(text).toContain('[data-composer-chip][data-dsh-ref-chip-icon]')
    expect(text).toContain('--dsh-ref-chip-icon-mask')
    expect(text).toContain('width:min(100%,760px)')
    expect(text).toContain('min-height:68px;padding:16px 0;border:0;border-bottom:.5px solid var(--dsh-ref-line)')
    expect(text).toContain('grid-template-columns:repeat(2,minmax(0,1fr));gap:10px')
    expect(text).toContain('border:.5px solid var(--dsh-ref-card-stroke);border-radius:var(--dsw-radius-xl,16px)')
    expect(text).not.toContain('[data-decoration="text-ref"]')
    expect(text).not.toContain('dsh_ref_adaptive_caret')
    expect(text).not.toContain('dsh_ref_message_reference')
    expect(text).not.toContain('dsh_ref_menu_sync')
    expect(text).not.toContain('dsh_ref_menu_expand')
  })

  it('projects Provider, file, and DSH-session logos inside the @ menu', () => {
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

  it('projects Agent and drive source logos inside the @ menu', () => {
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

  it('projects the same logos into DSH alpha empty icon slots', () => {
    document.body.innerHTML = `<div data-composer-card><div role="listbox">
      <div role="presentation" data-source="External conversations">External conversations</div>
      <button role="option"><span></span><span>Design chat</span><span>Claude · today</span></button>
      <div role="presentation" data-source="Local agent conversations">Local agent conversations</div>
      <button role="option"><span></span><span>Task</span><span>Codex · today</span></button>
      <div role="presentation" data-source="Files and folders">Files and folders</div>
      <button role="option"><span></span><span>index.ts</span><span>index.ts</span></button>
    </div></div>`
    const dispose = adoptReferenceIconProjection()
    expect(document.querySelector('[data-dsh-ref-menu-icon="claude"] > svg')).not.toBeNull()
    expect(document.querySelector('[data-dsh-ref-menu-icon="codex"] > svg')).not.toBeNull()
    expect(document.querySelector('[data-dsh-ref-menu-icon="code"] > svg')).not.toBeNull()
    dispose()
  })

  it('repaints a reused alpha row when its provider changes', async () => {
    document.body.innerHTML = `<div data-composer-card><div role="listbox">
      <div role="presentation" data-source="External conversations">External conversations</div>
      <button role="option"><span></span><span>Chat</span><span>Claude · today</span></button>
    </div></div>`
    const dispose = adoptReferenceIconProjection()
    const option = document.querySelector('[role="option"]')!
    const description = option.children.item(2)!
    description.textContent = 'ChatGPT · today'
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(option.querySelector('[data-dsh-ref-menu-icon="chatgpt"]')).not.toBeNull()
    dispose()
  })

  it('reuses Provider and file-type menu glyphs without changing chip geometry nodes', () => {
    document.body.innerHTML = `
      <div data-composer-card>
        <span id="conversation" data-decoration="chip" data-reference-appearance="session" data-reference-source="External conversations">
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

  it('projects Provider logos into DSH alpha Composer chips', () => {
    document.body.innerHTML = `<div data-composer-card><span id="alpha" data-composer-chip="External conversations" contenteditable="false">
      <span><svg width="14" height="14"></svg><span>ChatGPT·Design</span></span>
    </span></div>`
    const chip = document.getElementById('alpha')!
    const dispose = adoptReferenceIconProjection()
    expect(chip.dataset.dshRefChipIcon).toBe('chatgpt')
    expect(chip.style.getPropertyValue('--dsh-ref-chip-icon-mask')).toContain('data:image/svg+xml')
    dispose()
  })

  it('keeps ChatGPT logos for both Web and local-import references', () => {
    document.body.innerHTML = `<div data-composer-card>
      <div role="listbox"><div role="option"><span>\uE125</span><span>调研</span></div></div>
      <span id="web-gpt" data-composer-chip="External conversations"><span><svg></svg><span>ChatGPT·调研</span></span></span>
      <span id="local-gpt" data-decoration="chip" data-reference-appearance="session" data-reference-source="Local agent conversations">ChatGPT·调研</span>
    </div>`
    const dispose = adoptReferenceIconProjection()
    for (const id of ['web-gpt', 'local-gpt']) {
      const chip = document.getElementById(id)!
      expect(chip.dataset.dshRefChipIcon).toBe('chatgpt')
      expect(decodeURIComponent(chip.style.getPropertyValue('--dsh-ref-chip-icon-mask'))).toContain('M9.205 8.658')
    }
    expect(document.querySelector('[role="option"] svg path')?.getAttribute('d')).toContain('M9.205 8.658')
    dispose()
  })

  it('projects file types into DSH alpha Composer chips', () => {
    document.body.innerHTML = `<div data-composer-card><span id="alpha-file" data-composer-chip="Files and folders" contenteditable="false">
      <span><svg width="14" height="14"></svg><span>07_Customer_Feedback.csv</span></span>
    </span></div>`
    const chip = document.getElementById('alpha-file')!
    const dispose = adoptReferenceIconProjection()
    expect(chip.dataset.dshRefChipIcon).toBe('spreadsheet')
    dispose()
  })

  it('projects local-agent chips with their logo without confusing same-named Web providers', () => {
    document.body.innerHTML = `<div data-composer-card>
      <span id="agent" data-decoration="chip" data-reference-appearance="session" data-reference-source="Local agent conversations"><span><svg/></span><span>Kimi CLI·Agent task</span></span>
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

  it('projects a logo when React inserts an option inside an existing listbox', async () => {
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

  it('reprojects the logo when a refreshed result reuses an indexed menu row', async () => {
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

  it('leaves source headings to the native menu layout', () => {
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
      expect(style.position).toBe('')
      expect(style.top).toBe('')
      expect(style.zIndex).toBe('')
      expect(style.paddingTop).toBe('')
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
