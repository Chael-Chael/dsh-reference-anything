/**
 * Reading a credential out of a CLI's own configuration file.
 *
 * Both drives this package talks to are logged into by a tool that already
 * exists — `bdpan` for 百度网盘, `aliyun pds` for PDS — and neither login is
 * re-implemented here. What the two readers share is the discipline rather than
 * the schema: bound the file, parse it without throwing, and turn every failure
 * into a value naming the problem. A thrown error carries a stack trace, and a
 * stack trace is the usual way a secret escapes.
 *
 * Nothing in this module logs, and nothing it returns or throws contains a
 * credential.
 *
 * @module dsh-reference-anything/cloud-drive/providers/token-file
 */

import { readFile } from 'node:fs/promises'

/** Largest config file worth parsing; a bigger one is not a credential file. */
const MAX_CONFIG_BYTES = 1024 * 1024

/**
 * Treat a credential as spent this long before its stated expiry.
 *
 * A token that expires during the round-trip it authorizes fails as a `401`
 * the caller cannot distinguish from a revoked login, so the margin buys a
 * clean "please log in again" instead.
 */
export const EXPIRY_MARGIN_MS = 60_000

/** Anything a JSON document can hold, walked structurally rather than by schema. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** The two ways a config file fails before its contents are even in question. */
export type TokenFileProblem =
  /** No file — the user has not logged in with that CLI yet. */
  | 'missing'
  /** The file exists but is not JSON, or is implausibly large. */
  | 'unreadable'

/**
 * Normalize the several shapes an expiry *instant* can arrive in.
 *
 * Neither CLI documents its units, and `bdpan` declares both `expires_at` and
 * `expires_in`. Rather than guess, accept what is unambiguous and treat
 * everything else as "no stated expiry" — which degrades to trying the token
 * and getting a clean auth failure, not to using a dead credential silently.
 *
 * @param raw - the value found beside an `access_token`.
 * @param now - current time in epoch milliseconds, injectable for tests.
 * @returns epoch milliseconds, or `undefined` when the value says nothing usable.
 */
export function normalizeExpiry(raw: JsonValue | undefined, now: number): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // Seconds and milliseconds are told apart by magnitude: any epoch-seconds
    // value for a date this century is far below the millisecond threshold.
    return raw < 1e12 ? raw * 1000 : raw
  }
  if (typeof raw === 'string' && raw !== '') {
    const numeric = Number(raw)
    if (Number.isFinite(numeric) && numeric > 0) return normalizeExpiry(numeric, now)
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Normalize a *duration* — a lifetime, not an instant.
 *
 * Separate from {@link normalizeExpiry} because the magnitudes do not overlap:
 * an OAuth lifetime is a handful of hours, so the seconds/milliseconds
 * threshold that distinguishes epochs would classify every plausible duration
 * as milliseconds and shorten a two-hour token to two seconds.
 *
 * @param raw - a `expires_in`-style value.
 * @returns milliseconds, or `undefined` when the value says nothing usable.
 */
export function normalizeLifetime(raw: JsonValue | undefined): number | undefined {
  const numeric = typeof raw === 'string' ? Number(raw) : raw
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) return undefined
  // A lifetime in seconds tops out around 1e8 (a few years); anything above
  // that was already milliseconds.
  return numeric < 1e10 ? numeric * 1000 : numeric
}

/**
 * A parsed credential file, or the reason there is not one.
 *
 * Tagged rather than a bare union with {@link TokenFileProblem}, because a JSON
 * document may legitimately *be* a string and `typeof result === 'string'`
 * would then read a document as a failure.
 */
export type JsonConfig =
  | { readonly ok: true, readonly value: JsonValue }
  | { readonly ok: false, readonly problem: TokenFileProblem }

/**
 * Read and parse a credential file without throwing.
 *
 * @param path - config location.
 * @returns the parsed document, or the problem that stood in the way.
 */
export async function readJsonConfig(path: string): Promise<JsonConfig> {
  let text: string
  try {
    const raw = await readFile(path)
    if (raw.byteLength > MAX_CONFIG_BYTES) return { ok: false, problem: 'unreadable' }
    text = raw.toString('utf8')
  } catch {
    // Deliberately opaque: a missing file and an unreadable one are the same
    // instruction to the user, and the caught error may name the path.
    return { ok: false, problem: 'missing' }
  }

  try {
    return { ok: true, value: JSON.parse(text) as JsonValue }
  } catch {
    return { ok: false, problem: 'unreadable' }
  }
}
