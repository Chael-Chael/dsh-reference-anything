/**
 * Response handling shared by every drive transport.
 *
 * Small on purpose: what the two providers genuinely have in common is how a
 * body is bounded and how a total size is read back, not how a request is
 * built. Everything above that — auth, pagination, error envelopes — differs
 * enough between 百度网盘 and PDS that sharing it would cost more than it saved.
 *
 * @module dsh-reference-anything/cloud-drive/providers/http
 */

import type { DriveEntry } from '../types.ts'

/** Minimal injectable `fetch`, so tests need no network and no global patching. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Narrowing predicate for `Array.prototype.filter`. */
export function isEntry(entry: DriveEntry | undefined): entry is DriveEntry {
  return entry !== undefined
}

/** Total size from `Content-Range`, falling back to `Content-Length`. */
export function totalFromResponse(response: Response): number | undefined {
  const range = response.headers.get('content-range')
  const slash = range?.lastIndexOf('/') ?? -1
  if (range !== null && slash !== -1) {
    const total = Number(range.slice(slash + 1))
    if (Number.isFinite(total) && total > 0) return total
  }
  const length = Number(response.headers.get('content-length'))
  return Number.isFinite(length) && length > 0 ? length : undefined
}

/**
 * Read at most `limit` bytes, then abandon the rest of the body.
 *
 * The cap is the whole point: when a CDN ignores `Range` it answers with the
 * entire file, and a caller that awaited `arrayBuffer()` would buffer all of it
 * before discovering the range was refused.
 *
 * @param response - a response whose body has not been consumed.
 * @param limit - maximum bytes to retain.
 */
export async function drain(response: Response, limit: number): Promise<Uint8Array> {
  const stream = response.body
  if (stream === null) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const take = Math.min(value.byteLength, limit - total)
      chunks.push(take === value.byteLength ? value : value.subarray(0, take))
      total += take
    }
  } finally {
    // Releases the connection instead of letting the remainder stream in.
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
