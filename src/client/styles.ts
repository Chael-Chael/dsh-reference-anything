import type { ChatProvider } from '../wire.ts'
import { PROVIDER_ICON_MARKER, PROVIDER_ICON_PATH } from './provider-icons.tsx'

const css = `
/* The unified @ trigger menu is owned by DSH, but the plugin can style its
   public ARIA/data contract without depending on generated CSS-module names. */
[data-composer-card] [role="listbox"]:has([role="presentation"][data-source]){box-sizing:border-box!important;width:100%!important;min-width:0!important;max-width:100%!important;border-radius:22px!important}
[data-composer-card] [role="listbox"] [role="presentation"][data-source]:not(:first-child){margin-top:4px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-inverted)}
/* Codex-like inline references: no filled rounded rectangle. The label uses
   the same semantic blue as DSH's send button/caret and is allowed to show
   its complete title instead of the core chip's ellipsis projection. */
[data-composer-card] [data-decoration="chip"]{display:inline-flex!important;align-items:center!important;width:max-content!important;min-width:4em;border-radius:0!important;background:transparent!important;overflow:visible!important;vertical-align:baseline}
[data-composer-card] [data-decoration="chip"]:before{display:none!important}
[data-composer-card] [data-decoration="chip"]>span{position:static!important;width:max-content!important;max-width:none!important;justify-content:flex-start!important;overflow:visible!important;color:var(--dsw-alias-state-business-primary)!important;font-family:inherit!important;font-size:inherit!important;line-height:inherit!important;font-weight:600;transform:none!important;z-index:2}
.dsh_ref_projected_icon{display:inline-flex!important;align-items:center;gap:.35em}.dsh_ref_projected_icon:before{content:"";display:inline-block;flex:none;width:1em;height:1em;background:currentColor;mask:var(--dsh-ref-provider-icon) center/contain no-repeat;-webkit-mask:var(--dsh-ref-provider-icon) center/contain no-repeat}
[data-composer-card] [data-decoration="text-ref"]{border-radius:0!important;background:transparent!important;color:var(--dsw-alias-state-business-primary)!important;font-family:inherit!important;font-size:inherit!important;line-height:inherit!important;font-weight:600;box-shadow:none!important}
[data-composer-card] [data-decoration="text-ref"]:before,[data-composer-card] [data-decoration="text-ref"]:after{display:none!important}
.dsh_ref_native_caret_hidden{caret-color:transparent!important}.dsh_ref_adaptive_caret{position:fixed;z-index:9999;box-sizing:border-box;width:1px;margin:0;padding:0;border:0;border-radius:0;pointer-events:none;background:var(--dsw-alias-state-business-primary);opacity:1;animation:dsh_ref_caret_blink 1.06s step-end infinite;transform:translateZ(0)}.dsh_ref_adaptive_caret[hidden]{display:none!important}@keyframes dsh_ref_caret_blink{0%,49.99%{opacity:1}50%,100%{opacity:0}}
.dsh_ref_message_reference{display:inline-flex;align-items:center;gap:6px;max-width:100%;color:#82b1e4;font-weight:600;white-space:nowrap;vertical-align:baseline}.dsh_ref_message_reference:before{content:"";display:inline-block;flex:none;width:20px;height:20px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' d='M20 11.5a8 8 0 0 1-8.5 8A8.9 8.9 0 0 1 7.7 18.6L3.5 20l1.4-3.7A8 8 0 1 1 20 11.5Z'/%3E%3C/svg%3E") center/contain no-repeat}
.dsh_ref_rail{display:flex;flex-wrap:wrap;gap:8px;width:calc(100% - var(--dsh-composer-side-clearance)*2);max-width:var(--dsh-composer-card-max-width);margin:0 auto}.dsh_ref_chip{display:inline-flex;align-items:center;min-height:28px}.dsh_ref_open,.dsh_ref_remove{border:0;background:none;font:inherit;cursor:pointer}.dsh_ref_open{display:flex;align-items:center;gap:6px;padding:0;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#82b1e4;font-size:18px;font-weight:600;line-height:28px}.dsh_ref_chip_mark{display:inline-flex;flex:none;width:20px;height:20px}.dsh_ref_chip_mark svg{width:100%;height:100%}.dsh_ref_remove{width:20px;padding:0;color:var(--dsw-alias-label-dimmed);font-size:17px;line-height:1}
.dsh_ref_settings{display:flex;flex-direction:column;gap:18px;width:min(100%,1060px);padding:0 0 36px;color:var(--dsw-alias-label-primary);font-family:Geist,"Segoe UI",sans-serif}.dsh_ref_settings *{box-sizing:border-box}.dsh_ref_header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:0 0 10px}.dsh_ref_header h2{margin:0 0 7px;font-size:28px;line-height:1.1;letter-spacing:-.035em}.dsh_ref_header p{margin:0;max-width:620px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}.dsh_ref_settings button{min-height:34px;padding:0 13px;border:1px solid var(--dsw-alias-label-primary);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:650;cursor:pointer}.dsh_ref_settings button:hover:not(:disabled){background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}.dsh_ref_settings button:active:not(:disabled){transform:translateY(1px)}.dsh_ref_settings button:disabled{cursor:not-allowed;opacity:.42}
.dsh_ref_workspace{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent;overflow:hidden}.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{margin:0;padding:24px;border:0;border-bottom:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent}.dsh_ref_workspace>.dsh_ref_panel:last-child{border-bottom:0}.dsh_ref_workspace>.dsh_ref_error{margin:20px 24px 0}.dsh_ref_section_head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.dsh_ref_section_head h3{margin:0 0 4px;font-size:17px;letter-spacing:-.02em}.dsh_ref_section_head p{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.45}.dsh_ref_health,.dsh_ref_syncing{display:inline-flex;align-items:center;min-height:25px;padding:0 9px;border:1px solid var(--dsw-alias-label-primary);border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary);font-size:10px;font-weight:700}
.dsh_ref_checklist{display:grid;gap:14px;margin-top:20px}.dsh_ref_check{display:flex;align-items:flex-start;gap:11px;min-height:40px}.dsh_ref_check>span{display:grid;place-items:center;flex:none;width:22px;height:22px;margin-top:2px;border:1px solid var(--dsw-alias-label-primary);border-radius:50%;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;font-weight:800}.dsh_ref_check div{display:grid;min-width:0;gap:2px}.dsh_ref_check strong{font-size:13px}.dsh_ref_check small{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-size:11px;opacity:.7}.dsh_ref_install{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:20px;padding:14px;border:1px solid var(--dsw-alias-label-primary);background:transparent}.dsh_ref_install>div{display:grid;gap:3px}.dsh_ref_install strong{font-size:12px}.dsh_ref_install span{color:var(--dsw-alias-label-primary);font-size:11px;opacity:.7}.dsh_ref_service_actions{display:flex!important;flex:none;gap:8px}.dsh_ref_error{display:grid;gap:4px;padding:13px;border:1px solid var(--dsw-alias-label-primary);background:transparent;color:var(--dsw-alias-label-primary);font-size:11px}.dsh_ref_skeleton{display:grid;gap:12px;margin-top:20px}.dsh_ref_skeleton i{height:40px;border:1px solid var(--dsw-alias-label-primary);opacity:.25}
.dsh_ref_sources{display:grid;gap:17px}.dsh_ref_provider_grid{display:grid;grid-template-columns:1fr;gap:0;border:1px solid var(--dsw-alias-label-primary)}.dsh_ref_provider{display:grid;grid-template-columns:34px minmax(96px,1fr) auto minmax(150px,1.3fr) auto;align-items:center;min-width:0;padding:12px 14px;border:0;border-bottom:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent}.dsh_ref_provider:last-child{border-bottom:0}.dsh_ref_provider_top{display:contents}.dsh_ref_provider_mark{display:grid;grid-column:1;place-items:center;width:30px;height:30px;border:1px solid var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary)}.dsh_ref_provider_top>span:not(.dsh_ref_provider_mark):not(.dsh_ref_status_dot){display:none}.dsh_ref_status_dot{display:none}.dsh_ref_provider h4{grid-column:2;margin:0;font-size:13px}.dsh_ref_provider>strong{grid-column:3;font-family:"Geist Mono",Consolas,monospace;font-size:18px}.dsh_ref_provider>p{display:none}.dsh_ref_provider>small{grid-column:4;margin:0;color:var(--dsw-alias-label-primary);font-size:10px;opacity:.7}.dsh_ref_provider>em{display:none}.dsh_ref_provider_foot{display:contents}.dsh_ref_provider_foot>span{display:none}.dsh_ref_provider_foot button{grid-column:5;min-height:29px;padding:0 10px;font-size:10px}.dsh_ref_empty{padding:20px;border:1px dashed var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-size:11px;text-align:center}
.dsh_ref_general_settings{display:grid;gap:16px}.dsh_ref_picker_list{border:1px solid var(--dsw-alias-label-primary)}.dsh_ref_picker_row{display:grid;grid-template-columns:minmax(170px,1fr) auto auto;align-items:center;gap:14px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-label-primary)}.dsh_ref_picker_row:last-child{border-bottom:0}.dsh_ref_picker_row>label:first-child{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:650}.dsh_ref_picker_row input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-label-primary)}.dsh_ref_picker_limit{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-primary);font-size:10px}.dsh_ref_picker_limit select{height:30px;min-width:58px;padding:0 6px;border:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent;color:var(--dsw-alias-label-primary);font:11px Geist,"Segoe UI",sans-serif}.dsh_ref_picker_order{display:flex;gap:5px}.dsh_ref_picker_order button{min-width:30px;min-height:30px;padding:0;font-size:15px;line-height:1}
.dsh_ref_sync_settings{display:grid;gap:20px}.dsh_ref_form_grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.dsh_ref_form_grid label{display:grid;gap:6px}.dsh_ref_form_grid label>span{font-size:11px;font-weight:650}.dsh_ref_form_grid input,.dsh_ref_form_grid select{width:100%;height:36px;padding:0 10px;border:1px solid var(--dsw-alias-label-primary);border-radius:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:12px Geist,"Segoe UI",sans-serif}.dsh_ref_form_grid input:focus,.dsh_ref_form_grid select:focus{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.dsh_ref_form_grid input[aria-invalid=true]{border-style:dashed}.dsh_ref_form_grid select:disabled{opacity:.42}.dsh_ref_toggle{display:flex!important;flex-direction:row!important;align-items:center;gap:8px;cursor:pointer}.dsh_ref_toggle input{position:absolute;opacity:0}.dsh_ref_toggle>span{position:relative;width:32px;height:18px;border:1px solid var(--dsw-alias-label-primary);border-radius:9px;background:transparent}.dsh_ref_toggle>span:after{content:"";position:absolute;top:3px;left:3px;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .18s}.dsh_ref_toggle input:checked+span:after{transform:translateX(14px)}.dsh_ref_toggle b{font-size:11px}.dsh_ref_actions{display:flex;flex-wrap:wrap;gap:8px}.dsh_ref_actions .is_primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}.dsh_ref_actions .is_danger{border-style:dashed}.dsh_ref_inline_error,.dsh_ref_auto_note{margin:0;color:var(--dsw-alias-label-primary);font-size:11px}.dsh_ref_auto_note{opacity:.7}.dsh_ref_notice{padding:10px 0;border-bottom:1px solid var(--dsw-alias-label-primary);font-size:11px}
.dsh_ref_progress_wrap{display:grid;gap:6px;margin-top:4px}.dsh_ref_progress_track{height:6px;border:1px solid var(--dsw-alias-label-primary);background:transparent;overflow:hidden}.dsh_ref_progress_fill{height:100%;background:var(--dsw-alias-label-primary);transition:width .2s ease}.dsh_ref_progress_fill.is_failed,.dsh_ref_progress_fill.is_cancelled{opacity:.4}.dsh_ref_progress_fill.is_partial{opacity:.7}.dsh_ref_progress_label{margin:0;color:var(--dsw-alias-label-primary);font-size:10px;text-transform:lowercase;opacity:.7}
.dsh_ref_manage{display:grid;gap:15px}.dsh_ref_manage_filters{display:grid;grid-template-columns:1fr 180px;gap:12px}.dsh_ref_manage_filters input,.dsh_ref_manage_filters select{width:100%;height:36px;padding:0 10px;border:1px solid var(--dsw-alias-label-primary);border-radius:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:12px Geist,"Segoe UI",sans-serif}.dsh_ref_manage_filters input:focus,.dsh_ref_manage_filters select:focus{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.dsh_ref_manage_empty{margin:0;padding:20px;border:1px dashed var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-size:11px;text-align:center}
.dsh_ref_manage_list{list-style:none;display:grid;gap:0;margin:0;padding:0;max-height:340px;overflow-y:auto;border:1px solid var(--dsw-alias-label-primary)}.dsh_ref_manage_row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 13px;border-bottom:1px solid var(--dsw-alias-label-primary)}.dsh_ref_manage_row:last-child{border-bottom:0}.dsh_ref_manage_main{display:grid;gap:3px;min-width:0}.dsh_ref_manage_title_row{display:flex;align-items:center;flex-wrap:wrap;gap:7px;min-width:0}.dsh_ref_manage_title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px;font-size:13px}.dsh_ref_manage_meta{color:var(--dsw-alias-label-primary);font-size:10px;opacity:.7}.dsh_ref_manage_row button{min-height:29px;padding:0 10px;font-size:10px;flex:none}.dsh_ref_manage_row .is_danger{border-style:dashed}
.dsh_ref_badge{padding:1px 7px;border:1px solid var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-size:10px;white-space:nowrap}.dsh_ref_badge.is_warn{border-style:dashed}
.dsh_ref_pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-primary);font-size:10px}.dsh_ref_pagination button{min-height:29px;padding:0 10px;font-size:10px}
@media(max-width:640px){.dsh_ref_manage_filters{grid-template-columns:1fr}.dsh_ref_manage_row{align-items:flex-start;flex-direction:column}.dsh_ref_manage_title{max-width:100%}}
@media(max-width:850px){.dsh_ref_provider_grid{grid-template-columns:1fr 1fr}}@media(max-width:640px){.dsh_ref_header,.dsh_ref_section_head,.dsh_ref_install{align-items:stretch;flex-direction:column}.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{padding:18px}.dsh_ref_provider_grid,.dsh_ref_form_grid,.dsh_ref_picker_row{grid-template-columns:1fr}.dsh_ref_picker_limit{justify-content:space-between}.dsh_ref_recheck,.dsh_ref_install button{align-self:flex-start}}
@media(prefers-reduced-motion:reduce){.dsh_ref_settings *{transition:none!important}}
`
export function adoptStyles(): void {
  if (document.getElementById('dsh-reference-anything-style')) return
  const style = document.createElement('style'); style.id = 'dsh-reference-anything-style'; style.textContent = css; document.head.appendChild(style)
}

/** Project opaque dsh-ref mentions in user bubbles without changing logged text. */
export function adoptConversationMentionProjection(): () => void {
  const mention = /@\[([^\n\r]+?)\]\(dsh-ref:[A-Za-z0-9_-]+\)/gu
  const project = (root: ParentNode): void => {
    const rows = root instanceof Element && root.matches('[data-time-hover-root]')
      ? [root]
      : Array.from(root.querySelectorAll('[data-time-hover-root]'))
    for (const row of rows) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      let current: Node | null
      while ((current = walker.nextNode()) !== null) {
        if (current.parentElement?.closest('[data-dsh-ref-projection]') === null && mention.test(current.textContent ?? '')) nodes.push(current as Text)
        mention.lastIndex = 0
      }
      for (const node of nodes) {
        const value = node.data
        const fragment = document.createDocumentFragment()
        let cursor = 0
        for (const match of value.matchAll(mention)) {
          fragment.append(value.slice(cursor, match.index))
          const span = document.createElement('span')
          span.className = 'dsh_ref_message_reference'
          span.dataset.dshRefProjection = 'conversation'
          span.textContent = match[1] ?? ''
          fragment.append(span)
          cursor = match.index + match[0].length
        }
        fragment.append(value.slice(cursor))
        node.replaceWith(fragment)
      }
    }
  }
  project(document)
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of Array.from(record.addedNodes)) {
      if (node instanceof Element) project(node)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => { observer.disconnect() }
}

/** Keep the visible caret aligned with content-sized reference labels. */
export function adoptAdaptiveChipCaret(): () => void {
  const caret = document.createElement('i')
  caret.className = 'dsh_ref_adaptive_caret'
  caret.hidden = true
  document.body.append(caret)
  let frame = 0
  let restartBlink = false
  let composing = false
  const schedule = (restart = false): void => {
    restartBlink ||= restart
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(update)
  }
  const update = (): void => {
    const input = document.activeElement
    if (!(input instanceof HTMLTextAreaElement) || input.selectionStart !== input.selectionEnd) return hide()
    const card = input.closest('[data-composer-card]')
    const backdrop = card?.querySelector('[data-input-backdrop]')
    if (!(backdrop instanceof HTMLElement) || backdrop.querySelector('[data-decoration="chip"]') === null) return hide()
    const range = rangeAtLogicalOffset(backdrop, input.selectionEnd)
    if (range === undefined) return hide()
    const measured = range.getBoundingClientRect()
    const rect = usableCaretRect(measured) ? measured : chipBoundaryRectAtLogicalOffset(backdrop, input.selectionEnd)
    if (rect === undefined) return hide()
    // Read the host caret colour without our own transparent override. On a
    // later update the class is already present; reading first would copy
    // `transparent` onto the painted caret and make it disappear.
    input.classList.remove('dsh_ref_native_caret_hidden')
    const style = getComputedStyle(input)
    const lineHeight = Number.parseFloat(style.lineHeight)
    const fontSize = Number.parseFloat(style.fontSize)
    const resolvedLineHeight = Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.2
    const resolvedFontSize = Number.isFinite(fontSize) ? fontSize : resolvedLineHeight
    // Chromium paints a textarea caret against the font's em box, centred in
    // the line box. Snap to physical pixels so a scaled/DPI display does not
    // turn the nominal one-pixel stem into a blurred 1.5px line.
    const ratio = window.devicePixelRatio || 1
    const snap = (value: number): number => Math.round(value * ratio) / ratio
    const caretHeight = snap(Math.min(resolvedLineHeight, resolvedFontSize))
    input.classList.add('dsh_ref_native_caret_hidden')
    caret.hidden = false
    caret.style.left = `${snap(rect.left)}px`
    caret.style.top = `${snap(rect.top + Math.max(0, (resolvedLineHeight - caretHeight) / 2))}px`
    caret.style.width = '1px'
    caret.style.height = `${caretHeight}px`
    // Some embedded Chromium builds expose the computed value as `auto`.
    // Keep the semantic CSS fallback in that case instead of assigning an
    // invalid background colour and making the caret disappear.
    if (style.caretColor !== '' && style.caretColor !== 'auto') caret.style.backgroundColor = style.caretColor
    else caret.style.removeProperty('background-color')
    if (restartBlink && !composing) {
      // Restart from the visible phase without depending on Web Animations,
      // which is missing in some WebView builds used by desktop shells.
      caret.style.animation = 'none'
      void caret.offsetWidth
      caret.style.removeProperty('animation')
    }
    restartBlink = false
  }
  const hide = (): void => {
    document.querySelectorAll('.dsh_ref_native_caret_hidden').forEach(node => node.classList.remove('dsh_ref_native_caret_hidden'))
    caret.hidden = true
  }
  const observer = new MutationObserver(() => schedule())
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  const passiveEvents = ['selectionchange', 'focusout', 'scroll'] as const
  const activeEvents = ['input', 'keyup', 'pointerup', 'focusin'] as const
  const onPassive = (): void => { schedule() }
  const onActive = (): void => { schedule(true) }
  const onCompositionStart = (): void => { composing = true; schedule(true) }
  const onCompositionEnd = (): void => { composing = false; schedule(true) }
  for (const event of passiveEvents) document.addEventListener(event, onPassive, true)
  for (const event of activeEvents) document.addEventListener(event, onActive, true)
  document.addEventListener('compositionstart', onCompositionStart, true)
  document.addEventListener('compositionend', onCompositionEnd, true)
  schedule()
  return () => {
    cancelAnimationFrame(frame)
    observer.disconnect()
    for (const event of passiveEvents) document.removeEventListener(event, onPassive, true)
    for (const event of activeEvents) document.removeEventListener(event, onActive, true)
    document.removeEventListener('compositionstart', onCompositionStart, true)
    document.removeEventListener('compositionend', onCompositionEnd, true)
    hide()
    caret.remove()
  }
}

/** Render one shared provider SVG in both the @ menu and the selected chip. */
export function adoptReferenceIconProjection(): () => void {
  const providers = Object.keys(PROVIDER_ICON_MARKER) as ChatProvider[]
  const project = (root: ParentNode): void => {
    const nodes = root instanceof Element && root.matches('span') ? [root] : Array.from(root.querySelectorAll('span'))
    for (const node of nodes) {
      const text = node.textContent ?? ''
      const provider = providers.find(key => text.startsWith(PROVIDER_ICON_MARKER[key]))
      if (provider === undefined) continue
      node.textContent = text.slice(PROVIDER_ICON_MARKER[provider].length).trimStart()
      node.classList.add('dsh_ref_projected_icon')
      node.setAttribute('data-dsh-ref-provider-icon', provider)
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${PROVIDER_ICON_PATH[provider]}"/></svg>`
      node.setAttribute('style', `${node.getAttribute('style') ?? ''};--dsh-ref-provider-icon:url("data:image/svg+xml,${encodeURIComponent(svg)}")`)
      const chip = node.closest('[data-decoration="chip"]')
      if (chip !== null) chip.setAttribute('title', node.textContent ?? '')
    }
  }
  project(document)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData' && record.target.parentElement !== null) project(record.target.parentElement)
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element) project(node)
        else if (node.parentElement !== null) project(node.parentElement)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => { observer.disconnect() }
}

function usableCaretRect(rect: DOMRect): boolean {
  return rect.height > 0 || rect.top !== 0 || rect.left !== 0
}

/** Fallback for Chromium returning an empty collapsed Range immediately after a chip. */
function chipBoundaryRectAtLogicalOffset(root: HTMLElement, target: number): Pick<DOMRect, 'left' | 'top'> | undefined {
  let logical = 0
  const visit = (parent: Node): Pick<DOMRect, 'left' | 'top'> | undefined => {
    for (const child of Array.from(parent.childNodes)) {
      if (child instanceof Element && child.matches('[data-decoration="chip"]')) {
        const chip = child.getBoundingClientRect()
        if (target === logical) return { left: chip.left, top: chip.top }
        logical += 1
        if (target === logical) return { left: chip.right, top: chip.top }
        continue
      }
      if (child instanceof Text) { logical += child.data.length; continue }
      const found = visit(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  return visit(root)
}

function rangeAtLogicalOffset(root: HTMLElement, target: number): Range | undefined {
  const range = document.createRange()
  let logical = 0
  const visit = (parent: Node): boolean => {
    for (const child of Array.from(parent.childNodes)) {
      if (child instanceof Element && child.matches('[data-decoration="chip"]')) {
        if (target <= logical) { range.setStartBefore(child); range.collapse(true); return true }
        logical += 1
        if (target <= logical) { range.setStartAfter(child); range.collapse(true); return true }
        continue
      }
      if (child instanceof Text) {
        const end = logical + child.data.length
        if (target <= end) { range.setStart(child, Math.max(0, target - logical)); range.collapse(true); return true }
        logical = end
        continue
      }
      if (visit(child)) return true
    }
    return false
  }
  if (visit(root)) return range
  range.selectNodeContents(root)
  range.collapse(false)
  return range
}
