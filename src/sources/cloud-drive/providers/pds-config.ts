/**
 * Reading the 阿里云盘与相册服务 (PDS) credential the `aliyun pds` CLI owns.
 *
 * Same bargain as {@link module:dsh-reference-anything/cloud-drive/providers/bdpan-config}:
 * this plugin runs no OAuth flow of its own and copies nothing into its own
 * storage domain. The user logs in once with `aliyun pds config`, and
 * everything here is a read of the file that login produced.
 *
 * Unlike `bdpan`, the layout is known exactly rather than walked structurally.
 * The `aliyun pds` plugin is a closed-source Go binary, but its
 * `config.PdsConfiguration` / `config.PdsProfile` structs, their `json:` tags,
 * and the path `$HOME/.aliyun/pds_config.json` were all recovered from the
 * shipped Apache-2.0 binary's own DWARF and disassembly, so the shape below is
 * transcribed rather than guessed. It is still read defensively — a future
 * release may reshuffle it, and every field here is optional at runtime.
 *
 * The exported surface mirrors the Baidu reader deliberately:
 * {@link pdsTokenStatus} answers "is there a usable credential" without ever
 * returning the secret, and {@link readPdsToken} — which does return it — is
 * the only function that can, so every caller of the secret is greppable.
 * Nothing here throws an error carrying the token, and nothing here logs.
 *
 * @module dsh-reference-anything/cloud-drive/providers/pds-config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  EXPIRY_MARGIN_MS,
  type JsonValue,
  normalizeExpiry,
  normalizeLifetime,
  readJsonConfig,
  type TokenFileProblem,
} from './token-file.ts'

/** Where `aliyun pds` keeps its configuration, per the CLI's own default. */
export const PDS_CONFIG_PATH = join(homedir(), '.aliyun', 'pds_config.json')

/**
 * How a `domain_id` becomes an API origin when the profile states no endpoint.
 *
 * The CLI carries this same template, alongside a VPC variant it only uses
 * inside Alibaba's network. Public access is the only case this plugin can
 * serve, so only the public form is reproduced.
 */
const ENDPOINT_TEMPLATE = 'https://{domain}.api.aliyunpds.com'

/** Why a credential is not usable, in terms a user can act on. */
export type PdsTokenProblem =
  /** No config file, or one that is not JSON — the user has not run
   *  `aliyun pds config` yet, or the login it produced was damaged. */
  | TokenFileProblem
  /** Valid JSON, but it declares no profiles at all. */
  | 'no-profile'
  /** A profile was selected but carries no `access_token`. */
  | 'no-token'
  /** A token is present but names neither an endpoint nor a domain to reach. */
  | 'no-endpoint'
  /** A token is present but its stated expiry has passed. */
  | 'expired'

/** Whether a usable credential exists, and if not, why not. Never carries the secret. */
export type PdsTokenStatus =
  | {
    readonly ok: true
    readonly expiresAt?: number
    /** Display name of the signed-in account, for menus. Not a secret. */
    readonly nickName?: string
    /** Which profile answered, when the config holds more than one. */
    readonly profile?: string
  }
  | { readonly ok: false, readonly problem: PdsTokenProblem }

/** A credential and the non-secret metadata that came with it. */
export interface PdsToken {
  readonly accessToken: string
  /**
   * API origin, without a trailing slash and without the `/v2` version path.
   *
   * PDS is multi-tenant: every deployment answers on its own host, so there is
   * no constant to fall back to and this is as load-bearing as the token.
   */
  readonly endpoint: string
  /** The tenant this credential belongs to. */
  readonly domainId?: string
  /**
   * Account id. Needed to resolve the default drive, which is the only way to
   * learn a `drive_id` — the CLI's config does not carry one.
   */
  readonly userId?: string
  /** Display name of the signed-in account, for menus. Not a secret. */
  readonly nickName?: string
  /** Expiry in Unix epoch milliseconds, when the config states one. */
  readonly expiresAt?: number
}

/** One entry of the config's `profiles` array, read defensively. */
type Profile = Record<string, JsonValue>

/**
 * Read and validate the credential without disclosing it.
 *
 * @param now - current time in epoch milliseconds, injectable for tests.
 * @param path - config location; defaults to the CLI's own.
 * @returns whether a usable credential exists, and the non-secret parts of it.
 */
export async function pdsTokenStatus(
  now: number = Date.now(),
  path: string = PDS_CONFIG_PATH,
): Promise<PdsTokenStatus> {
  const profile = await loadProfile(path)
  if (typeof profile === 'string') return { ok: false, problem: profile }

  const accessToken = str(profile['access_token'])
  if (accessToken === undefined) return { ok: false, problem: 'no-token' }
  if (resolveEndpoint(profile) === undefined) return { ok: false, problem: 'no-endpoint' }

  const expiresAt = resolveExpiry(profile, now)
  if (expiresAt !== undefined && expiresAt - EXPIRY_MARGIN_MS <= now) {
    return { ok: false, problem: 'expired' }
  }

  const nickName = str(profile['nick_name'])
  const name = str(profile['name'])
  return {
    ok: true,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(nickName === undefined ? {} : { nickName }),
    ...(name === undefined ? {} : { profile: name }),
  }
}

/**
 * Read the credential itself.
 *
 * One of the two functions in this package that return a live secret. Callers
 * must pass it straight into a request and must never put it into an error, a
 * log line, a `ReferenceSummary`, or anything else that can reach the model.
 *
 * @param now - current time in epoch milliseconds, injectable for tests.
 * @param path - config location; defaults to the CLI's own.
 * @returns the credential, or `undefined` when none is usable — the caller
 * turns that into a user-facing message, because only it knows the context.
 */
export async function readPdsToken(
  now: number = Date.now(),
  path: string = PDS_CONFIG_PATH,
): Promise<PdsToken | undefined> {
  const profile = await loadProfile(path)
  if (typeof profile === 'string') return undefined

  const accessToken = str(profile['access_token'])
  if (accessToken === undefined) return undefined
  const endpoint = resolveEndpoint(profile)
  if (endpoint === undefined) return undefined
  const expiresAt = resolveExpiry(profile, now)
  if (expiresAt !== undefined && expiresAt - EXPIRY_MARGIN_MS <= now) return undefined

  const domainId = str(profile['domain_id'])
  const userId = str(profile['user_id'])
  const nickName = str(profile['nick_name'])
  return {
    accessToken,
    endpoint,
    ...(domainId === undefined ? {} : { domainId }),
    ...(userId === undefined ? {} : { userId }),
    ...(nickName === undefined ? {} : { nickName }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/**
 * Pick the profile the CLI itself would use.
 *
 * `current` names one by its `name`; a config that names a profile which does
 * not exist falls back to the first rather than failing, because the CLI's own
 * behaviour is to keep working and this is a read-only consumer of its state.
 *
 * @param path - config location.
 * @returns the selected profile, or a {@link PdsTokenProblem} naming why there
 * is none. Returning the problem rather than throwing keeps the failure out of
 * stack traces, which are the usual way a secret escapes.
 */
async function loadProfile(path: string): Promise<Profile | PdsTokenProblem> {
  const parsed = await readJsonConfig(path)
  if (!parsed.ok) return parsed.problem
  const root = parsed.value
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return 'unreadable'

  const raw = root['profiles']
  if (!Array.isArray(raw)) return 'no-profile'
  const profiles = raw.filter(isProfile)
  if (profiles.length === 0) return 'no-profile'

  const current = str(root['current'])
  const named = current === undefined
    ? undefined
    : profiles.find(profile => str(profile['name']) === current)
  return named ?? profiles[0] ?? 'no-profile'
}

/**
 * Where this profile's API lives.
 *
 * A stated `endpoint` wins, because a private or VPC deployment cannot be
 * derived from the domain. Otherwise the public template is applied, which is
 * what the CLI does for an ordinary 阿里云盘 tenant.
 *
 * @param profile - the selected profile.
 * @returns an origin with no trailing slash, or `undefined` when unreachable.
 */
function resolveEndpoint(profile: Profile): string | undefined {
  const stated = str(profile['endpoint'])
  if (stated !== undefined) {
    const absolute = /^https?:\/\//i.test(stated) ? stated : `https://${stated}`
    return absolute.replace(/\/+$/, '')
  }
  const domainId = str(profile['domain_id'])
  if (domainId === undefined) return undefined
  return ENDPOINT_TEMPLATE.replace('{domain}', encodeURIComponent(domainId))
}

/**
 * When this credential dies.
 *
 * PDS records a lifetime and a mint time rather than an instant, so the two
 * are added. An `expires_at` is honoured first anyway, in case a future
 * release adds one.
 *
 * @param profile - the selected profile.
 * @param now - current time in epoch milliseconds.
 * @returns epoch milliseconds, or `undefined` when the config states nothing
 * usable — which degrades to trying the token, not to trusting a dead one.
 */
function resolveExpiry(profile: Profile, now: number): number | undefined {
  const stated = normalizeExpiry(profile['expires_at'], now)
  if (stated !== undefined) return stated
  const createdAt = normalizeExpiry(profile['created_at'], now)
  const lifetime = normalizeLifetime(profile['expires_in'])
  if (createdAt === undefined || lifetime === undefined) return undefined
  return createdAt + lifetime
}

/** A JSON node that could be a profile. */
function isProfile(value: JsonValue): value is Profile {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty string, or `undefined` for everything else. */
function str(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
