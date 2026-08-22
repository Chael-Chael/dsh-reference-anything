/**
 * Which transcript formats this package can read, and where they live.
 *
 * One place to add a format: an adapter registered here becomes visible to
 * discovery, to reading, and to the `@` menu without any other file learning
 * its name.
 *
 * @module dsh-reference-anything/local-agent/registry
 */

import { claudeCodeAdapter } from './adapters/claude-code.ts'
import { codexAdapter } from './adapters/codex.ts'
import { cursorAdapter } from './adapters/cursor.ts'
import { geminiCliAdapter } from './adapters/gemini-cli.ts'
import { grokbuildAdapter } from './adapters/grokbuild.ts'
import { hermesAdapter } from './adapters/hermes.ts'
import { kimiAdapter } from './adapters/kimi.ts'
import { mimocodeAdapter, opencodeAdapter } from './adapters/opencode.ts'
import { openclawAdapter } from './adapters/openclaw.ts'
import { piAdapter } from './adapters/pi.ts'
import { qoderAdapter } from './adapters/qoder.ts'
import { reasonixAdapter } from './adapters/reasonix.ts'
import { zcodeAdapter } from './adapters/zcode.ts'
import type { AgentAdapter, AgentKind, QueryAdapter, TranscriptAdapter } from './types.ts'
import { isQueryAdapter } from './types.ts'
import { isAbsoluteLocalPath, joinLocalPath, normalizeLocalPath } from './path.ts'

/**
 * Every supported adapter, in menu order.
 *
 * Ordered by how well the format is validated rather than alphabetically. The
 * first two were built against real corpora on the machine this was written
 * on — 541 Claude Code transcripts and 212 Codex rollouts — and the rest were
 * ported from format documentation and exercised only against the fixtures in
 * `tests/local-agent-converters.spec.ts`. That distinction is real enough to
 * belong in the README, and the order here is what it looks like in code.
 *
 * The last three are database-backed and sit at the end for a second reason:
 * they are the only ones a build without `node:sqlite` cannot read at all.
 */
export const AGENT_ADAPTERS: readonly AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  qoderAdapter,
  reasonixAdapter,
  openclawAdapter,
  kimiAdapter,
  grokbuildAdapter,
  hermesAdapter,
  geminiCliAdapter,
  piAdapter,
  opencodeAdapter,
  mimocodeAdapter,
  zcodeAdapter,
]

/**
 * The formats read by walking a file, which is all but the databases.
 *
 * Kept as a narrowed array rather than filtered at each use so the discovery
 * walk and the read path agree on which seam an adapter answers to.
 */
export const FILE_ADAPTERS: readonly TranscriptAdapter[] =
  AGENT_ADAPTERS.filter((adapter): adapter is TranscriptAdapter => !isQueryAdapter(adapter))

/** The formats read by querying a database. */
export const QUERY_ADAPTERS: readonly QueryAdapter[] = AGENT_ADAPTERS.filter(isQueryAdapter)

/** Whether a format is read by querying a database rather than by walking a file. */
export function isQueryKind(kind: string): boolean {
  const adapter = BY_KIND.get(kind)
  return adapter !== undefined && isQueryAdapter(adapter)
}

/** Every supported {@link AgentKind}, in the same order. */
export const AGENT_KINDS: readonly AgentKind[] = AGENT_ADAPTERS.map(adapter => adapter.kind)

/**
 * The format an extra root is assumed to hold when its entry does not say.
 *
 * Named rather than indexed off {@link AGENT_KINDS} so the choice reads as a
 * choice — the best-validated format is the safe thing to guess.
 */
export const DEFAULT_AGENT_KIND: AgentKind = claudeCodeAdapter.kind

const BY_KIND = new Map<string, AgentAdapter>(AGENT_ADAPTERS.map(adapter => [adapter.kind, adapter]))

/**
 * Find the adapter for a format.
 * @param kind - a format name, which may have come from config or from a reference id.
 * @returns the adapter, or undefined when nothing reads that format.
 */
export function adapterFor(kind: string): AgentAdapter | undefined {
  return BY_KIND.get(kind)
}

/**
 * Whether a string names a supported format.
 * @param kind - the candidate name.
 * @returns whether {@link adapterFor} would resolve it.
 */
export function isAgentKind(kind: string): kind is AgentKind {
  return BY_KIND.has(kind)
}

/**
 * Resolve a configured root to an absolute path.
 *
 * Roots are written as portable `~/`-prefixed strings rather than absolute
 * ones so a profile can be shared between machines and users. Expansion is
 * plain string work on purpose: an external plugin overlay is not permitted to
 * evaluate code, so a root must never need any.
 * @param root - a configured root, `~`-relative or absolute.
 * @param home - the user's home directory.
 * @returns the absolute path, or undefined when the root is empty or relative.
 */
export function expandRoot(root: string, home: string): string | undefined {
  const trimmed = root.trim()
  if (trimmed === '') return undefined
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return normalizeLocalPath(joinLocalPath(home, trimmed.slice(2)))
  // A relative root would resolve against whatever directory the harness
  // happened to launch in, which is not a boundary anyone chose.
  return isAbsoluteLocalPath(trimmed) ? normalizeLocalPath(trimmed) : undefined
}
