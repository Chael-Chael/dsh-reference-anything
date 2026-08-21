/**
 * Vocabulary for referencing files that live in a personal cloud drive.
 *
 * A drive is not a conversation, and the difference shapes everything here. A
 * transcript is append-only and self-describing; a drive holds arbitrary bytes
 * behind an authenticated, rate-limited, latency-bound API, and the same file
 * can be reachable three different ways depending on what the provider has
 * already indexed. So a provider is not a parser — it is a small transport
 * that answers three questions: what is in here, is there text I can have
 * without downloading, and can I read a byte range.
 *
 * The types are free of `node:fs` and cordis so a provider can be exercised
 * against a stub `fetch` without mounting a plugin.
 *
 * @module dsh-reference-anything/cloud-drive/types
 */

import type { FetchLike } from './providers/http.ts'

/**
 * One supported drive product.
 *
 * Named after the product rather than the protocol, because the two APIs agree
 * on almost nothing: Baidu addresses a file by a bare `int64` while PDS needs a
 * file id *and* a drive id, and their pagination models have no common shape.
 */
export type DriveKind =
  /** 百度网盘, sandboxed to the `/apps/bdpan/` application directory. */
  | 'baidu'
  /** 阿里云盘与相册服务 (PDS), `alibabacloud-pds-intelligent-workspace`. */
  | 'pds'

/**
 * One file or folder as listing sees it, without its bytes.
 *
 * Deliberately smaller than a `ReferenceSummary`: this is the provider's own
 * vocabulary, and the mapping into the package's public wire types happens in
 * one place so a provider cannot accidentally widen what reaches the client.
 */
export interface DriveEntry {
  /** Which provider owns {@link DriveEntry.id}. */
  readonly kind: DriveKind
  /**
   * Provider-scoped opaque id, stable across listings.
   *
   * Never parsed outside its owning provider. Baidu puts an `fs_id` here; PDS
   * will need a composite, and that is precisely why callers must not read it.
   */
  readonly id: string
  /** Basename for display, never empty — a nameless file falls back to its id. */
  readonly name: string
  /**
   * Full path as the provider displays it.
   *
   * User-facing only. Baidu returns a localized display path
   * (`我的应用数据/…`) that is *not* the path its own API accepts, so this is a
   * label and never an argument.
   */
  readonly path: string
  /** Size in bytes; `0` for a folder. */
  readonly size: number
  /** Last modification in Unix epoch milliseconds, when the provider reports it. */
  readonly modifiedAt?: number
  /** Folders are listed so the menu can show structure, but they are not readable. */
  readonly isDirectory: boolean
  /**
   * Server-extracted passage that came back with this entry, if any.
   *
   * Only semantic search produces this — a directory listing never does. It is
   * a *recalled passage*, not the document, so it is a preview and never a
   * substitute for a real read.
   *
   * Never copied into a `ReferenceSummary`: summaries flow to the client and
   * into snippet-adjacent surfaces, and body text belongs only inside
   * `reference_read`'s untrusted-data envelope.
   */
  readonly excerpt?: string
}

/** What one ranged read actually returned. */
export interface DriveReadResult {
  /** The bytes received, which may be fewer than requested at end of file. */
  readonly bytes: Uint8Array
  /**
   * Whether the provider honoured the requested range.
   *
   * `false` means it answered a range request with the whole file. The caller
   * must be able to tell, because silently absorbing a multi-gigabyte body is
   * the exact failure a ranged read exists to prevent.
   */
  readonly ranged: boolean
  /** Total file size when the response disclosed it, in bytes. */
  readonly totalSize?: number
}

/**
 * One drive's transport: authentication, listing, and reading.
 *
 * Kept minimal on purpose. This interface was written against Baidu alone and
 * must be re-examined when the second implementation lands — generalizing two
 * APIs that share no identifier scheme, no pagination model, and no path
 * semantics before either one is working produces an abstraction that fits
 * neither.
 */
/**
 * Construction-time seams every provider accepts.
 *
 * Uniform across drives even though the fields mean different things in each:
 * `root` is a sandbox path for 百度网盘 and a folder id (or an absolute path to
 * resolve into one) for PDS. Keeping one shape lets the registry build any
 * provider from one config row, and the divergence is documented on each
 * implementation rather than encoded in the type.
 */
export interface DriveProviderOptions {
  /** Where listing starts when the user has typed no query. */
  readonly root?: string
  /** HTTP transport; defaults to the global `fetch`. */
  readonly fetch?: FetchLike
  /** Clock in epoch milliseconds, for credential expiry and signed-URL aging. */
  readonly now?: () => number
  /** Credential location; defaults to the drive's own CLI config path. */
  readonly configPath?: string
}

export interface DriveProvider {
  readonly kind: DriveKind
  /** Product name for menus and error text. */
  readonly displayName: string
  /**
   * Whether a usable credential exists locally.
   *
   * Must stay local: no network, no subprocess. Discovery calls this on every
   * source before fanning out, and a configured-but-offline drive should
   * report available and fail inside {@link DriveProvider.list} instead, so a
   * dead network reads as a failed listing rather than a vanished menu group.
   */
  credentialed(): Promise<boolean>
  /**
   * Enumerate entries matching a query.
   * @param query - free text; empty means "the default directory listing".
   * @param limit - hard cap on returned entries.
   * @param signal - cancellation from the caller.
   */
  list(query: string, limit: number, signal?: AbortSignal): Promise<readonly DriveEntry[]>
  /**
   * Describe one file without downloading it.
   *
   * Exists because a reference outlives the listing that produced it: a
   * mention pasted into tomorrow's session names an id and nothing else, and
   * the read that follows still has to report a label and decide whether the
   * file is text before it spends a byte of transfer quota.
   *
   * @param id - a {@link DriveEntry.id} this provider owns.
   * @param signal - cancellation from the caller.
   * @returns the entry, or `undefined` when no such file exists.
   */
  describe(id: string, signal?: AbortSignal): Promise<DriveEntry | undefined>
  /**
   * Tier 1: text the server already extracted, with no download.
   * @returns the passage, or `undefined` when the provider has none — which is
   * the common case and not an error.
   */
  extractedText(id: string, signal?: AbortSignal): Promise<string | undefined>
  /**
   * Whether ranged reads work, or `undefined` until the first read has probed.
   *
   * Resolved at runtime rather than declared, because neither product
   * documents `Range` support and the official SDK exposes no offset at all. A
   * range request answered with `200` demotes the provider for the rest of the
   * process.
   */
  supportsRange: boolean | undefined
  /**
   * Read bytes `[start, end)`.
   *
   * @param id - a {@link DriveEntry.id} this provider owns.
   * @param start - first byte, counted from zero.
   * @param end - exclusive upper bound.
   * @param signal - cancellation from the caller.
   * @returns the bytes plus whether the range was honoured.
   */
  read(id: string, start: number, end: number, signal?: AbortSignal): Promise<DriveReadResult>
}
