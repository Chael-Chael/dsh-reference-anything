/**
 * Reversible, readable ids for local Agent sessions.
 *
 * `<agent>[@<root>]:<relative path>[#<session id>]` — the path is relative to a
 * named scan location, so ids carry no user name or absolute path and survive
 * restarts without a registry. The session id is omitted when it equals the
 * file name without its extension.
 */
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { ALL_LOCAL_AGENTS, type LocalAgent } from '../../wire.ts'

/** One scan location of one Agent; the default location has no name. */
export interface LocalRoot { readonly name?: string; readonly path: string }
/** What the conversation reader needs. */
export interface LocalTarget { readonly path: string; readonly sessionId: string }
export interface LocalId { readonly agent: LocalAgent; readonly root?: string; readonly relPath: string; readonly sessionId?: string }

const ROOT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
const escape = (value: string) => value.replaceAll('%', '%25').replaceAll('#', '%23')
const unescape = (value: string) => value.replaceAll('%23', '#').replaceAll('%25', '%')
const stem = (relPath: string) => { const leaf = relPath.split('/').pop() ?? ''; const dot = leaf.lastIndexOf('.'); return dot > 0 ? leaf.slice(0, dot) : leaf }

export function encodeLocalId(value: LocalId): string {
  const relPath = value.relPath.split(sep).join('/')
  const session = value.sessionId === undefined || value.sessionId === stem(relPath) ? '' : `#${escape(value.sessionId)}`
  return `${value.agent}${value.root ? `@${value.root}` : ''}:${escape(relPath)}${session}`
}

export function decodeLocalId(id: string): LocalId | undefined {
  const colon = id.indexOf(':')
  if (colon <= 0) return undefined
  const [agent, root] = id.slice(0, colon).split('@') as [string, string | undefined]
  if (!ALL_LOCAL_AGENTS.includes(agent as LocalAgent) || (root !== undefined && !ROOT_NAME.test(root))) return undefined
  const rest = id.slice(colon + 1)
  if (rest.startsWith('chat-import:')) return undefined
  const hash = rest.lastIndexOf('#')
  const relPath = unescape(hash < 0 ? rest : rest.slice(0, hash))
  const sessionId = hash < 0 ? undefined : unescape(rest.slice(hash + 1))
  if (!relPath || relPath.includes('\0') || isAbsolute(relPath) || /^[A-Za-z]:/u.test(relPath)
    || relPath.split('/').some(part => part === '..' || part === '') || sessionId === '') return undefined
  return { agent: agent as LocalAgent, ...(root ? { root } : {}), relPath, ...(sessionId !== undefined ? { sessionId } : {}) }
}

/** The session id a decoded id names: explicit, or the file name without its extension. */
export function sessionOf(value: LocalId): string { return value.sessionId ?? stem(value.relPath) }

/**
 * Name default locations: the first is unnamed, later ones take the first path
 * segment that differs from the first location, so the names match across machines.
 */
export function nameDefaultRoots(paths: readonly string[]): LocalRoot[] {
  const taken = new Set<string>(['custom'])
  const first = paths[0] === undefined ? [] : resolve(paths[0]).split(/[\\/]+/u)
  return paths.map((path, index) => {
    if (index === 0) return { path }
    const parts = resolve(path).split(/[\\/]+/u)
    const at = parts.findIndex((part, i) => part !== first[i])
    const raw = (parts[at] ?? parts.at(-1) ?? '').replace(/^\.+/u, '').toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '')
    let name = ROOT_NAME.test(raw) && !/^extra-\d+$/u.test(raw) ? raw : `default-${index + 1}`
    for (let n = 2; taken.has(name); n++) name = `${raw || 'default'}-${n}`
    taken.add(name)
    return { name, path }
  })
}

/** Whether `target` is `root` or inside it, lexically. */
function within(root: string, target: string): string | undefined {
  const child = relative(resolve(root), resolve(target))
  if (child === '') return ''
  return isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`) ? undefined : child
}

/**
 * The id for a conversation found at `target`, using the first location that
 * contains it (default, then custom, then extra), so `@`, list and search agree.
 */
export function localIdFor(agent: LocalAgent, roots: readonly LocalRoot[], target: LocalTarget): string | undefined {
  for (const root of roots) {
    const child = within(root.path, target.path)
    if (child === undefined) continue
    // A location that is itself one file (a database) is named by its file name.
    const relPath = child === '' ? basename(resolve(root.path)) : child
    return encodeLocalId({ agent, ...(root.name ? { root: root.name } : {}), relPath, sessionId: target.sessionId })
  }
  return undefined
}

/**
 * Paths an id may name: the named location first, then the same relative path in
 * the Agent's other locations. Readers accept a fallback only when its session id matches.
 * @returns undefined when the named location is no longer configured.
 */
export function localCandidates(value: LocalId, roots: readonly LocalRoot[]): { named: string[]; fallback: string[] } | undefined {
  const named = roots.find(root => (root.name ?? '') === (value.root ?? ''))
  const paths = (root: LocalRoot) => {
    const relPath = value.relPath.split('/').join(sep)
    const own = resolve(root.path)
    return basename(own) === relPath ? [own, resolve(root.path, relPath)] : [resolve(root.path, relPath)]
  }
  if (!named) return undefined
  return { named: paths(named), fallback: roots.filter(root => root !== named).flatMap(paths) }
}

