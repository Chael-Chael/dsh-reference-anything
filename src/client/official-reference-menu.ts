import type { InputTriggerCandidate, InputTriggerServiceContract, MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { PickerSettings } from '../wire.ts'

export const OFFICIAL_SESSION_GROUP = 'reference-anything:official-sessions'
const orderKeys = { reference: 'files', [OFFICIAL_SESSION_GROUP]: 'sessions', Commands: 'commands', Skills: 'skills', 'Local agent conversations': 'agents', 'External conversations': 'conversations', 'Cloud drive files': 'drives', 'All local plugins': 'plugins' } as const

export function adoptOfficialReferenceMenu(service: InputTriggerServiceContract, settings: () => PickerSettings, t: (key: 'menu.showMore' | 'menu.collapse', params?: { count: number }) => string): () => void {
  const sessionOf = service.sessionOf
  const controllers = new Map<ReturnType<typeof sessionOf>, () => void>()
  let active = true
  // shortcut: DSH 0.2.1 has no menu projection hook; replace this adapter when the host exposes one.
  service.sessionOf = function (...args) {
    const controller = sessionOf.apply(this, args)
    if (!active || controllers.has(controller) || !controller?.menu?.set || !controller.pick) return controller
    const menu = controller.menu, set = menu.set, pick = controller.pick
    let raw: readonly InputTriggerCandidate[] = [], projected: readonly InputTriggerCandidate[] = []
    let sessionRows: readonly InputTriggerCandidate[] = []
    let generation = -1, query: string | undefined
    let projectionKey = '', dirty = true
    let parsed: readonly InputTriggerCandidate[] | undefined, parsedBrowsing = false
    let supported = true
    const sections = new Map<string, { kind: 'files' | 'sessions'; rows: InputTriggerCandidate[] }>()
    const counts = new Map<string, number>()
    let actions = new Map<InputTriggerCandidate, { section: string; count: number }>()
    const arrange = (next: MenuState, group: MenuState['groups'][number]): MenuState => {
      const previous = next.groups.find(g => g.source === OFFICIAL_SESSION_GROUP)
      const groups = next.groups.filter(g => g.source !== OFFICIAL_SESSION_GROUP).map(g => g === group && g.items !== projected ? { ...g, items: projected } : g)
      if (sessionRows.length) groups.push(previous?.items === sessionRows ? previous : { source: OFFICIAL_SESSION_GROUP, status: 'ready', showGroupTitle: false, items: sessionRows })
      const options = settings()
      const order = (source: string) => {
        const key = orderKeys[source as keyof typeof orderKeys]
        return key ? options[key].order : -Infinity
      }
      groups.sort((a, b) => order(a.source) - order(b.source))
      return groups.length === next.groups.length && groups.every((g, i) => g === next.groups[i]) ? next : { ...next, groups }
    }
    const project = (next: MenuState): MenuState => {
      if (!active) return next
      if (!next.open || next.hit?.trigger !== '@') {
        counts.clear(); raw = []; projected = []; sessionRows = []; actions.clear(); generation = -1
        return next
      }
      if (next.generation !== generation || next.hit.query !== query) {
        dirty = true
        counts.clear(); generation = next.generation; query = next.hit.query
      }
      const group = next.groups.find(g => g.source === 'reference' && g.status === 'ready')
      if (!group) return next
      const options = settings()
      const fileBrowsing = (controller.headers?.getSnapshot().get('reference')?.length ?? 0) > 1
      const key = JSON.stringify([options.displayMode, options.files, options.sessions, fileBrowsing])
      if (!dirty && key === projectionKey && group.items === projected) return arrange(next, group)
      if (group.items !== projected) raw = group.items
      projectionKey = key; dirty = false
      if (parsed !== raw || parsedBrowsing !== fileBrowsing) {
        parsed = raw; parsedBrowsing = fileBrowsing; supported = true; sections.clear()
        for (const row of raw) {
          try {
            const value = JSON.parse(row.value ?? '') as { kind?: string; mention?: string }
            if (!row.section || !['file', 'session'].includes(value.kind ?? '') || typeof value.mention !== 'string') { supported = false; break }
            const kind = value.kind === 'file' ? 'files' : 'sessions'
            if (fileBrowsing && kind === 'sessions') continue
            const section = sections.get(row.section)
            if (section && section.kind !== kind) { supported = false; break }
            if (section) section.rows.push(row)
            else sections.set(row.section, { kind, rows: [row] })
          } catch { supported = false; break }
        }
      }
      const previousActions = actions
      actions = new Map()
      const rows: InputTriggerCandidate[] = []
      if (!supported) rows.push(...raw)
      else for (const [section, { kind, rows: all }] of sections) {
        if (!options[kind].enabled) continue
        if (options.displayMode === 'native-scroll') { rows.push(...all); continue }
        const limit = options[kind].limit
        const count = Math.max(limit, counts.get(section) ?? limit)
        rows.push(...all.slice(0, count))
        const action = (name: string, count: number) => {
          const row = [...previousActions].find(([row, command]) => row.name === name && command.section === section && command.count === count)?.[0] ?? { name, section }
          rows.push(row); actions.set(row, { section, count })
        }
        if (all.length > count) action(t('menu.showMore', { count: Math.min(5, all.length - count) }), count + 5)
        if (count > limit && all.length > limit) action(t('menu.collapse'), limit)
      }
      const selected = next.highlight && ['reference', OFFICIAL_SESSION_GROUP].includes(next.highlight.source)
        ? next.groups.find(g => g.source === next.highlight!.source)?.items[next.highlight.index] : undefined
      const files = supported ? rows.filter(row => sections.get(row.section!)?.kind === 'files') : rows
      const sessions = supported ? rows.filter(row => sections.get(row.section!)?.kind === 'sessions') : []
      let highlight = next.highlight
      if (selected) {
        let index = rows.indexOf(selected)
        if (index < 0) {
          const oldAction = previousActions.get(selected)
          index = oldAction ? rows.findIndex(row => actions.get(row)?.section === oldAction.section) : -1
          if (index < 0) index = rows.findIndex(row => row.section === selected.section)
        }
        const row = rows[index]
        highlight = !row ? null : sessions.includes(row)
          ? { source: OFFICIAL_SESSION_GROUP, index: sessions.indexOf(row) }
          : { source: 'reference', index: files.indexOf(row) }
      }
      // Preserve array identity on navigation so other menu adapters see a highlight-only update.
      if (files.length !== projected.length || files.some((row, i) => row !== projected[i])) projected = files
      if (sessions.length !== sessionRows.length || sessions.some((row, i) => row !== sessionRows[i])) sessionRows = sessions
      return arrange(highlight === next.highlight ? next : { ...next, highlight }, group)
    }
    const wrappedSet: typeof set = next => set.call(menu, project(next))
    const wrappedPick: typeof pick = (source, index, action) => {
      const state = menu.getSnapshot()
      const row = state.groups.find(g => g.source === source)?.items[index]
      const command = active && ['reference', OFFICIAL_SESSION_GROUP].includes(source) && row ? actions.get(row) : undefined
      if (!command) {
        if (source !== OFFICIAL_SESSION_GROUP || !row) return pick.call(controller, source, index, action)
        // Only presentation is split: the original source still owns every pick and inserted reference.
        set.call(menu, { ...state, groups: state.groups.filter(g => g.source !== OFFICIAL_SESSION_GROUP).map(g => g.source === 'reference' ? { ...g, items: sessionRows } : g), highlight: { source: 'reference', index } })
        const temporary = menu.getSnapshot()
        try { return pick.call(controller, 'reference', index, action) }
        finally { if (menu.getSnapshot() === temporary) set.call(menu, state) }
      }
      counts.set(command.section, command.count)
      dirty = true
      wrappedSet(state)
    }
    menu.set = wrappedSet; controller.pick = wrappedPick
    controllers.set(controller, () => {
      const state = menu.getSnapshot()
      const group = state.groups.find(g => g.source === 'reference')
      if (group?.items === projected) set.call(menu, { ...state, highlight: null, groups: state.groups.filter(g => g.source !== OFFICIAL_SESSION_GROUP).map(g => g === group ? { ...g, items: raw } : g) })
      if (menu.set === wrappedSet) menu.set = set
      if (controller.pick === wrappedPick) controller.pick = pick
    })
    wrappedSet(menu.getSnapshot())
    return controller
  }
  const wrappedSessionOf = service.sessionOf
  return () => {
    active = false
    if (service.sessionOf === wrappedSessionOf) service.sessionOf = sessionOf
    for (const restore of controllers.values()) restore()
    controllers.clear()
  }
}
