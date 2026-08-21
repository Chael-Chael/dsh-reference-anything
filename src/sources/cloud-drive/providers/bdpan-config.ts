/**
 * Reading the 百度网盘 credential the `bdpan` CLI already owns.
 *
 * This plugin deliberately does **not** run its own OAuth flow and does not
 * copy the token into its own storage domain. The user logs in once through
 * the official skill's `login.sh`, and everything here is a read of the file
 * that login produced. One credential, one lifetime, one place to revoke it.
 *
 * The exported surface is shaped by that: {@link bdpanTokenStatus} answers
 * "is there a usable credential" without ever returning the secret, and
 * {@link readBdpanToken} — which does return it — is the only function that
 * can, so every caller of the secret is greppable. Nothing here throws an
 * error carrying the token, and nothing here logs.
 *
 * @module dsh-reference-anything/cloud-drive/providers/bdpan-config
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where `bdpan` keeps its configuration, per the CLI's own default. */
export const BDPAN_CONFIG_PATH = join(homedir(), '.config', 'bdpan', 'config.json')

/** Largest config file worth parsing; a bigger one is not a credential file. */
const MAX_CONFIG_BYTES = 1024 * 1024

/**
 * Treat a credential as spent this long before its stated expiry.
 *
 * A token that expires during the round-trip it authorizes fails as a `401`
 * the caller cannot distinguish from a revoked login, so the margin buys a
 * clean "please log in again" instead.
 */
const EXPIRY_MARGIN_MS = 60_000

/** Why a credential is not usable, in terms a user can act on. */
export type BdpanTokenProblem =
  /** No config file — the user has not run the skill's `login.sh` yet. */
  | 'missing'
  /** The file exists but is not JSON, or is implausibly large. */
  | 'unreadable'
  /** Valid JSON with no `access_token` anywhere in it, encrypted or otherwise. */
  | 'no-token'
  /** A token is present but its stated expiry has passed. */
  | 'expired'

/** Whether a usable credential exists, and if not, why not. Never carries the secret. */
export type BdpanTokenStatus =
  | { readonly ok: true, readonly expiresAt?: number, readonly username?: string }
  | { readonly ok: false, readonly problem: BdpanTokenProblem }

/** A credential and the non-secret metadata that came with it. */
export interface BdpanToken {
  readonly accessToken: string
  /** Expiry in Unix epoch milliseconds, when the config states one. */
  readonly expiresAt?: number
  /** Account name, for menus. Not a secret, unlike everything else here. */
  readonly username?: string
  /**
   * Numeric account id, as a decimal string to survive `int64`.
   *
   * Needed to scope a semantic search to a directory: `unisearch` takes
   * `dirs: [{uk, path}]` and silently searches the whole drive without it.
   */
  readonly uk?: string
}

/** Anything a JSON document can hold, walked structurally rather than by schema. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Normalize the several shapes an expiry can arrive in.
 *
 * `bdpan` declares both `expires_at` and `expires_in`, and the units are not
 * documented. Rather than guess one, accept what is unambiguous and treat
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
 * Find the first node carrying a non-empty `access_token`, with its siblings.
 *
 * A structural walk rather than a fixed path, because the CLI's config layout
 * is not a published contract: the token has been seen at the root and could
 * as easily move under an account or profile key in a future release. Walking
 * costs nothing on a file this size and survives that reshuffle.
 *
 * @param root - parsed config document.
 * @returns the enclosing object, or `undefined` when no token is present.
 */
function findTokenNode(root: JsonValue): Record<string, JsonValue> | undefined {
  const queue: JsonValue[] = [root]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === null || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      queue.push(...node)
      continue
    }
    const token = node['access_token']
    if (typeof token === 'string' && token !== '') return node
    queue.push(...Object.values(node))
  }
  return undefined
}

/**
 * Read and validate the credential without disclosing it.
 *
 * @param now - current time in epoch milliseconds, injectable for tests.
 * @param path - config location; defaults to the CLI's own.
 * @returns whether a usable credential exists, and the non-secret parts of it.
 */
export async function bdpanTokenStatus(
  now: number = Date.now(),
  path: string = BDPAN_CONFIG_PATH,
): Promise<BdpanTokenStatus> {
  const node = await loadTokenNode(path)
  if (typeof node === 'string') return { ok: false, problem: node }

  const expiresAt = normalizeExpiry(node['expires_at'], now)
  if (expiresAt !== undefined && expiresAt - EXPIRY_MARGIN_MS <= now) {
    return { ok: false, problem: 'expired' }
  }
  const username = node['username']
  return {
    ok: true,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(typeof username === 'string' && username !== '' ? { username } : {}),
  }
}

/**
 * Read the credential itself.
 *
 * The only function in this package that returns a live secret. Callers must
 * pass it straight into a request and must never put it into an error, a log
 * line, a `ReferenceSummary`, or anything else that can reach the model.
 *
 * @param now - current time in epoch milliseconds, injectable for tests.
 * @param path - config location; defaults to the CLI's own.
 * @returns the credential, or `undefined` when none is usable — the caller
 * turns that into a user-facing message, because only it knows the context.
 */
export async function readBdpanToken(
  now: number = Date.now(),
  path: string = BDPAN_CONFIG_PATH,
): Promise<BdpanToken | undefined> {
  const node = await loadTokenNode(path)
  if (typeof node === 'string') return undefined

  const accessToken = node['access_token']
  if (typeof accessToken !== 'string' || accessToken === '') return undefined
  const expiresAt = normalizeExpiry(node['expires_at'], now)
  if (expiresAt !== undefined && expiresAt - EXPIRY_MARGIN_MS <= now) return undefined
  const username = node['username']
  const uk = node['uk']
  return {
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(typeof username === 'string' && username !== '' ? { username } : {}),
    ...(typeof uk === 'number' && Number.isFinite(uk) ? { uk: String(uk) }
      : typeof uk === 'string' && /^\d+$/.test(uk) ? { uk }
      : {}),
  }
}

/**
 * Shared load path for both entry points.
 *
 * @param path - config location.
 * @returns the object holding the token, or a {@link BdpanTokenProblem} naming
 * why there is none. Returning the problem rather than throwing keeps the
 * failure out of stack traces, which are the usual way a secret escapes.
 */
async function loadTokenNode(path: string): Promise<Record<string, JsonValue> | BdpanTokenProblem> {
  let text: string
  try {
    const raw = await readFile(path)
    if (raw.byteLength > MAX_CONFIG_BYTES) return 'unreadable'
    text = raw.toString('utf8')
  } catch {
    // Deliberately opaque: a missing file and an unreadable one are the same
    // instruction to the user, and the caught error may name the path.
    return 'missing'
  }

  let parsed: JsonValue
  try {
    parsed = JSON.parse(text) as JsonValue
  } catch {
    return 'unreadable'
  }

  const node = findTokenNode(parsed)
  // An encrypted config parses fine and simply has no `access_token`, which is
  // why this is one branch rather than a separate cipher-detection path.
  return node ?? 'no-token'
}
