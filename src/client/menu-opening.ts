import type { InputTriggerServiceContract, MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

/** Hold the initial selection until every preceding source has settled. */
export function openingHighlight(state: MenuState): MenuState['highlight'] {
  for (const group of state.groups) {
    if (group.status !== 'ready') return null
    if (group.items.length) return { source: group.source, index: 0 }
  }
  return null
}

export function adoptMenuOpening(inputTriggers: InputTriggerServiceContract): () => void {
  const original = inputTriggers.sessionOf
  const patched = new Map<ReturnType<typeof original>, { stop: () => void; restore: () => void }>()
  inputTriggers.sessionOf = function (...args) {
    const controller = original.apply(this, args)
    if (patched.has(controller)) return controller
    const menu = controller.menu
    const set = menu.set
    let opening = false
    const wrapped: typeof set = next => {
      const before = menu.getSnapshot()
      if (!before.open && next.open) opening = next.hit?.trigger === '@' && next.hit.query === ''
      if (!next.open || next.hit?.query !== before.hit?.query && before.open) opening = false
      // Native navigation can reach the store without our document receiving keydown.
      if (before.open && next.groups === before.groups && next.highlight !== before.highlight) opening = false
      if (opening) {
        const highlight = openingHighlight(next)
        next = { ...next, highlight: highlight?.source === before.highlight?.source && highlight?.index === before.highlight?.index ? before.highlight : highlight }
      }
      set.call(menu, next)
    }
    menu.set = wrapped
    patched.set(controller, { stop: () => { opening = false }, restore: () => { if (menu.set === wrapped) menu.set = set } })
    return controller
  }
  const wrappedSessionOf = inputTriggers.sessionOf
  const interact = (event: Event): void => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-composer-card]')) return
    if (event instanceof KeyboardEvent && !['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp', 'Tab', 'Enter', 'Escape'].includes(event.key)) return
    for (const entry of patched.values()) entry.stop()
  }
  const events = ['pointermove', 'pointerdown', 'wheel', 'touchmove', 'keydown'] as const
  for (const event of events) document.addEventListener(event, interact, { capture: true, passive: true })
  return () => {
    for (const event of events) document.removeEventListener(event, interact, true)
    if (inputTriggers.sessionOf === wrappedSessionOf) inputTriggers.sessionOf = original
    for (const entry of patched.values()) entry.restore()
    patched.clear()
  }
}
