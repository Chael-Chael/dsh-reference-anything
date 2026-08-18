/**
 * Early-stop helper shared by every provider's history script.
 *
 * Lives in its own module, free of imports, so it can be unit-tested without
 * the OpenCLI registry that `common.js` pulls in.
 */

/**
 * Source of the guard, embedded into each provider's page script.
 *
 * Paging may only stop early while the provider actually returns
 * conversations newest-first, which not every one of these endpoints
 * documents. So the guard watches the `updatedAt` sequence it is fed and
 * authorizes a stop only while that sequence has been non-increasing *and*
 * the whole current page already predates the cutoff. A provider that pages
 * in some other order, or that omits timestamps, walks its full history
 * exactly as it did before `since` existed.
 */
export const sinceGuardSource = String.raw`function (since) {
  const cutoff = since ? Date.parse(since) : NaN
  let previous = Infinity
  let ordered = true
  return function (page) {
    if (!(cutoff > 0) || page.length === 0) return false
    let older = true
    for (const row of page) {
      const at = Date.parse(row.updatedAt || '')
      if (!(at > 0)) return false
      if (at > previous) ordered = false
      previous = at
      if (at >= cutoff) older = false
    }
    return ordered && older
  }
}`

/**
 * Materialize the guard for tests and for any caller that wants it directly.
 * @param {string} since - ISO instant, or '' to disable early stopping.
 * @returns {(page: Array<{updatedAt?: string}>) => boolean} whether paging may stop.
 */
export function createSinceGuard(since) {
  // eslint-disable-next-line no-eval -- the source is a package constant, never caller data.
  return (0, eval)(`(${sinceGuardSource})`)(since)
}
