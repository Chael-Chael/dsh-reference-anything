/**
 * Reference source over DeepSeek web chats, read from a browser the user is
 * already signed in to.
 *
 * There is no other way in. `chat.deepseek.com` sits behind an AWS WAF that
 * answers any plain HTTP request — including one for a public `/share/` link —
 * with a challenge, so nothing headless can fetch a conversation. A browser
 * that has already passed that challenge can.
 *
 * What this source will not do, at any configuration:
 *
 * - **Start a browser.** The endpoint exists because the user opened it, or
 *   this source does nothing. That is the opt-in.
 * - **Navigate, click, or scroll.** The page belongs to the user; reading it is
 *   the whole mandate. This is also why a virtualized conversation reports
 *   {@link ReferenceSnapshot.partial} rather than scrolling to see more.
 * - **Evaluate anything caller-supplied.** The expression is a package
 *   constant; no model, tool, or config value is ever interpolated into it.
 * - **Expose evaluation.** Only `list` and `read` exist, so no tool can reach
 *   the browser through this service.
 *
 * @module dsh-reference-anything/deepseek
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReferenceAnythingError } from '../../errors.ts'
import type {
  ReferenceRef,
  ReferenceSnapshot,
  ReferenceSource,
  ReferenceSummary,
  ReferenceWindow,
} from '../../types.ts'
import { sliceTurns } from '../../window.ts'
import { httpCdpTransport, type CdpTarget, type CdpTransport } from '../../cdp/transport.ts'
import { EXTRACT_CONVERSATION, parseDeepSeekPayload } from './extract.ts'
import type {} from '../../index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'reference-deepseek'

/** The registry this source registers into. */
export const inject = ['references']

/** Registry id, and the `source` half of every reference this source owns. */
export const DEEPSEEK_SOURCE_ID = 'deepseek'

/** Origins this source reads when a deployment names none. */
export const DEFAULT_ORIGINS = ['https://chat.deepseek.com']

/** Deployment settings for the DeepSeek source. */
export interface Config {
  /**
   * Base URL of an already-running browser's DevTools endpoint, e.g.
   * `http://127.0.0.1:9222`. Required and never defaulted: attaching to a
   * browser is a decision the user has to make, and a default would make it
   * for them.
   */
  endpoint?: string
  /** Page origins this source will read. Checked before anything is evaluated. */
  origins?: string[]
  /** How long one page has to answer before the read fails. */
  evaluateTimeoutMs?: number
  /** Upper bound on turns taken from one page, before any window is applied. */
  maxTurns?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  endpoint: z.string(),
  origins: z.array(z.string()).default([...DEFAULT_ORIGINS]),
  evaluateTimeoutMs: z.number().step(1).min(1).default(5_000),
  maxTurns: z.number().step(1).min(1).default(400),
})

/** Resolved settings, after defaults. */
export interface DeepSeekOptions {
  readonly endpoint: string
  readonly origins: readonly string[]
  readonly evaluateTimeoutMs: number
  readonly maxTurns: number
}

/** Reads DeepSeek conversations out of tabs the user already has open. */
export class DeepSeekReferenceSource implements ReferenceSource {
  readonly id = DEEPSEEK_SOURCE_ID

  /**
   * @param transport - the CDP seam; injected so tests need no browser.
   * @param options - resolved deployment settings.
   */
  constructor(
    private readonly transport: CdpTransport,
    private readonly options: DeepSeekOptions,
  ) {}

  /**
   * Cheap and local, as the interface requires: whether a deployment opted in
   * at all. Whether the browser is actually running is discovered on use, and
   * reported as a failure the user can act on.
   * @returns whether an endpoint is configured.
   */
  available(): Promise<boolean> {
    return Promise.resolve(this.options.endpoint.trim() !== '')
  }

  /**
   * List the DeepSeek conversations currently open in the browser.
   * @param query - case-insensitive substring matched against tab titles.
   * @param limit - maximum items to return.
   * @param signal - cancellation from the caller.
   * @returns one entry per matching open conversation tab.
   */
  async list(query: string, limit: number, signal?: AbortSignal): Promise<ReferenceSummary[]> {
    const needle = query.toLocaleLowerCase()
    return this.conversationTabs(signal)
      .then(tabs => tabs
        .filter(tab => needle === '' || tab.label.toLocaleLowerCase().includes(needle))
        .slice(0, limit)
        .map(tab => ({
          ref: { source: DEEPSEEK_SOURCE_ID, id: tab.id },
          label: tab.label,
          origin: tab.target.url,
        })))
  }

  /**
   * Read one window of turns from an open conversation tab.
   * @param ref - a reference this source owns; `ref.id` is the conversation id.
   * @param window - which turns to return.
   * @param signal - cancellation from the caller.
   * @returns the requested turns and their position.
   */
  async read(ref: ReferenceRef, window: ReferenceWindow, signal?: AbortSignal): Promise<ReferenceSnapshot> {
    const tabs = await this.conversationTabs(signal)
    const tab = tabs.find(candidate => candidate.id === ref.id)
    if (tab === undefined) {
      throw new ReferenceAnythingError(
        `no open DeepSeek tab is showing conversation ${JSON.stringify(ref.id)};`
        + ' open it in the attached browser and try again',
        'CDP_NO_MATCHING_TARGET',
      )
    }
    const raw = await this.transport.evaluate(
      tab.target,
      EXTRACT_CONVERSATION,
      this.options.evaluateTimeoutMs,
      signal,
    )
    const extracted = parseDeepSeekPayload(raw, tab.label)
    // Bound what one page can contribute before any window arithmetic, so a
    // pathological conversation cannot dominate memory on the way in.
    const capped = extracted.items.length > this.options.maxTurns
      ? extracted.items.slice(-this.options.maxTurns)
      : extracted.items
    const whole = extracted.complete && capped.length === extracted.items.length
    const slice = sliceTurns(capped, window)
    return {
      ref,
      label: extracted.title ?? tab.label,
      origin: tab.target.url,
      // `sliceTurns` counts against what it was handed. When that was only
      // part of the conversation, its total would be a claim about the page
      // rather than about the chat, so it is dropped instead of published.
      body: whole
        ? slice
        : { kind: slice.kind, items: slice.items, startIndex: slice.startIndex, hasOlder: slice.hasOlder },
      // Scrolling would reveal more and this source will not scroll, so
      // whatever the page held back is genuinely out of reach from here.
      partial: !whole,
      capturedAt: Date.now(),
    }
  }

  /** Open tabs on an allowed origin that show a conversation. */
  private async conversationTabs(signal?: AbortSignal): Promise<
    { id: string; label: string; target: CdpTarget }[]
  > {
    const targets = await this.transport.listTargets(signal)
    return targets.flatMap((target) => {
      if (target.type !== 'page') return []
      if (!isAllowedOrigin(target.url, this.options.origins)) return []
      const id = conversationIdOf(target.url)
      if (id === undefined) return []
      return [{ id, label: tabLabel(target), target }]
    })
  }
}

/**
 * Whether a page URL is one this deployment allows reading.
 *
 * Compared by parsed origin rather than by prefix: a prefix test would accept
 * `https://chat.deepseek.com.example.net/`.
 * @param url - the page's URL.
 * @param origins - the configured allowlist.
 * @returns whether the page may be read.
 */
export function isAllowedOrigin(url: string, origins: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Targets like `about:blank` and devtools pages have no useful origin.
    return false
  }
  return origins.some((allowed) => {
    try {
      return new URL(allowed).origin === parsed.origin
    } catch {
      return false
    }
  })
}

/**
 * Recover the conversation id from a DeepSeek chat URL.
 *
 * The web app routes conversations as `/a/chat/s/<id>`. This is undocumented
 * and could change; a URL that does not match simply is not a conversation
 * tab, which is why the conversation list quietly skips it.
 * @param url - the page's URL.
 * @returns the conversation id, or undefined when the URL is not a conversation.
 */
export function conversationIdOf(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const match = /\/chat\/s\/([^/?#]+)/u.exec(parsed.pathname)
  return match?.[1]
}

function tabLabel(target: CdpTarget): string {
  const title = target.title.replace(/\s*[|-]\s*DeepSeek.*$/iu, '').trim()
  return title === '' ? conversationIdOf(target.url) ?? target.id : title
}

/**
 * Register the DeepSeek reference source.
 * @param ctx - the mounting context.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const endpoint = config.endpoint?.trim() ?? ''
  if (endpoint === '') {
    throw new ReferenceAnythingError(
      'reference-deepseek needs an "endpoint" naming a running browser\'s DevTools port'
      + ' (start Chrome with --remote-debugging-port and set it here); it never starts a browser itself',
      'REFERENCE_INVALID_CONFIG',
    )
  }
  const options: DeepSeekOptions = {
    endpoint,
    origins: config.origins ?? DEFAULT_ORIGINS,
    evaluateTimeoutMs: config.evaluateTimeoutMs ?? 5_000,
    maxTurns: config.maxTurns ?? 400,
  }
  const source = new DeepSeekReferenceSource(httpCdpTransport(endpoint), options)
  ctx.effect(() => ctx.references.registerSource(source), 'reference-deepseek.registerSource()')
}
