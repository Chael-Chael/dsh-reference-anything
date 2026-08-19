// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { adoptAdaptiveChipHitTesting, adoptAdaptiveChipInsertionCaret, adoptAdaptiveChipKeyboardNavigation, adoptAdaptiveComposerHeight, adoptConversationMentionProjection, adoptConversationSyncActionProjection, adoptMenuExpansionProjection, adoptMenuGroupTitleProjection, adoptReferenceIconProjection, adoptStyles, logicalOffsetAtDomPoint, rangeBetweenLogicalOffsets, refreshActiveTriggerMenu, visualCaretRectAtLogicalOffset, visualCaretTop, wordRangeAtLogicalOffset } from '../src/client/styles.ts'
import { syncProgressFraction, type SyncStatus } from '../src/client/remote.ts'

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
    expect(text).toContain('[data-decoration="chip"]>span{position:static!important')
    expect(text).toContain('font-size:inherit!important')
    expect(text).toContain('line-height:inherit!important;letter-spacing:inherit!important')
    expect(text).toContain('letter-spacing:inherit!important;font-weight:inherit!important;transform:none!important')
    expect(text).not.toContain('letter-spacing:inherit!important;font-weight:600')
    expect(text).toContain('[data-composer-card] .dsh_ref_conversation_chip')
    expect(text).toContain('[data-decoration="chip"]>.dsh_ref_picker_icon:before{background:var(--dsw-alias-state-business-primary,#3b82f6)!important}')
    expect(text).toContain('.dsh_ref_projected_icon{display:inline!important}')
    expect(text).toContain('.dsh_ref_picker_icon{display:inline!important}')
    expect(text).toContain('margin-right:.35em;vertical-align:-.125em')
    expect(text).toContain('.dsh_ref_picker_icon:before{content:"";display:inline-block')
    expect(text).toContain('[role="listbox"] :is(.dsh_ref_projected_icon,.dsh_ref_picker_icon){display:inline-flex!important;align-items:center!important;justify-content:center!important')
    expect(text).toContain('[role="listbox"] :is(.dsh_ref_projected_icon,.dsh_ref_picker_icon):before{display:block;width:16px;height:16px;margin:0;vertical-align:0}')
    expect(text).not.toContain('.dsh_ref_conversation_chip>.dsh_ref_projected_icon:before{transform:translateY(.2em)!important}')
    expect(text).not.toContain('[data-decoration="chip"]>.dsh_ref_session_icon:before{transform:translateY(.2em)!important')
    expect(text).toContain('[role="listbox"] .dsh_ref_projected_icon:before{background:var(--dsw-alias-label-tertiary,#8b8f98)}')
    expect(text).toContain('[role="dialog"]:has(.dsh_ref_settings){overflow:clip!important}')
    expect(text).toContain('.dsh_ref_toggle{position:relative}')
    expect(text).not.toContain('.dsh_ref_conversation_chip,.dsh_ref_conversation_chip>span,.dsh_ref_projected_icon{color:')
    expect(text).toContain('.dsh_ref_adaptive_caret')
    expect(text).toContain('[data-dsh-ref-height-ruler]')
    expect(text).toContain('dsh_ref_caret_blink')
    expect(text).not.toContain('.dsh_ref_chip{')
    expect(text).toContain('.dsh_ref_menu_sync{position:relative')
    expect(text).toContain('border-radius:999px;background:rgba(59,130,246,.11)')
    expect(text).toContain('.dsh_ref_notice_layer{position:sticky;top:12px;z-index:20;display:flex;align-items:flex-start')
    expect(text).not.toContain('.dsh_ref_notice{position:fixed')
    expect(text).toContain('background:var(--dsh-ref-blue);color:#fff;animation:dsh_ref_notice_drop')
    expect(text).toContain('@keyframes dsh_ref_notice_drop')
    expect(text).toContain('.dsh_ref_render_mode{display:flex')
    expect(text).toContain('.dsh_ref_header_brand{display:flex;align-items:flex-start;gap:14px}')
    expect(text).toContain('.dsh_ref_field_note,.dsh_ref_render_mode small{color:#64748b}')
    expect(text).toContain('.dsh_ref_menu_expand{display:block')
    expect(text).toContain('font:400 14px/22px Geist')
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
    document.body.innerHTML = '<div role="listbox"><span>\uE101</span></div><span data-decoration="chip"><span>\uE101 Claude·Design</span></span>'
    const dispose = adoptReferenceIconProjection()
    const projected = document.querySelectorAll('[data-dsh-ref-provider-icon="claude"]')
    expect(projected).toHaveLength(2)
    expect(projected[0]?.textContent).toBe('')
    expect(projected[1]?.textContent).toBe('Claude·Design')
    const chip = document.querySelector('[data-decoration="chip"]')
    expect(chip?.getAttribute('title')).toBe('Claude·Design')
    expect(chip?.classList.contains('dsh_ref_conversation_chip')).toBe(true)
    expect(chip?.getAttribute('data-dsh-ref-provider')).toBe('claude')
    expect(chip?.querySelector('span')?.textContent).toBe('Claude·Design')
    expect(chip?.querySelector('span')?.classList.contains('dsh_ref_projected_icon')).toBe(true)
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

  it('lets the visual chip ruler drive native auto-grow and restores the native mirror without chips', async () => {
    document.body.innerHTML = '<div data-composer-card><div class="grow"><div data-input-backdrop><span data-decoration="chip"><span>Long reference title</span></span></div><div data-input-mirror></div></div></div>'
    const backdrop = document.querySelector('[data-input-backdrop]') as HTMLElement
    const mirror = document.querySelector('[data-input-mirror]') as HTMLElement
    mirror.getBoundingClientRect = () => ({ width: 320, height: 64, left: 0, right: 320, top: 0, bottom: 64, x: 0, y: 0, toJSON() {} })
    const dispose = adoptAdaptiveComposerHeight()
    try {
      await new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
      const ruler = document.querySelector('[data-dsh-ref-height-ruler]')
      expect(ruler).not.toBeNull()
      expect(ruler?.textContent).toBe('Long reference title\n')
      expect((ruler as HTMLElement).style.getPropertyValue('--dsh-ref-native-min-height')).toBe('64px')
      expect(mirror.style.position).toBe('absolute')
      expect(mirror.style.inset).toBe('0')
      backdrop.querySelector('[data-decoration="chip"]')?.remove()
      await new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
      expect(document.querySelector('[data-dsh-ref-height-ruler]')).toBeNull()
      expect(mirror.style.position).toBe('')
    } finally {
      dispose()
    }
  })

  it('keeps the adaptive caret on the textarea line grid after many wrapped lines', () => {
    expect(visualCaretTop(100, 4, 106, 24, 20)).toBe(106)
    expect(visualCaretTop(100, 4, 106 + 9 * 24, 24, 20)).toBe(106 + 9 * 24)
    // Ink metrics may report a small per-font offset, but it must not alter the
    // selected line or accumulate with its index.
    expect(visualCaretTop(100, 4, 108 + 9 * 24, 24, 20)).toBe(106 + 9 * 24)
  })

  it('maps visual text and full-width chip clicks back to logical textarea offsets', () => {
    document.body.innerHTML = '<div data-input-backdrop>ab<span data-decoration="chip"><span>Very long reference</span></span>cde</div>'
    const root = document.querySelector('[data-input-backdrop]') as HTMLElement
    const chip = root.querySelector('[data-decoration="chip"]') as HTMLElement
    const trailing = root.lastChild as Text
    chip.getBoundingClientRect = () => ({ left: 20, right: 220, width: 200, top: 0, bottom: 24, height: 24, x: 20, y: 0, toJSON() {} })
    expect(logicalOffsetAtDomPoint(root, chip.firstChild as Node, 4, 30)).toBe(2)
    expect(logicalOffsetAtDomPoint(root, chip.firstChild as Node, 4, 210)).toBe(3)
    expect(logicalOffsetAtDomPoint(root, trailing, 2, 240)).toBe(5)
  })

  it('moves the real textarea caret to the clicked visual chip edge', () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-backdrop>ab<span data-decoration="chip"><span>Very long reference</span></span>cde</div><textarea>ab\uFFFCcde</textarea></div>'
    const input = document.querySelector('textarea')!
    const chip = document.querySelector('[data-decoration="chip"]') as HTMLElement
    chip.getBoundingClientRect = () => ({ left: 20, right: 220, width: 200, top: 0, bottom: 24, height: 24, x: 20, y: 0, toJSON() {} })
    const point = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: chip.firstChild as Node, offset: 4 }) })
    const dispose = adoptAdaptiveChipHitTesting()
    try {
      input.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 210, clientY: 12, bubbles: true }))
      input.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 210, clientY: 12, bubbles: true }))
      expect(input.selectionStart).toBe(3)
      expect(input.selectionEnd).toBe(3)
    } finally {
      dispose()
      if (point) Object.defineProperty(document, 'caretPositionFromPoint', point)
      else delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
    }
  })

  it('maps a dragged visual selection across a chip to logical textarea endpoints', () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-backdrop>ab<span data-decoration="chip"><span>Very long reference</span></span>cde</div><textarea>ab\uFFFCcde</textarea></div>'
    const input = document.querySelector('textarea')!
    const root = document.querySelector('[data-input-backdrop]') as HTMLElement
    const leading = root.firstChild as Text
    const trailing = root.lastChild as Text
    const point = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: (x: number) => x < 100 ? { offsetNode: leading, offset: 1 } : { offsetNode: trailing, offset: 2 },
    })
    const dispose = adoptAdaptiveChipHitTesting()
    try {
      input.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 20, clientY: 12, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 240, clientY: 12, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 240, clientY: 12, bubbles: true, cancelable: true }))
      expect(input.selectionStart).toBe(1)
      expect(input.selectionEnd).toBe(5)
      expect(rangeBetweenLogicalOffsets(root, 1, 5)?.toString()).toBe('bVery long referencecd')
    } finally {
      dispose()
      if (point) Object.defineProperty(document, 'caretPositionFromPoint', point)
      else delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
    }
  })

  it('maps line-end whitespace and scrolled visual lines without native placeholder fallback', () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-backdrop style="padding-top:4px">ab<span data-decoration="chip"><span>Long reference</span></span>cd\nef</div><textarea style="font-size:16px;line-height:24px">ab\uFFFCcd\nef</textarea></div>'
    const input = document.querySelector('textarea')!
    const backdrop = document.querySelector('[data-input-backdrop]') as HTMLElement
    const chip = backdrop.querySelector('[data-decoration="chip"]') as HTMLElement
    const leading = backdrop.firstChild as Text
    const trailing = backdrop.lastChild as Text
    let scrollShift = 0
    backdrop.getBoundingClientRect = () => rect(0, 96 - scrollShift, 320, 72)
    chip.getBoundingClientRect = () => rect(40, 100 - scrollShift, 70, 20)
    const nativeRect = Range.prototype.getBoundingClientRect
    Range.prototype.getBoundingClientRect = function () {
      if (this.startContainer === leading) return rect(10 + this.startOffset * 10, 100 - scrollShift, 10, 20)
      if (this.startContainer === trailing) {
        if (this.startOffset === 2) return rect(0, 0, 0, 0)
        const secondLine = this.startOffset >= 3
        return rect((secondLine ? 10 : 110) + (secondLine ? this.startOffset - 3 : this.startOffset) * 10, (secondLine ? 124 : 100) - scrollShift, 10, 20)
      }
      return rect(0, 0, 0, 0)
    }
    const point = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: backdrop, offset: backdrop.childNodes.length }) })
    const dispose = adoptAdaptiveChipHitTesting()
    try {
      input.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 260, clientY: 110, bubbles: true }))
      input.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 260, clientY: 110, bubbles: true }))
      expect(input.selectionStart).toBe(5)
      expect(input.selectionEnd).toBe(5)

      scrollShift = 48
      input.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 11, clientY: 86, bubbles: true }))
      input.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 11, clientY: 86, bubbles: true }))
      expect(input.selectionStart).toBe(6)
      expect(input.selectionEnd).toBe(6)
    } finally {
      dispose()
      Range.prototype.getBoundingClientRect = nativeRect
      if (point) Object.defineProperty(document, 'caretPositionFromPoint', point)
      else delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
    }
  })

  it('uses the following text line for a caret immediately after a chip', () => {
    document.body.innerHTML = '<div data-input-backdrop><span data-decoration="chip"><span>Long reference</span></span>after</div>'
    const root = document.querySelector('[data-input-backdrop]') as HTMLElement
    const chip = root.querySelector('[data-decoration="chip"]') as HTMLElement
    const trailing = root.lastChild as Text
    chip.getBoundingClientRect = () => rect(10, 100, 80, 20)
    const nativeRect = Range.prototype.getBoundingClientRect
    Range.prototype.getBoundingClientRect = function () {
      if (this.startContainer === trailing && !this.collapsed) return rect(10, 124, 10, 20)
      if (this.collapsed) return rect(10, 100, 0, 0)
      return rect(0, 0, 0, 0)
    }
    try {
      expect(visualCaretRectAtLogicalOffset(root, 1)?.top).toBe(124)
    } finally {
      Range.prototype.getBoundingClientRect = nativeRect
    }
  })

  it('uses the following glyph line at a soft-wrap boundary', () => {
    document.body.innerHTML = '<div data-input-backdrop>ab</div>'
    const root = document.querySelector('[data-input-backdrop]') as HTMLElement
    const text = root.firstChild as Text
    const nativeRect = Range.prototype.getBoundingClientRect
    Range.prototype.getBoundingClientRect = function () {
      if (this.startContainer === text && !this.collapsed) return rect(this.startOffset === 0 ? 80 : 10, this.startOffset === 0 ? 100 : 124, 10, 20)
      if (this.collapsed) return rect(10, 100, 0, 0)
      return rect(0, 0, 0, 0)
    }
    try {
      expect(visualCaretRectAtLogicalOffset(root, 1)?.top).toBe(124)
    } finally {
      Range.prototype.getBoundingClientRect = nativeRect
    }
  })

  it('preserves both native caret affinities at a soft-wrap boundary', () => {
    document.body.innerHTML = '<div data-input-backdrop>ab</div>'
    const root = document.querySelector('[data-input-backdrop]') as HTMLElement
    const text = root.firstChild as Text
    const nativeRect = Range.prototype.getBoundingClientRect
    Range.prototype.getBoundingClientRect = function () {
      if (this.startContainer === text && !this.collapsed) return rect(this.startOffset === 0 ? 80 : 10, this.startOffset === 0 ? 100 : 124, 10, 20)
      return rect(0, 0, 0, 0)
    }
    try {
      expect(visualCaretRectAtLogicalOffset(root, 1, 'backward')).toMatchObject({ left: 90, top: 100 })
      expect(visualCaretRectAtLogicalOffset(root, 1, 'forward')).toMatchObject({ left: 10, top: 124 })
    } finally {
      Range.prototype.getBoundingClientRect = nativeRect
    }
  })

  it('synthesizes the final empty-line caret after a trailing newline', () => {
    document.body.innerHTML = '<div data-input-backdrop style="font-size:16px;line-height:24px;padding:4px 12px 0 16px">a\n</div>'
    const root = document.querySelector('[data-input-backdrop]') as HTMLElement
    root.getBoundingClientRect = () => rect(10, 100, 300, 52)
    const nativeRect = Range.prototype.getBoundingClientRect
    Range.prototype.getBoundingClientRect = () => rect(0, 0, 0, 0)
    try {
      expect(visualCaretRectAtLogicalOffset(root, 2)).toMatchObject({ left: 26, top: 128, height: 24 })
    } finally {
      Range.prototype.getBoundingClientRect = nativeRect
    }
  })

  it('selects visual words and atomic chips at their logical offsets', () => {
    const value = '\uFFFC ordinary words'
    expect(wordRangeAtLogicalOffset(value, 0)).toEqual({ start: 0, end: 1 })
    expect(wordRangeAtLogicalOffset(value, 1)).toEqual({ start: 0, end: 1 })
    expect(wordRangeAtLogicalOffset(value, 4)).toEqual({ start: 2, end: 10 })
    expect(wordRangeAtLogicalOffset(value, 13)).toEqual({ start: 11, end: 16 })
    expect(wordRangeAtLogicalOffset('one...two', 4)).toEqual({ start: 4, end: 5 })
    expect(wordRangeAtLogicalOffset('one   two', 4)).toEqual({ start: 3, end: 6 })
  })

  it('uses backdrop hit-testing for visual-line keyboard navigation', () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-scroll><div data-input-backdrop style="padding:4px 12px 0 16px"><span data-decoration="chip"><span>Long title</span></span>after</div><textarea style="font-size:16px;line-height:24px;padding:4px 12px 0 16px">\uFFFCafter</textarea></div></div>'
    const input = document.querySelector('textarea')!
    const backdrop = document.querySelector('[data-input-backdrop]') as HTMLElement
    const trailing = backdrop.lastChild as Text
    backdrop.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 200, width: 400, height: 200, x: 0, y: 0, toJSON() {} })
    const nativeRect = Range.prototype.getBoundingClientRect
    Range.prototype.getBoundingClientRect = () => ({ left: 120, right: 120, top: 100, bottom: 120, width: 0, height: 20, x: 120, y: 100, toJSON() {} })
    const point = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: trailing, offset: 2 }) })
    const dispose = adoptAdaptiveChipKeyboardNavigation()
    try {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      expect(input.selectionStart).toBe(3)
      expect(input.selectionEnd).toBe(3)
    } finally {
      dispose()
      Range.prototype.getBoundingClientRect = nativeRect
      if (point) Object.defineProperty(document, 'caretPositionFromPoint', point)
      else delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
    }
  })

  it('uses the native active end when vertically moving an existing selection', () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-backdrop><span data-decoration="chip"><span>Long title</span></span>abcdefghij</div><textarea style="font-size:16px;line-height:24px">\uFFFCabcdefghij</textarea></div>'
    const input = document.querySelector('textarea')!
    const backdrop = document.querySelector('[data-input-backdrop]') as HTMLElement
    const trailing = backdrop.lastChild as Text
    const nativeRect = Range.prototype.getBoundingClientRect
    Range.prototype.getBoundingClientRect = function () {
      const offset = this.startContainer === trailing ? this.startOffset : 0
      return rect(10 + offset * 8, 100 + Math.floor(offset / 4) * 24, 8, 20)
    }
    const point = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: (_x: number, y: number) => ({ offsetNode: trailing, offset: y < 112 ? 1 : y < 148 ? 5 : 9 }),
    })
    const dispose = adoptAdaptiveChipKeyboardNavigation()
    try {
      input.focus()
      input.setSelectionRange(2, 6, 'forward')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(input.selectionStart).toBe(10)
      expect(input.selectionEnd).toBe(10)
      input.setSelectionRange(2, 6, 'backward')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(input.selectionStart).toBe(6)
      expect(input.selectionEnd).toBe(6)
      input.setSelectionRange(2, 6, 'backward')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))
      expect(input.selectionStart).toBe(10)
      expect(input.selectionEnd).toBe(10)
    } finally {
      dispose()
      Range.prototype.getBoundingClientRect = nativeRect
      if (point) Object.defineProperty(document, 'caretPositionFromPoint', point)
      else delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
    }
  })

  it('selects vertically across visual lines with the primary pointer', () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-backdrop><span data-decoration="chip"><span>Ref</span></span>first\nsecond\nthird</div><textarea>\uFFFCfirst\nsecond\nthird</textarea></div>'
    const input = document.querySelector('textarea')!
    const text = document.querySelector('[data-input-backdrop]')!.lastChild as Text
    const point = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: (_x: number, y: number) => ({ offsetNode: text, offset: y < 30 ? 2 : y < 54 ? 9 : 16 }),
    })
    const dispose = adoptAdaptiveChipHitTesting()
    try {
      input.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 30, clientY: 12, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 62, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 60, clientY: 62, bubbles: true, cancelable: true }))
      expect(input.selectionStart).toBe(3)
      expect(input.selectionEnd).toBe(17)
      expect(input.selectionDirection).toBe('forward')
    } finally {
      dispose()
      if (point) Object.defineProperty(document, 'caretPositionFromPoint', point)
      else delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
    }
  })

  it('continues pointer selection by whole words after a native double press', () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-backdrop><span data-decoration="chip"><span>Ref</span></span>one two three</div><textarea>\uFFFCone two three</textarea></div>'
    const input = document.querySelector('textarea')!
    const text = document.querySelector('[data-input-backdrop]')!.lastChild as Text
    const point = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: (x: number) => ({ offsetNode: text, offset: x < 100 ? 5 : 10 }),
    })
    const dispose = adoptAdaptiveChipHitTesting()
    try {
      input.dispatchEvent(new MouseEvent('pointerdown', { button: 0, detail: 2, clientX: 40, clientY: 12, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 160, clientY: 12, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('pointerup', { button: 0, detail: 2, clientX: 160, clientY: 12, bubbles: true, cancelable: true }))
      input.dispatchEvent(new MouseEvent('dblclick', { button: 0, detail: 2, clientX: 160, clientY: 12, bubbles: true, cancelable: true }))
      expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe('two three')
    } finally {
      dispose()
      if (point) Object.defineProperty(document, 'caretPositionFromPoint', point)
      else delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
    }
  })

  it('continues a triple press drag by complete visual lines including hard newlines', () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-backdrop style="font-size:16px;line-height:24px;padding:4px 12px 0 16px"><span data-decoration="chip"><span>Ref</span></span>one\nsecond\nthird</div><textarea style="font-size:16px;line-height:24px;padding:4px 12px 0 16px">\uFFFCone\nsecond\nthird</textarea></div>'
    const input = document.querySelector('textarea')!
    const backdrop = document.querySelector('[data-input-backdrop]') as HTMLElement
    const chip = backdrop.firstChild as HTMLElement
    const text = backdrop.lastChild as Text
    backdrop.getBoundingClientRect = () => rect(0, 96, 300, 76)
    chip.getBoundingClientRect = () => rect(16, 100, 30, 20)
    const nativeRect = Range.prototype.getBoundingClientRect
    Range.prototype.getBoundingClientRect = function () {
      if (this.startContainer !== text) return rect(0, 0, 0, 0)
      const at = this.startOffset
      const lineStart = at <= 3 ? 0 : at <= 10 ? 4 : 11
      const top = at <= 3 ? 100 : at <= 10 ? 124 : 148
      return rect((at <= 3 ? 46 : 16) + (at - lineStart) * 10, top, 10, 20)
    }
    const point = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: (_x: number, y: number) => ({ offsetNode: text, offset: y < 124 ? 1 : y < 148 ? 6 : 13 }),
    })
    const dispose = adoptAdaptiveChipHitTesting()
    try {
      input.dispatchEvent(new MouseEvent('pointerdown', { button: 0, detail: 3, clientX: 70, clientY: 110, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 90, clientY: 134, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('pointerup', { button: 0, detail: 3, clientX: 90, clientY: 134, bubbles: true, cancelable: true }))
      expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe('\uFFFCone\nsecond\n')
    } finally {
      dispose()
      Range.prototype.getBoundingClientRect = nativeRect
      if (point) Object.defineProperty(document, 'caretPositionFromPoint', point)
      else delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
    }
  })

  it('auto-scrolls the shared draft viewport while extending a pointer selection', async () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-scroll><div data-input-backdrop><span data-decoration="chip"><span>Ref</span></span>first\nsecond\nthird\nfourth</div><textarea>\uFFFCfirst\nsecond\nthird\nfourth</textarea></div></div>'
    const input = document.querySelector('textarea')!
    const scrollport = document.querySelector('[data-input-scroll]') as HTMLElement
    const text = document.querySelector('[data-input-backdrop]')!.lastChild as Text
    Object.defineProperty(scrollport, 'clientHeight', { configurable: true, value: 72 })
    Object.defineProperty(scrollport, 'scrollHeight', { configurable: true, value: 240 })
    Object.defineProperty(scrollport, 'scrollTop', { configurable: true, value: 0, writable: true })
    scrollport.getBoundingClientRect = () => rect(0, 0, 300, 72)
    const point = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: (_x: number, y: number) => ({ offsetNode: text, offset: y < 40 ? 1 : text.length }),
    })
    const dispose = adoptAdaptiveChipHitTesting()
    try {
      input.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 20, clientY: 12, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 80, clientY: 100, bubbles: true, cancelable: true }))
      await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve() }) })
      expect(scrollport.scrollTop).toBeGreaterThan(0)
      document.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 80, clientY: 100, bubbles: true, cancelable: true }))
    } finally {
      dispose()
      if (point) Object.defineProperty(document, 'caretPositionFromPoint', point)
      else delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
    }
  })

  it('hits the end of a very long draft without measuring every character', () => {
    const tail = 'x'.repeat(20_000)
    document.body.innerHTML = `<div data-composer-card><div data-input-backdrop><span data-decoration="chip"><span>Ref</span></span>${tail}</div><textarea>\uFFFC${tail}</textarea></div>`
    const input = document.querySelector('textarea')!
    const backdrop = document.querySelector('[data-input-backdrop]') as HTMLElement
    const text = backdrop.lastChild as Text
    backdrop.getBoundingClientRect = () => rect(0, 96, 320, 24)
    const nativeRect = Range.prototype.getBoundingClientRect
    let measurements = 0
    Range.prototype.getBoundingClientRect = function () {
      measurements++
      if (this.startContainer === text) return rect(100, 100, 10, 20)
      return rect(0, 0, 0, 0)
    }
    const point = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: backdrop, offset: backdrop.childNodes.length }) })
    const dispose = adoptAdaptiveChipHitTesting()
    try {
      input.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 240, clientY: 110, bubbles: true }))
      input.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 240, clientY: 110, bubbles: true }))
      expect(input.selectionStart).toBe(input.value.length)
      expect(input.selectionEnd).toBe(input.value.length)
      expect(measurements).toBeLessThan(20)
    } finally {
      dispose()
      Range.prototype.getBoundingClientRect = nativeRect
      if (point) Object.defineProperty(document, 'caretPositionFromPoint', point)
      else delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
    }
  })

  it('restores the caret after a picked chip when copied text contains a later @ token', async () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-backdrop>@first copied @second</div><textarea>@first copied @second</textarea><div role="listbox" aria-activedescendant="pick"><button id="pick" role="option">pick</button></div></div>'
    const input = document.querySelector('textarea')!
    input.focus()
    input.setSelectionRange(6, 6)
    const dispose = adoptAdaptiveChipInsertionCaret()
    try {
      document.getElementById('pick')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      input.value = '\uFFFC copied @second'
      input.setSelectionRange(input.value.length, input.value.length) // controlled update/browser jump
      const backdrop = document.querySelector('[data-input-backdrop]')!
      backdrop.innerHTML = '<span data-decoration="chip" data-occurrence="7"><span>Picked</span></span> copied @second'
      await new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
      expect(input.selectionStart).toBe(2)
      expect(input.selectionEnd).toBe(2)
    } finally {
      dispose()
    }
  })

  it('restores the caret after a mouse-picked command replaces an @ token mid-draft', async () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-backdrop>before @commands after</div><textarea>before @commands after</textarea><div role="listbox" aria-activedescendant="pick"><button id="pick" role="option">plan</button></div></div>'
    const input = document.querySelector('textarea')!
    input.focus()
    input.setSelectionRange(16, 16)
    const dispose = adoptAdaptiveChipInsertionCaret()
    try {
      document.getElementById('pick')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      input.value = 'before /plan after'
      input.setSelectionRange(input.value.length, input.value.length)
      document.querySelector('[data-input-backdrop]')!.textContent = input.value
      await new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
      expect(input.selectionStart).toBe(12)
      expect(input.selectionEnd).toBe(12)
    } finally {
      dispose()
    }
  })

  it('restores the caret after a keyboard-picked skill replaces an @ token mid-draft', async () => {
    document.body.innerHTML = '<div data-composer-card><div data-input-backdrop>before @skills:review after</div><textarea>before @skills:review after</textarea><div role="listbox" aria-activedescendant="pick"><button id="pick" role="option">review</button></div></div>'
    const input = document.querySelector('textarea')!
    input.focus()
    input.setSelectionRange(21, 21)
    const dispose = adoptAdaptiveChipInsertionCaret()
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.value = 'before /review  after'
      input.setSelectionRange(input.value.length, input.value.length)
      document.querySelector('[data-input-backdrop]')!.textContent = input.value
      await new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
      expect(input.selectionStart).toBe(15)
      expect(input.selectionEnd).toBe(15)
    } finally {
      dispose()
    }
  })

  it('projects the DSH session marker as an outlined conversation icon', () => {
    document.body.innerHTML = '<div role="listbox"><span>\uE106 Session title</span></div>'
    const dispose = adoptReferenceIconProjection()
    const projected = document.querySelector('.dsh_ref_session_icon')
    expect(projected?.textContent).toBe('Session title')
    expect(projected?.getAttribute('style')).toContain('stroke-width%3D%222%22')
    dispose()
  })

  it('projects the Lucide ScrollText marker for skills', () => {
    document.body.innerHTML = '<div role="listbox"><span>\uE107 review</span></div>'
    const dispose = adoptReferenceIconProjection()
    const projected = document.querySelector('[data-dsh-ref-picker-icon="skill"]')
    expect(projected?.textContent).toBe('review')
    expect(projected?.getAttribute('style')).toContain('--dsh-ref-picker-icon')
    expect(projected?.getAttribute('style')).toContain('fill%3D%22none%22')
    dispose()
  })

  it('projects Command and file-type markers with the same Lucide stroke weight', () => {
    document.body.innerHTML = '<div role="listbox"><span>\uE108 plan</span><span>\uE10B hero.png</span></div><span data-decoration="chip"><span>\uE109 assets</span></span>'
    const dispose = adoptReferenceIconProjection()
    const command = document.querySelector('[data-dsh-ref-picker-icon="command"]')
    const image = document.querySelector('[data-dsh-ref-picker-icon="image"]')
    const folder = document.querySelector('[data-dsh-ref-picker-icon="folder"]')
    expect(command?.textContent).toBe('plan')
    expect(command?.getAttribute('style')).toContain('stroke-width%3D%222%22')
    expect(image?.getAttribute('style')).toContain('%3Crect')
    expect(image?.getAttribute('style')).toContain('stroke-width%3D%222%22')
    expect(folder?.textContent).toBe('assets')
    expect(folder?.classList.contains('dsh_ref_picker_icon')).toBe(true)
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

  it('uses completed provider phases while listing instead of an indeterminate animation', () => {
    const status: SyncStatus = {
      jobId: 'job', status: 'running', providers: ['chatgpt', 'claude'], completed: 0, total: 0,
      providerProgress: [
        { provider: 'chatgpt', phase: 'syncing', completed: 2, total: 4 },
        { provider: 'claude', phase: 'listing', completed: 0, total: 0 },
      ],
    }
    expect(syncProgressFraction(status)).toBeCloseTo(0.3125)
    adoptStyles()
    const text = document.getElementById('dsh-reference-anything-style')?.textContent ?? ''
    expect(text).not.toContain('dsh-ref-menu-listing')
    expect(text).not.toContain('dsh-ref-listing')
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

  it('restores the open menu scroll position after asynchronous sync results replace the rows', async () => {
    const card = document.createElement('div'); card.dataset.composerCard = ''
    const editor = document.createElement('textarea'); editor.value = '@chatgpt'
    const listbox = document.createElement('div'); listbox.setAttribute('role', 'listbox')
    const viewport = document.createElement('div')
    const header = document.createElement('div'); header.setAttribute('role', 'presentation'); header.dataset.source = 'External conversations'
    const oldRow = document.createElement('button'); oldRow.setAttribute('role', 'option')
    viewport.append(header, oldRow); listbox.append(viewport); card.append(editor, listbox); document.body.append(card)
    viewport.scrollTop = 120
    editor.addEventListener('input', () => {
      if (editor.value !== '@chatgpt') return
      const loading = document.createElement('div'); loading.dataset.source = 'External conversations'
      viewport.replaceChildren(header, loading)
      viewport.scrollTop = 0
      setTimeout(() => {
        const refreshedRow = document.createElement('button'); refreshedRow.setAttribute('role', 'option')
        viewport.replaceChildren(header, refreshedRow)
        // The host's post-commit highlighted-row effect runs after data arrives.
        viewport.scrollTop = 0
      }, 100)
    })
    editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length)

    expect(refreshActiveTriggerMenu('External conversations')).toBe(true)
    await new Promise(resolve => { setTimeout(resolve, 260) })
    expect(viewport.scrollTop).toBe(120)
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

  it('resets a command group to the newly configured visible limit', async () => {
    let limit = 4
    document.body.innerHTML = '<div role="listbox"><div role="presentation" data-source="Commands">Commands</div><button role="option">1</button><button role="option">2</button><button role="option">3</button><button role="option">4</button><button role="option">5</button><button role="option">6</button></div>'
    const dispose = adoptMenuExpansionProjection({ sources: ['Commands'], label: '展开', getVisibleLimit: () => limit })
    const rows = Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[]
    expect(rows.filter(row => !row.classList.contains('dsh_ref_menu_collapsed'))).toHaveLength(4)

    limit = 2
    document.querySelector('[role="listbox"]')?.append(document.createComment('settings changed'))
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(rows.filter(row => !row.classList.contains('dsh_ref_menu_collapsed'))).toHaveLength(2)
    dispose()
  })

  it('only visits visible rows during keyboard traversal until expansion', () => {
    document.body.innerHTML = '<textarea></textarea><div role="listbox" aria-activedescendant="row-0"><div role="presentation" data-source="External conversations">External conversations</div><button id="row-0" role="option">0</button><button id="row-1" role="option">1</button><button id="row-2" role="option">2</button><div role="presentation" data-source="Other">Other</div><button id="row-3" role="option">3</button></div>'
    const editor = document.querySelector('textarea')!
    const listbox = document.querySelector('[role="listbox"]')!
    const dispose = adoptMenuExpansionProjection({ sources: ['External conversations'], label: '展开', getVisibleLimit: () => 1 })
    let index = 0
    editor.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') index = (index + 1) % 4
      if (event.key === 'ArrowUp') index = (index + 3) % 4
      listbox.setAttribute('aria-activedescendant', `row-${index}`)
    })

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(listbox.getAttribute('aria-activedescendant')).toBe('row-3')
    expect(document.getElementById('row-1')?.classList.contains('dsh_ref_menu_collapsed')).toBe(true)
    expect(document.getElementById('row-2')?.classList.contains('dsh_ref_menu_collapsed')).toBe(true)

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(listbox.getAttribute('aria-activedescendant')).toBe('row-0')

    document.querySelector<HTMLButtonElement>('[data-dsh-ref-menu-expand]')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(listbox.getAttribute('aria-activedescendant')).toBe('row-1')
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

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, right: left + width, width, top, bottom: top + height, height, x: left, y: top, toJSON() {} } as DOMRect
}
