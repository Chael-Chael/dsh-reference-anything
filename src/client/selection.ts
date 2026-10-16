import type { AgentCandidate, DriveCandidate } from './remote.ts'

/** Apply the durable per-agent picker preference without exposing local paths. */
export function filterAgentCandidates(rows: readonly AgentCandidate[], enabled: readonly string[] | undefined): AgentCandidate[] {
  if (enabled === undefined) return [...rows]
  const selected = new Set(enabled)
  return rows.filter(row => row.warning !== undefined || selected.has(row.kind))
}

/** Undefined is the backwards-compatible "all mounts" value; [] deliberately hides all. */
export function filterDriveCandidates(rows: readonly DriveCandidate[], enabled: readonly string[] | undefined): DriveCandidate[] {
  if (enabled === undefined) return [...rows]
  return rows.filter(row => enabled.some(mount => mount === '/' || row.origin === mount || row.origin?.startsWith(`${mount}/`) === true))
}
