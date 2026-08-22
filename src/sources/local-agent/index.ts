/**
 * Reference source over transcripts other coding agents leave on disk.
 *
 * Claude Code and Codex both write every session to a JSONL file under the home
 * directory. Those files are the record of work the user already did, and until
 * now the only way to bring one into a DSH session was to copy it in by hand.
 * This registers them as referenceable items instead: the `@` menu lists them,
 * and the body is read only when the model asks for it by reference.
 *
 * Reference-only by design. Nothing here writes into DSH's session store —
 * importing a transcript is a different feature with different failure modes,
 * and conflating the two would make every listed transcript a pending mutation.
 *
 * @module dsh-reference-anything/local-agent
 */

import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReferenceAnythingError } from '../../errors.ts'
import { compareMatches, scoreTitle } from '../../search.ts'
import type { TitleMatch } from '../../search.ts'
import type {
  ConversationItem,
  ReferenceRef,
  ReferenceSnapshot,
  ReferenceSource,
  ReferenceSummary,
  ReferenceWindow,
} from '../../types.ts'
import { DEFAULT_CONVERT_OPTIONS } from './adapters/shared.ts'
import { cursorExpired, cursorStillValid, decodeAgentCursor, encodeAgentCursor } from './page.ts'
import { inWorkspace } from './path.ts'
import {
  AGENT_ADAPTERS,
  AGENT_KINDS,
  DEFAULT_AGENT_KIND,
  adapterFor,
  expandRoot,
  isAgentKind,
  isQueryKind,
} from './registry.ts'
import { SESSION_SEPARATOR, listTranscripts, probeEnds, readSessionInfo, readSessionTurns, readTurns } from './scan.ts'
import type { ScanRoot, TranscriptDescriptor, TurnPage } from './scan.ts'
import { AgentBookmarkStore, localAgentDomainSpec } from './store.ts'
import type { AgentBookmark } from './store.ts'
import type {
  AgentAdapter,
  AgentKind,
  ConvertOptions,
  ParsedTurn,
  QueryAdapter,
  ToolCallMode,
  TranscriptAdapter as FileAdapter,
  TranscriptSession,
} from './types.ts'
import { isQueryAdapter } from './types.ts'
import { sliceTurns } from '../../window.ts'
import type {} from '../../index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'reference-local-agent'

/** The services this source is built on. */
export const inject = ['references', 'storageDomain']

/** Registry id, and the `source` half of every reference this source owns. */
export const LOCAL_AGENT_SOURCE_ID = 'local-agent'

/** Transcripts probed per `list()` call, so a cold cache costs a bounded read. */
const BACKFILL_PER_LIST = 24

/** Probes running at once during backfill. */
const BACKFILL_CONCURRENCY = 8

/** Deployment settings for the local agent source. */
export interface Config {
  /** Agents whose default locations are searched. */
  agents?: AgentKind[]
  /** Extra directories to search, as `~/`-prefixed or absolute paths. */
  extraRoots?: { kind: AgentKind; path: string }[]
  /** Whether discovery is limited to transcripts recorded in this workspace. */
  scope?: 'workspace' | 'all'
  /** Transcripts a directory scan will consider. */
  maxTranscripts?: number
  /** Turns one read may return, however many the caller asks for. */
  maxReadTurns?: number
  /** Bytes a read may stream before falling back to a tail-anchored pass. */
  maxScanBytes?: number
  /** Records wanted from the start of a transcript when probing for metadata. */
  headLines?: number
  /** Records wanted from its end, where the newest title lives. */
  tailLines?: number
  /** How far a probe may read chasing those records before giving up. */
  maxProbeBytes?: number
  /** Longest single record that will be materialized; longer ones are skipped. */
  maxLineBytes?: number
  /** How long one directory scan is reused across a typing burst. */
  directoryTtlMs?: number
  /** Whether the model sees the other agent's reasoning. */
  includeThinking?: boolean
  /** How a tool call is projected into a turn. */
  toolCalls?: ToolCallMode
  /** Whether subagent branches are projected alongside the main thread. */
  includeSidechains?: boolean
  /** Whether harness-injected preambles are removed from user turns. */
  stripEnvironmentPreamble?: boolean
  /** Whether the database-backed formats may be read at all. */
  sqlite?: boolean
  /** Message rows one database read may materialize, counted from the end. */
  maxSessionRecords?: number
}

/**
 * Runtime schema for {@link Config}.
 *
 * Roots are `~/`-prefixed strings expanded against the process's own home
 * rather than paths resolved at authoring time, so a profile written on one
 * machine still points somewhere sensible on another — and so an external
 * overlay describing them cannot smuggle in an evaluated expression.
 */
export const Config: z<Config> = z.object({
  // Derived from the registry rather than restated: a format is supported
  // exactly when an adapter reads it, and a list written by hand here would
  // start rejecting kinds the moment one is added.
  agents: z.array(z.union(AGENT_KINDS)).default([...AGENT_KINDS]),
  extraRoots: z.array(z.object({
    kind: z.union(AGENT_KINDS).default(DEFAULT_AGENT_KIND),
    path: z.string().default(''),
  })).default([]),
  scope: z.union(['workspace', 'all'] as const).default('workspace'),
  maxTranscripts: z.natural().default(200),
  maxReadTurns: z.natural().default(20),
  maxScanBytes: z.natural().default(32 * 1024 * 1024),
  headLines: z.natural().default(40),
  tailLines: z.natural().default(20),
  maxProbeBytes: z.natural().default(2 * 1024 * 1024),
  maxLineBytes: z.natural().default(1024 * 1024),
  directoryTtlMs: z.natural().default(5000),
  includeThinking: z.boolean().default(false),
  toolCalls: z.union(['elide', 'summarize', 'drop'] as const).default('elide'),
  includeSidechains: z.boolean().default(false),
  stripEnvironmentPreamble: z.boolean().default(true),
  // The one switch that keeps `node:sqlite` out of the process entirely.
  // Clearing the three database formats out of `agents` has the same effect,
  // but this states the intent in one place — and it is the setting to reach
  // for on a runtime whose SQLite build is not to be trusted.
  sqlite: z.boolean().default(true),
  maxSessionRecords: z.natural().default(2000),
})

/** One directory scan, reused for as long as it is fresh. */
interface DirectoryCache {
  readonly scannedAt: number
  readonly entries: readonly TranscriptDescriptor[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    referenceLocalAgents: LocalAgentService
  }
}

/** Lists and reads other agents' transcripts from the local filesystem. */
export class LocalAgentService extends Service implements ReferenceSource {
  static inject = inject
  static Config = Config
  readonly id = LOCAL_AGENT_SOURCE_ID
  /**
   * Gated: these are other sessions' conversations, often from other projects.
   * The model may read one only after its user named it.
   */
  readonly requiresGrant = true

  private readonly settings: Required<Config>
  private readonly adapters: ReadonlyMap<AgentKind, AgentAdapter>
  private readonly roots: readonly ScanRoot[]
  private readonly convert: ConvertOptions
  private cache: DirectoryCache | undefined
  private store: AgentBookmarkStore | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'referenceLocalAgents')
    this.settings = { ...defaults(), ...definedOnly(config) }
    this.adapters = new Map(AGENT_ADAPTERS.map(adapter => [adapter.kind, adapter]))
    this.roots = resolveRoots(this.settings, homedir())
    this.convert = {
      ...DEFAULT_CONVERT_OPTIONS,
      includeThinking: this.settings.includeThinking,
      toolCalls: this.settings.toolCalls,
      includeSidechains: this.settings.includeSidechains,
      stripEnvironmentPreamble: this.settings.stripEnvironmentPreamble,
    }
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(localAgentDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'reference-local-agent.domainClose')
    this.store = new AgentBookmarkStore(domain)
    this.ctx.effect(() => this.ctx.references.registerSource(this), 'reference-local-agent.registerSource()')
  }

  /**
   * @returns whether any configured root is a readable directory.
   */
  async available(): Promise<boolean> {
    const checks = await Promise.all(this.roots.map(async (root) => {
      try {
        return (await stat(root.path)).isDirectory()
      } catch {
        // An agent that is not installed has no directory; that is ordinary.
        return false
      }
    }))
    return checks.includes(true)
  }

  /**
   * List transcripts whose title or opening prompt matches `query`.
   *
   * Matching never touches a transcript's body. Ranking on body text would
   * require reading every candidate on a keystroke, and an excerpt of one would
   * put a conversation the user has not named in front of the model — the same
   * invariant the web-chat source holds.
   * @param query - case-insensitive substring; empty means the most recent.
   * @param limit - maximum items to return.
   * @param signal - cancellation from the caller.
   * @returns matching transcripts, most relevant first, at most `limit`.
   */
  list(query: string, limit: number, signal?: AbortSignal): Promise<ReferenceSummary[]> {
    return this.listIn(query, limit, process.cwd(), signal)
  }

  /**
   * The same discovery, for a caller that knows whose workspace it is asking on.
   *
   * {@link list} has nowhere to learn that from and falls back to the host
   * process's own directory, which is right for a CLI started inside the project
   * and wrong for a Web server serving sessions rooted anywhere on the machine.
   * The `@` menu comes through here instead and passes the session's own cwd, so
   * `scope: 'workspace'` means the user's workspace rather than the server's.
   * @param query - case-insensitive substring; empty means the most recent.
   * @param limit - maximum items to return.
   * @param cwd - the asking session's working directory.
   * @param signal - cancellation from the caller.
   * @returns matching transcripts, most relevant first, at most `limit`.
   */
  listForWorkspace(query: string, limit: number, cwd: string, signal?: AbortSignal): Promise<ReferenceSummary[]> {
    return this.listIn(query, limit, cwd, signal)
  }

  private async listIn(query: string, limit: number, cwd: string, signal?: AbortSignal): Promise<ReferenceSummary[]> {
    signal?.throwIfAborted()
    const entries = await this.scan(signal)
    const known = await this.describe(entries, signal)
    const workspace = this.settings.scope === 'workspace' ? cwd : undefined
    const needle = query.trim()

    const ranked: { summary: ReferenceSummary; match?: TitleMatch; mtimeMs: number }[] = []
    for (const { descriptor, bookmark } of known) {
      // A transcript known to hold no conversation is not offered: picking it
      // could only ever produce an error. Un-probed rows have no bookmark and
      // are still listed — absence of evidence is not emptiness.
      if (bookmark?.empty === true) continue
      if (workspace !== undefined && !inWorkspace(bookmark?.cwd ?? '', workspace)) continue
      const label = labelFor(descriptor, bookmark)
      const match = needle === '' ? undefined : bestMatch(label, bookmark?.firstPrompt ?? '', needle)
      if (needle !== '' && match === undefined) continue
      ranked.push({
        summary: this.summarize(descriptor, bookmark, label),
        ...match === undefined ? {} : { match },
        mtimeMs: descriptor.mtimeMs,
      })
    }

    ranked.sort((left, right) => {
      if (left.match !== undefined && right.match !== undefined) {
        const byMatch = compareMatches(left.match, right.match)
        if (byMatch !== 0) return byMatch
      }
      return right.mtimeMs - left.mtimeMs
    })
    return ranked.slice(0, limit).map(entry => entry.summary)
  }

  /**
   * Read one window of turns from a transcript.
   * @param ref - a reference this source owns; `ref.id` is `kind:relPath`.
   * @param window - which turns to return.
   * @param signal - cancellation from the caller.
   * @returns the requested turns and their position in the conversation.
   */
  async read(ref: ReferenceRef, window: ReferenceWindow, signal?: AbortSignal): Promise<ReferenceSnapshot> {
    signal?.throwIfAborted()
    const { adapter, descriptor, sessionId } = await this.locate(ref.id)
    const cursor = window.cursor === undefined ? undefined : decodeAgentCursor(window.cursor, ref.id)
    if (cursor !== undefined && !cursorStillValid(cursor, descriptor.size)) throw cursorExpired()

    // A caller may ask for more than this deployment is willing to project;
    // returning fewer is already legal, and `hasOlder` stays honest because it
    // is derived from the limit actually used.
    const limit = Math.max(1, Math.min(window.limit, this.settings.maxReadTurns))
    const bounds = resolveBefore(window, cursor)
    const page = isQueryAdapter(adapter)
      ? await this.readSession(adapter, descriptor, sessionId ?? '', limit, bounds.before, signal)
      : await readTurns(
        descriptor.path, descriptor.size, adapter, this.convert,
        { limit, ...bounds },
        { maxScanBytes: this.settings.maxScanBytes, maxLineBytes: this.settings.maxLineBytes },
        signal,
      )

    if (page.items.length === 0 && descriptor.size > 0 && window.before === undefined && cursor === undefined) {
      throw new ReferenceAnythingError(
        `transcript ${JSON.stringify(ref.id)} holds no conversation; it is an aborted session, still being written, or in a shape this adapter does not understand`,
        'REFERENCE_READ_FAILED',
      )
    }

    // Same split `describe()` makes: a database-backed session is named by the
    // row that was just read, and a file-backed one by its stored bookmark.
    const bookmark = descriptor.session === undefined
      ? this.store?.fresh(descriptor.kind, descriptor.relPath, descriptor.mtimeMs, descriptor.size)
      : sessionBookmark(descriptor, descriptor.session)
    const label = labelFor(descriptor, bookmark)
    const nextCursor = nextCursorFor(ref.id, descriptor.size, page)
    return {
      ref,
      label,
      origin: descriptor.path,
      updatedAt: descriptor.mtimeMs,
      provider: this.adapters.get(descriptor.kind)?.displayName ?? descriptor.kind,
      body: {
        kind: 'conversation',
        items: page.items.map(turn => ({ role: turn.role, text: turn.text } satisfies ConversationItem)),
        startIndex: page.startIndex,
        ...page.totalTurns === undefined ? {} : { totalTurns: page.totalTurns },
        hasOlder: page.hasOlder,
        ...nextCursor === undefined ? {} : { nextCursor },
      },
      // Two different losses, both meaning turns nobody here can reach: a
      // compaction the other agent performed, and a file too large to stream.
      partial: page.compacted || page.anchored,
      capturedAt: Date.now(),
    }
  }

  /**
   * Read one window of turns out of a database-backed session.
   *
   * A database is not streamable the way a JSONL file is: there is no byte
   * offset that means "the turn before this one", so the whole conversation is
   * materialized under a record cap and then sliced. That is affordable for the
   * same reason the cap exists — the cap is what bounds the memory, and it
   * counts from the *end*, so the turns nearest the present are the ones kept.
   * @param adapter - the adapter that knows this schema.
   * @param descriptor - the database and session to read.
   * @param sessionId - which conversation inside the database.
   * @param limit - turns to return.
   * @param before - exclusive upper bound in turn indices.
   * @param signal - cancellation from the caller.
   * @returns the same page shape a streamed read produces.
   */
  private async readSession(
    adapter: QueryAdapter,
    descriptor: TranscriptDescriptor,
    sessionId: string,
    limit: number,
    before: number | undefined,
    signal?: AbortSignal,
  ): Promise<TurnPage> {
    const session = await readSessionTurns(
      descriptor.path, adapter, sessionId, this.convert, this.settings.maxSessionRecords, signal,
    )
    const slice = sliceTurns(session.items, { limit, ...before === undefined ? {} : { before } })
    // `sliceTurns` speaks the package's wider wire type, which now admits
    // `document` for file referents. A transcript never produces one — these
    // items are the ParsedTurns handed in a line above — so the guard is a
    // narrowing, not a filter with real work to do.
    const items = slice.items.flatMap(item =>
      item.role === 'document' ? [] : [{ role: item.role, text: item.text } satisfies ParsedTurn])
    return {
      items,
      startIndex: slice.startIndex,
      // A capped read never saw the first message, so the count it can offer is
      // of what it materialized — which is not the conversation's length.
      ...session.truncated ? {} : { totalTurns: slice.totalTurns },
      hasOlder: slice.hasOlder || session.truncated,
      compacted: session.compacted,
      // `anchored` means "could not see the beginning", which a capped read
      // could not; it is what makes the snapshot report itself partial.
      anchored: session.truncated && !slice.hasOlder,
    }
  }

  /** Reuse one directory scan across a typing burst. */
  private async scan(signal?: AbortSignal): Promise<readonly TranscriptDescriptor[]> {
    const now = Date.now()
    const cached = this.cache
    if (cached !== undefined && now - cached.scannedAt < this.settings.directoryTtlMs) return cached.entries
    const entries = await listTranscripts(this.roots, this.adapters, this.settings.maxTranscripts, signal)
    this.cache = { scannedAt: now, entries }
    await this.prune(entries)
    return entries
  }

  /**
   * Drop bookmarks whose transcripts are gone, but only after a complete scan.
   *
   * A scan that hit `maxTranscripts` reports the newest files, not all of
   * them. Treating that list as everything on disk would evict the bookmark of
   * every older transcript that is still there, and each would be re-probed
   * the next time it surfaced — turning a cap on listing into a cache that can
   * never warm.
   */
  private async prune(entries: readonly TranscriptDescriptor[]): Promise<void> {
    const store = this.store
    if (store === undefined || entries.length >= this.settings.maxTranscripts) return
    await store.forgetMissing(new Set(entries
      // Session descriptors never had a bookmark written, so they contribute no
      // live keys — and including them would be harmless but misleading.
      .filter(entry => entry.session === undefined)
      .map(entry => AgentBookmarkStore.key(entry.kind, entry.relPath))))
  }

  /**
   * Pair each transcript with what is known about it, probing a bounded few.
   *
   * A transcript with no bookmark yet renders under a fallback label and is
   * picked up by a later call, because probing all of them at once would put an
   * unbounded read behind a keystroke.
   */
  private async describe(
    entries: readonly TranscriptDescriptor[],
    signal?: AbortSignal,
  ): Promise<{ descriptor: TranscriptDescriptor; bookmark: AgentBookmark | undefined }[]> {
    const store = this.store
    const paired = entries.map(descriptor => ({
      descriptor,
      // A database-backed session needs no bookmark and gets none: its `session`
      // row already carries the title, cwd, and times a probe would have to read
      // a file to find. Persisting one would also be unsound — the bookmark's
      // validity test is the *file's* mtime and size, which move whenever any
      // other conversation in the same database does.
      bookmark: descriptor.session === undefined
        ? store?.fresh(descriptor.kind, descriptor.relPath, descriptor.mtimeMs, descriptor.size)
        : sessionBookmark(descriptor, descriptor.session),
    }))
    if (store === undefined) return paired

    const stale = paired.filter(entry => entry.bookmark === undefined).slice(0, BACKFILL_PER_LIST)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(BACKFILL_CONCURRENCY, stale.length) }, async () => {
      while (next < stale.length) {
        const entry = stale[next]
        next += 1
        if (entry === undefined) break
        signal?.throwIfAborted()
        const bookmark = await this.probe(entry.descriptor, signal)
        if (bookmark === undefined) continue
        entry.bookmark = bookmark
        await store.remember(bookmark)
      }
    }))
    return paired
  }

  /** Read a transcript's two ends and fold them into a bookmark. */
  private async probe(
    descriptor: TranscriptDescriptor,
    signal?: AbortSignal,
  ): Promise<AgentBookmark | undefined> {
    const adapter = this.adapters.get(descriptor.kind)
    // A database has no two ends to probe; `describe` pairs those descriptors
    // with a bookmark of their own and never reaches this.
    if (adapter === undefined || isQueryAdapter(adapter)) return undefined
    let ends
    try {
      ends = await probeEnds(descriptor.path, descriptor.size, {
        headLines: this.settings.headLines,
        tailLines: this.settings.tailLines,
        maxProbeBytes: this.settings.maxProbeBytes,
      }, signal)
    } catch {
      // A transcript being rewritten under us is not a reason to fail the menu.
      return undefined
    }
    const head = adapter.head(ends.headLines, ends.tailLines)
    return {
      kind: descriptor.kind,
      relPath: descriptor.relPath,
      mtimeMs: descriptor.mtimeMs,
      size: descriptor.size,
      title: head.title ?? '',
      cwd: head.cwd ?? '',
      firstPrompt: head.firstPrompt ?? '',
      createdAt: head.createdAt ?? 0,
      empty: ends.complete && foldsToNothing(adapter, ends.headLines, this.convert),
      indexedAt: Date.now(),
    }
  }

  private summarize(
    descriptor: TranscriptDescriptor,
    bookmark: AgentBookmark | undefined,
    label: string,
  ): ReferenceSummary {
    return {
      ref: { source: LOCAL_AGENT_SOURCE_ID, id: referenceId(descriptor.kind, descriptor.relPath) },
      label,
      origin: descriptor.path,
      updatedAt: descriptor.mtimeMs,
      provider: this.adapters.get(descriptor.kind)?.displayName ?? descriptor.kind,
      ...bookmark === undefined ? { partial: true } : {},
    }
  }

  /**
   * Resolve a reference id to a transcript inside a configured root.
   *
   * Containment is checked against the resolved real path, so neither a `..`
   * segment nor a symlink out of a root can reach a file the deployment never
   * offered.
   */
  private async locate(id: string): Promise<{
    adapter: AgentAdapter
    descriptor: TranscriptDescriptor
    sessionId?: string
  }> {
    const parsed = parseReferenceId(id)
    const adapter = parsed === undefined ? undefined : this.adapters.get(parsed.kind)
    if (parsed === undefined || adapter === undefined) {
      throw new ReferenceAnythingError(
        `${JSON.stringify(id)} does not name a transcript this source can read`,
        'REFERENCE_NOT_FOUND',
      )
    }
    // Only a database-backed id is split, so a real filename containing `#`
    // keeps its meaning for every format that walks files.
    const split = isQueryAdapter(adapter) ? splitSession(parsed.relPath) : undefined
    const relPath = split?.relPath ?? parsed.relPath
    // One database holds many conversations, so an id naming only the file
    // names nothing readable — as does one whose separator has nothing after it.
    if (isQueryAdapter(adapter) && (split === undefined || split.sessionId === '')) {
      throw new ReferenceAnythingError(
        `${JSON.stringify(id)} names a database but no conversation inside it`,
        'REFERENCE_NOT_FOUND',
      )
    }
    for (const root of this.roots) {
      if (root.kind !== parsed.kind) continue
      const candidate = resolve(root.path, relPath)
      let real: string
      let realRoot: string
      try {
        real = await realpath(candidate)
        realRoot = await realpath(root.path)
      } catch {
        continue
      }
      if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
        throw new ReferenceAnythingError(
          `transcript ${JSON.stringify(id)} resolves outside its configured root`,
          'REFERENCE_NOT_FOUND',
        )
      }
      const stats = await stat(real).catch(() => undefined)
      if (stats === undefined || !stats.isFile()) continue
      const found = relative(realRoot, real)
      // The row that describes the conversation, which for a database is the
      // only thing that can name it: no bookmark is ever persisted for one.
      const session = split === undefined || !isQueryAdapter(adapter)
        ? undefined
        : await readSessionInfo(real, adapter, split.sessionId)
      return {
        adapter,
        descriptor: {
          kind: parsed.kind,
          path: real,
          // The id is rebuilt from what was resolved, so the descriptor the
          // caller gets round-trips back to the reference it came from.
          relPath: split === undefined ? found : `${found}${SESSION_SEPARATOR}${split.sessionId}`,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          ...session === undefined ? {} : { session },
        },
        ...split === undefined ? {} : { sessionId: split.sessionId },
      }
    }
    throw new ReferenceAnythingError(
      `no transcript named ${JSON.stringify(id)} exists under the configured roots`,
      'REFERENCE_NOT_FOUND',
    )
  }
}

/**
 * Register the local agent reference source.
 * @param ctx - the mounting context.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const agents = config.agents ?? defaults().agents
  const extraRoots = config.extraRoots ?? []
  if (agents.length === 0 && extraRoots.length === 0) {
    throw new ReferenceAnythingError(
      'reference-local-agent needs at least one entry in "agents" or "extraRoots"; mounting it with neither can never resolve a reference',
      'REFERENCE_INVALID_CONFIG',
    )
  }
  ctx.plugin(LocalAgentService, config)
}

/** Compose the reference id from the two parts that identify a transcript. */
export function referenceId(kind: AgentKind, relPath: string): string {
  return `${kind}:${relPath.split(sep).join('/')}`
}

/**
 * Split a database-backed relative path into the file and the session in it.
 *
 * Only the last separator counts: a database's own filename is far more likely
 * to contain a `#` than a session id is, and taking the last one keeps the id
 * unambiguous either way.
 * @param relPath - the relative path half of a reference id.
 * @returns the database path and session id, or undefined when none was named.
 */
export function splitSession(relPath: string): { relPath: string; sessionId: string } | undefined {
  const at = relPath.lastIndexOf(SESSION_SEPARATOR)
  if (at < 0) return undefined
  return { relPath: relPath.slice(0, at), sessionId: relPath.slice(at + 1) }
}

/**
 * Describe a database-backed session from the row that already describes it.
 *
 * Shaped as an {@link AgentBookmark} so ranking, workspace scoping, and
 * labelling need no second code path — but never written to the store, because
 * its validity test is about a file and this is about one conversation inside
 * one.
 * @param descriptor - the session's descriptor.
 * @param session - the row discovery read.
 * @returns a bookmark that is true for exactly this listing.
 */
function sessionBookmark(descriptor: TranscriptDescriptor, session: TranscriptSession): AgentBookmark {
  return {
    kind: descriptor.kind,
    relPath: descriptor.relPath,
    mtimeMs: descriptor.mtimeMs,
    size: descriptor.size,
    title: session.title,
    cwd: session.cwd,
    // A session row carries no opening prompt, so ranking matches the title
    // alone here rather than reading messages behind a keystroke.
    firstPrompt: '',
    createdAt: session.createdAt,
    empty: false,
    indexedAt: Date.now(),
  }
}

/** Split a reference id back into its parts, or undefined when it is not one. */
export function parseReferenceId(id: string): { kind: AgentKind; relPath: string } | undefined {
  const at = id.indexOf(':')
  if (at <= 0) return undefined
  const kind = id.slice(0, at)
  const relPath = id.slice(at + 1)
  if (!isAgentKind(kind) || relPath === '') return undefined
  return { kind, relPath: relPath.split('/').join(sep) }
}

/** Every configured directory, tagged with the agent that writes into it. */
function resolveRoots(settings: Required<Config>, home: string): ScanRoot[] {
  const roots: ScanRoot[] = []
  const seen = new Set<string>()
  const add = (kind: AgentKind, path: string): void => {
    // With SQLite off, the database formats get no root at all — which is what
    // keeps `node:sqlite` from ever being imported, since nothing below the
    // scan asks for a driver until a matching file has been walked to.
    if (!settings.sqlite && isQueryKind(kind)) return
    const key = `${kind}\0${path}`
    if (seen.has(key)) return
    seen.add(key)
    roots.push({ kind, path })
  }
  for (const kind of settings.agents) {
    const adapter = adapterFor(kind)
    if (adapter === undefined) continue
    for (const path of adapter.defaultRoots(home)) add(kind, path)
  }
  for (const extra of settings.extraRoots) {
    const path = expandRoot(extra.path, home)
    if (path !== undefined) add(extra.kind, path)
  }
  return roots
}

/** Where a read should start, given an explicit bound or a continuation. */
function resolveBefore(
  window: ReferenceWindow,
  cursor: ReturnType<typeof decodeAgentCursor> | undefined,
): { before?: number; beforeOffset?: number } {
  if (cursor?.kind === 'offset') return { beforeOffset: cursor.offset }
  if (cursor?.kind === 'index') return { before: cursor.index }
  return window.before === undefined ? {} : { before: window.before }
}

/** The token that would fetch the page before this one, if there is one. */
function nextCursorFor(
  id: string,
  size: number,
  page: Awaited<ReturnType<typeof readTurns>>,
): string | undefined {
  if (!page.hasOlder) return undefined
  if (page.anchored) {
    return page.startOffset === undefined
      ? undefined
      : encodeAgentCursor(id, { kind: 'offset', size, offset: page.startOffset })
  }
  return encodeAgentCursor(id, { kind: 'index', size, index: page.startIndex })
}

/** The best match across the two fields ranking is allowed to see. */
function bestMatch(label: string, firstPrompt: string, needle: string): TitleMatch | undefined {
  const onLabel = scoreTitle(label, needle)
  const onPrompt = firstPrompt === '' ? undefined : scoreTitle(firstPrompt, needle)
  if (onLabel === undefined) return onPrompt
  if (onPrompt === undefined) return onLabel
  return compareMatches(onLabel, onPrompt) <= 0 ? onLabel : onPrompt
}

/**
 * Name one transcript.
 *
 * Falls back to the filename rather than to nothing: an un-probed transcript
 * still has to be pickable, and it will carry its real title next time.
 */
/**
 * Whether folding every record of a transcript produces no turn at all.
 *
 * Runs the same fold `read()` does, so the answer cannot drift from what a read
 * would actually return — the alternative, inferring emptiness from a missing
 * title, would hide any conversation whose opening prompt sits past the probe's
 * line clip. Only meaningful over a complete set of lines.
 * @param adapter - the format's adapter.
 * @param lines - every record in the transcript.
 * @param options - the same projection settings `read()` uses.
 * @returns whether the transcript is devoid of conversation.
 */
function foldsToNothing(
  adapter: FileAdapter,
  lines: readonly string[],
  options: ConvertOptions,
): boolean {
  const state = adapter.createState()
  for (const line of lines) {
    if (adapter.step(line, state, options).length > 0) return false
  }
  return adapter.flush(state, options).length === 0
}

function labelFor(descriptor: TranscriptDescriptor, bookmark: AgentBookmark | undefined): string {
  const title = bookmark?.title.trim() ?? ''
  return title === '' ? basename(descriptor.relPath) : title
}

/** The schema's own defaults, as a plain object. */
function defaults(): Required<Config> {
  return Config({}) as Required<Config>
}

/** Drop absent keys so they do not overwrite defaults with undefined. */
function definedOnly(config: Config): Partial<Config> {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as Partial<Config>
}
