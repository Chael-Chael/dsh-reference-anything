/**
 * Response handling shared by every drive transport.
 *
 * Small on purpose: OpenList-specific authentication and filesystem envelopes
 * belong in its provider; this module only bounds a response body and reads a
 * disclosed total size.
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

/** Total size from `Content-Range`, falling back to `Content-Length` only for a complete response. */
export function totalFromResponse(response: Response): number | undefined {
  const range = response.headers.get('content-range')
  const match = range?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i)
  if (match) {
    const start = Number(match[1]); const end = Number(match[2]); const total = Number(match[3])
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total)
      && start >= 0 && end >= start && total > end) return total
  }
  // A 206 Content-Length is only this range's length, never proof of the
  // complete object's size. Callers must fall back to trusted file metadata.
  if (response.status === 206) return undefined
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
