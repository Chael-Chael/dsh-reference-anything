/**
 * Persistent title bookmarks for local agent transcripts.
 *
 * The `@` menu fires per keystroke against a corpus measured here at 2.9 GB
 * across 753 files. Reading even a bounded probe from each of them on that path
 * is out of the question, so what a probe learned once is written down: after
 * the first sighting, a transcript renders from this table with no file read at
 * all.
 *
 * A bookmark is valid only when **both** `mtimeMs` and `size` still match a
 * fresh stat. Either alone is forgeable by ordinary activity — an editor can
 * rewrite a file to the same length, and a filesystem with coarse timestamps
 * can leave mtime unmoved across an append within the same tick.
 *
 * This opens its **own** domain rather than adding a table to
 * `reference_anything`. `DomainService.open()` throws `already-open`, and the
 * web-chat service already holds that domain open; sharing it would make this
 * plugin unloadable without that one.
 *
 * @module dsh-reference-anything/local-agent/store
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** What one probe learned about a transcript, and the stat it was true for. */
export const agentBookmarkSchema = z.object({
  /** Agent whose transcript this is; a string here so an unknown kind parses. */
  kind: z.string(),
  /** Path relative to its root — the stable half of the reference id. */
  relPath: z.string(),
  /** Stat this bookmark was derived from; both must match to trust it. */
  mtimeMs: z.number(),
  size: z.number().int().nonnegative(),
  /** Display name. Empty means the probe found none and the caller falls back. */
  title: z.string().default(''),
  /** Recorded working directory, for workspace scoping. */
  cwd: z.string().default(''),
  /** Opening prompt, matched during ranking alongside the title. */
  firstPrompt: z.string().default(''),
  /** When the transcript was started, in Unix epoch milliseconds; 0 if unknown. */
  createdAt: z.number().default(0),
  /**
   * The whole transcript was read and folded to no turns at all.
   *
   * Aborted sessions are common — a window opened and `/clear`ed leaves a file
   * of pure CLI plumbing, 12 of 249 transcripts on the machine this was
   * measured against. Listing one offers the user something that can only fail
   * when picked, so discovery drops it. Defaults false so a bookmark written
   * before this field existed reads as "not known to be empty" and still lists.
   */
  empty: z.boolean().default(false),
  /** When this bookmark was written, in Unix epoch milliseconds. */
  indexedAt: z.number().default(0),
})
export type AgentBookmark = z.infer<typeof agentBookmarkSchema>

/** Storage for this plugin alone, versioned independently of the web-chat one. */
export const localAgentDomainSpec = defineDomain({
  name: 'reference_local_agents',
  version: 1,
  tables: {
    bookmarks: domainTable<string, AgentBookmark>(agentBookmarkSchema),
  },
})

type LocalAgentDomain = Domain<typeof localAgentDomainSpec>

/** Reads and writes transcript bookmarks. */
export class AgentBookmarkStore {
  readonly bookmarks: KvTable<string, AgentBookmark>

  constructor(readonly domain: LocalAgentDomain) {
    this.bookmarks = domain.table('bookmarks')
  }

  /**
   * Key one transcript.
   *
   * `NUL` separates the two halves because it is the one byte a path cannot
   * contain, so no `kind`/`relPath` pair can collide with another.
   */
  static key(kind: string, relPath: string): string {
    return `${kind}\0${relPath}`
  }

  /**
   * Look up a bookmark that still describes the file on disk.
   * @param kind - the agent whose transcript this is.
   * @param relPath - its root-relative path.
   * @param mtimeMs - modification time from a fresh stat.
   * @param size - size in bytes from the same stat.
   * @returns the bookmark, or undefined when absent or stale.
   */
  fresh(kind: string, relPath: string, mtimeMs: number, size: number): AgentBookmark | undefined {
    const row = this.bookmarks.get(AgentBookmarkStore.key(kind, relPath))
    if (row === undefined) return undefined
    return row.mtimeMs === mtimeMs && row.size === size ? row : undefined
  }

  /**
   * Record what a probe learned.
   * @param bookmark - the bookmark to persist, already stamped with its stat.
   */
  async remember(bookmark: AgentBookmark): Promise<void> {
    await this.bookmarks.put(AgentBookmarkStore.key(bookmark.kind, bookmark.relPath), bookmark)
  }

  /**
   * Drop bookmarks for transcripts that are no longer on disk.
   *
   * Without this the table grows for the life of the installation, since a
   * deleted transcript is simply never asked about again.
   * @param live - keys currently present, from a directory scan.
   */
  async forgetMissing(live: ReadonlySet<string>): Promise<void> {
    for (const [key] of this.bookmarks.entries()) {
      if (!live.has(key)) await this.bookmarks.delete(key)
    }
  }
}
