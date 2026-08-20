import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InputTriggerCandidate, InputTriggerServiceContract, MenuState,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { mutateActiveTriggerMenu } from './styles.ts'

export type MenuViewportAnchor = 'first' | 'last' | 'viewport'

export interface PickerMenuUpdate {
  sessionId: SessionId
  source: string
  query: string
  candidates: readonly InputTriggerCandidate[]
  /** Reopen the just-closed menu after one of this source's handled picks. */
  reopen: boolean
  anchor?: MenuViewportAnchor
}

export type PickerMenuUpdater = (update: PickerMenuUpdate) => boolean
export type PickerMenuActionGuard = (sessionId: SessionId, source: string) => boolean

type ScheduleMenuMutation = (
  source: string,
  anchor: MenuViewportAnchor | undefined,
  mutate: () => void,
) => void

/**
 * Update one ready source group without re-tracking the Composer input. The
 * native controller closes every handled pick synchronously, so action
 * updates restore the captured open snapshot in the following microtask;
 * background updates only apply while that exact menu generation remains
 * open.
 */
export function createPickerMenuUpdater(
  inputTriggers: InputTriggerServiceContract,
  sessions: ISessions,
  schedule: ScheduleMenuMutation = mutateActiveTriggerMenu,
): PickerMenuUpdater {
  return (update) => {
    const actx = sessions.scope(update.sessionId)
    if (actx === undefined) return false
    const controller = inputTriggers.sessionOf(actx)
    const before = controller.menu.getSnapshot()
    if (!matches(before, update) || !before.groups.some(group => group.source === update.source)) return false

    schedule(update.source, update.anchor, () => {
      const current = controller.menu.getSnapshot()
      const base = matches(current, update)
        ? current
        : update.reopen && !current.open && current.generation === before.generation
          ? before
          : undefined
      if (base === undefined) return
      const groups = base.groups.map(group => group.source === update.source
        ? { ...group, status: 'ready' as const, items: update.candidates }
        : group)
      const highlight = update.reopen || !validHighlight(base, update.candidates, update.source)
        ? null
        : base.highlight
      controller.menu.set({ ...base, open: true, groups, highlight })
    })
    return true
  }
}

/**
 * Keep plugin-owned action picks inside the mounted native menu. The host
 * controller closes every handled pick; temporarily filtering only that
 * synchronous closed snapshot lets the source's cached update land without
 * remounting the listbox. Ordinary candidates and other sources retain the
 * native pick path unchanged.
 */
export function createPickerMenuActionGuard(
  inputTriggers: InputTriggerServiceContract,
  sessions: ISessions,
): PickerMenuActionGuard {
  const patched = new WeakMap<object, Set<string>>()
  return (sessionId, source) => {
    const actx = sessions.scope(sessionId)
    if (actx === undefined) return false
    const controller = inputTriggers.sessionOf(actx)
    const existing = patched.get(controller)
    if (existing !== undefined) {
      existing.add(source)
      return true
    }

    const ownedSources = new Set([source])
    const originalPick = controller.pick.bind(controller)
    controller.pick = (pickedSource, index) => {
      const state = controller.menu.getSnapshot()
      const group = state.groups.find(candidate => candidate.source === pickedSource)
      const candidate = group?.status === 'ready' ? group.items[index] : undefined
      if (!ownedSources.has(pickedSource) || !isPickerMenuAction(candidate)) {
        originalPick(pickedSource, index)
        return
      }

      const menu = controller.menu
      const originalSet = menu.set
      menu.set = (next) => {
        if (!isClosedSnapshot(next)) originalSet.call(menu, next)
      }
      try {
        originalPick(pickedSource, index)
      } finally {
        menu.set = originalSet
      }
    }
    patched.set(controller, ownedSources)
    return true
  }
}

function matches(state: MenuState, update: PickerMenuUpdate): boolean {
  return state.open && state.hit?.query === update.query
}

function validHighlight(
  state: MenuState,
  candidates: readonly InputTriggerCandidate[],
  source: string,
): boolean {
  return state.highlight === null
    || state.highlight.source !== source
    || state.highlight.index < candidates.length
}

function isPickerMenuAction(candidate: InputTriggerCandidate | undefined): boolean {
  if (candidate?.value === undefined) return false
  try {
    const value = JSON.parse(candidate.value) as { kind?: unknown; action?: unknown }
    return value.kind === 'action'
      && (value.action === 'expand' || value.action === 'collapse' || value.action === 'sync')
  } catch {
    return false
  }
}

function isClosedSnapshot(state: MenuState): boolean {
  return !state.open && state.hit === null && state.groups.length === 0 && state.highlight === null
}
