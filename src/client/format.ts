/** Display formatting shared by the mention menu, the dock, and the settings panel. */

/**
 * Render a timestamp as coarse elapsed time.
 *
 * Coarse on purpose: in a list of conversations "3d ago" separates rows at a
 * glance where a locale date string does not.
 * @param value - an ISO timestamp, or empty when never.
 * @returns a short relative phrase, or 'never' when the value is unusable.
 */
export function formatRelative(value: string): string {
  const then = Date.parse(value)
  if (!value || Number.isNaN(then)) return 'never'
  const minutes = Math.floor((Date.now() - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
