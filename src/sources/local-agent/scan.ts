/**
 * Filesystem access for local agent transcripts.
 *
 * Everything that touches the disk lives here, so the adapters stay pure and
 * testable against inline fixtures. Two facts about the corpus shape every
 * function below, both measured rather than assumed:
 *
 * - **Transcripts are large.** 541 Claude files totalling 734 MB and 212 Codex
 *   rollouts totalling 2.24 GB sit on the machine this was written against, the
 *   largest single rollout being 192 MB. Nothing here may read a whole file.
 * - **Lines are large and wildly uneven.** In one 21 MB rollout: p50 = 812 B,
 *   p90 = 14 KB, p99 = 1.4 MB, max = 4.0 MB. A fixed 32 KiB probe window
 *   recovers exactly one complete line there — which is why probes escalate by
 *   *lines wanted* under a byte ceiling, and why the streaming pass budgets in
 *   bytes rather than lines.
 *
 * @module dsh-reference-anything/local-agent/scan
 */

import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { ReferenceAnythingError } from '../../errors.ts'
import { withDatabase } from './sqlite.ts'
import type {
  AgentAdapter,
  AgentKind,
  ConvertOptions,
  ParsedTurn,
  QueryAdapter,
  SessionTurns,
  TranscriptAdapter,
  TranscriptSession,
} from './types.ts'
import { isQueryAdapter } from './types.ts'

/** One directory to search, and the agent whose transcripts live in it. */
export interface ScanRoot {
  readonly kind: AgentKind
  /** Absolute path; already expanded from any `~/` prefix. */
  readonly path: string
}

/** One transcript found on disk, described without reading a byte of it. */
export interface TranscriptDescriptor {
  readonly kind: AgentKind
  /** Absolute path, for reading. */
  readonly path: string
  /**
   * Path relative to its root — the stable half of the reference id.
   *
   * For a database-backed format this is `<database>#<session id>`, because one
   * file holds many conversations and a reference has to name which. The `#`
   * costs nothing elsewhere: it is not a path separator, so the id round-trip
   * and the bookmark key are unchanged, and a real filename containing one
   * still belongs to a file-backed format that never splits on it.
   */
  readonly relPath: string
  readonly mtimeMs: number
  readonly size: number
  /**
   * The session row, for a database-backed format only.
   *
   * A `session` row already carries the title, working directory, and times a
   * probe would otherwise have to read a file to find, so a query descriptor
   * arrives complete and never needs backfilling.
   */
  readonly session?: TranscriptSession
}

/** Separates a database from the session inside it, in a reference id. */
export const SESSION_SEPARATOR = '#'

/** Directory depth walked below each root. */
const MAX_DEPTH = 6

/** Probe windows, in bytes, tried in order until enough lines are recovered. */
const PROBE_STEPS = [32 * 1024, 256 * 1024, 2 * 1024 * 1024] as const

/** Chunk size for walking a large transcript backwards from its end. */
const TAIL_CHUNK_BYTES = 1024 * 1024

/** How far a probe may read before giving up on a transcript's metadata. */
export interface ProbeLimits {
  readonly headLines: number
  readonly tailLines: number
  readonly maxProbeBytes: number
}

/** Complete records recovered from the two ends of a transcript. */
export interface TranscriptEnds {
  readonly headLines: readonly string[]
  readonly tailLines: readonly string[]
  /**
   * Whether `headLines` is the whole file rather than a window onto its start.
   *
   * Only true when the first probe window already reached EOF, which is what
   * lets a caller conclude something from an *absence*: a transcript that folds
   * to no turns is only known to hold no conversation if every one of its
   * records was seen. Without this flag a short probe of a long file looks
   * identical to a complete probe of an aborted one.
   */
  readonly complete: boolean
}

/** How much of a transcript one read may touch. */
export interface ReadLimits {
  /** Total bytes a single read may consume before it falls back to the tail. */
  readonly maxScanBytes: number
  /** Longest single line that will be materialized; longer ones are skipped. */
  readonly maxLineBytes: number
}

/** Which turns to materialize. */
export interface TurnRequest {
  readonly limit: number
  /** Exclusive upper bound in turn indices; absent means the newest turns. */
  readonly before?: number
  /** Tail-anchored paging: only bytes below this offset may be read. */
  readonly beforeOffset?: number
}

/** The turns one read produced, and where they sit in the transcript. */
export interface TurnPage {
  readonly items: readonly ParsedTurn[]
  /** Index of `items[0]`; always 0 when the read was tail-anchored. */
  readonly startIndex: number
  /** Exact count, or undefined when the read never saw the beginning. */
  readonly totalTurns?: number
  readonly hasOlder: boolean
  /** Whether the transcript records a compaction, so earlier turns are gone. */
  readonly compacted: boolean
  /** Whether the read was tail-anchored and so could not see the beginning. */
  readonly anchored: boolean
  /** Byte offset the first returned turn began at; only set when anchored. */
  readonly startOffset?: number
}

/**
 * Find every transcript under the given roots.
 *
 * Reads directory entries and stats only — no file contents — because this runs
 * behind a keystroke debounce. A root that does not exist is an ordinary state
 * (that agent is not installed) and is skipped rather than raised.
 * @param roots - directories to search, each tagged with its agent.
 * @param adapters - adapters by kind, used to test filenames.
 * @param maxTranscripts - most descriptors to return, newest first.
 * @param signal - cancellation from the caller.
 * @returns descriptors sorted newest-modified first, at most `maxTranscripts`.
 */
export async function listTranscripts(
  roots: readonly ScanRoot[],
  adapters: ReadonlyMap<AgentKind, AgentAdapter>,
  maxTranscripts: number,
  signal?: AbortSignal,
): Promise<TranscriptDescriptor[]> {
  const found: TranscriptDescriptor[] = []
  for (const root of roots) {
    const adapter = adapters.get(root.kind)
    if (adapter === undefined) continue
    await walk(root, root.path, 0, adapter, found, signal, maxTranscripts)
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return found.slice(0, maxTranscripts)
}

async function walk(
  root: ScanRoot,
  dir: string,
  depth: number,
  adapter: AgentAdapter,
  found: TranscriptDescriptor[],
  signal?: AbortSignal,
  maxSessions = 200,
): Promise<void> {
  signal?.throwIfAborted()
  if (depth > MAX_DEPTH) return
  // An unreadable directory is one nothing could be referenced from anyway;
  // the remaining roots still list.
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(root, path, depth + 1, adapter, found, signal, maxSessions)
      continue
    }
    if (!entry.isFile()) continue
    const relPath = relative(root.path, path)
    if (!adapter.matches(relPath)) continue
    const stats = await stat(path).catch(() => undefined)
    if (stats === undefined) continue
    if (isQueryAdapter(adapter)) {
      found.push(...await expandSessions(root.kind, path, relPath, stats.mtimeMs, stats.size, adapter, maxSessions))
      continue
    }
    found.push({ kind: root.kind, path, relPath, mtimeMs: stats.mtimeMs, size: stats.size })
  }
}

/**
 * Turn one database into a descriptor per conversation inside it.
 *
 * This is the only place discovery reads content rather than directory
 * metadata, and it is affordable for the same reason the bookmark table exists:
 * the session list is a single indexed query over a few hundred small rows,
 * where the file-backed formats would need a byte probe per transcript.
 * @param kind - the format this root holds.
 * @param path - absolute path to the database.
 * @param relPath - the database's path relative to its root.
 * @param mtimeMs - the database file's modification time, used when a session has none.
 * @param size - the database file's size, which is what a cursor is validated against.
 * @param adapter - the adapter that knows this schema.
 * @param limit - most sessions to take from this database.
 * @returns one descriptor per session, or none when the database was unreadable.
 */
async function expandSessions(
  kind: AgentKind,
  path: string,
  relPath: string,
  mtimeMs: number,
  size: number,
  adapter: QueryAdapter,
  limit: number,
): Promise<TranscriptDescriptor[]> {
  const sessions = await withDatabase(path, db => adapter.sessions(db, limit))
  if (sessions === undefined) return []
  return sessions.map(session => ({
    kind,
    path,
    relPath: `${relPath}${SESSION_SEPARATOR}${session.id}`,
    // The session's own recency, so the menu orders conversations rather than
    // giving every session in one database the same position.
    mtimeMs: session.updatedAt > 0 ? session.updatedAt : mtimeMs,
    size,
    session,
  }))
}

/**
 * Look up the row that describes one conversation.
 *
 * A read may arrive without a listing having preceded it — the model can hold a
 * reference id across turns, and `locate()` resolves a path rather than
 * replaying discovery — so this is what gives a database-backed snapshot its
 * title, working directory, and times.
 * @param path - absolute path to the database.
 * @param adapter - the adapter that knows this schema.
 * @param sessionId - which conversation to describe.
 * @param signal - cancellation from the caller.
 * @returns the session row, or undefined when the database or the row is unreadable.
 */
export async function readSessionInfo(
  path: string,
  adapter: QueryAdapter,
  sessionId: string,
  signal?: AbortSignal,
): Promise<TranscriptSession | undefined> {
  signal?.throwIfAborted()
  return await withDatabase(path, db => adapter.session(db, sessionId))
}

/**
 * Read one conversation out of a database.
 * @param path - absolute path to the database.
 * @param adapter - the adapter that knows this schema.
 * @param sessionId - which conversation to fold.
 * @param options - projection settings.
 * @param maxRecords - most message rows to materialize, counted from the end.
 * @param signal - cancellation from the caller.
 * @returns the folded turns, oldest first.
 */
export async function readSessionTurns(
  path: string,
  adapter: QueryAdapter,
  sessionId: string,
  options: ConvertOptions,
  maxRecords: number,
  signal?: AbortSignal,
): Promise<SessionTurns> {
  signal?.throwIfAborted()
  const page = await withDatabase(path, db => adapter.turns(db, sessionId, options, maxRecords))
  if (page === undefined) {
    throw new ReferenceAnythingError(
      `could not read ${JSON.stringify(adapter.displayName)} database ${JSON.stringify(path)}; it is missing, locked, or in a shape this adapter does not understand`,
      'REFERENCE_READ_FAILED',
    )
  }
  return page
}

/**
 * Recover complete records from both ends of a transcript.
 *
 * Escalates through {@link PROBE_STEPS} until enough complete lines are in hand
 * or the byte ceiling is reached, because a fixed window cannot serve a corpus
 * whose p99 line is 1.4 MB. Giving up returns whatever was recovered rather
 * than throwing: a transcript with no readable metadata still lists, under a
 * fallback label.
 * @param path - absolute path to the transcript.
 * @param size - its size in bytes, from a prior stat.
 * @param limits - how many lines are wanted and how far to read for them.
 * @param signal - cancellation from the caller.
 * @returns the complete records found at each end.
 */
export async function probeEnds(
  path: string,
  size: number,
  limits: ProbeLimits,
  signal?: AbortSignal,
): Promise<TranscriptEnds> {
  signal?.throwIfAborted()
  // Nothing to recover, but the absence is conclusive: an empty file holds no
  // conversation, and saying so beats making the caller guess.
  if (size === 0) return { headLines: [], tailLines: [], complete: true }
  const handle = await open(path, 'r')
  try {
    const head = await probeEnd(handle, size, limits.headLines, limits.maxProbeBytes, 'head', signal)
    const tail = await probeEnd(handle, size, limits.tailLines, limits.maxProbeBytes, 'tail', signal)
    return { headLines: head.lines, tailLines: tail.lines, complete: head.covered }
  } finally {
    await handle.close()
  }
}

async function probeEnd(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  wanted: number,
  maxProbeBytes: number,
  end: 'head' | 'tail',
  signal?: AbortSignal,
): Promise<{ lines: string[]; covered: boolean }> {
  if (wanted <= 0) return { lines: [], covered: false }
  let recovered: string[] = []
  let covered = false
  for (const step of PROBE_STEPS) {
    signal?.throwIfAborted()
    const span = Math.min(step, maxProbeBytes, size)
    const offset = end === 'head' ? 0 : size - span
    const buffer = Buffer.alloc(span)
    const { bytesRead } = await handle.read(buffer, 0, span, offset)
    // A partial line sits at the window's inner edge unless the window reached
    // that end of the file, in which case the line really does terminate there.
    recovered = splitComplete(buffer.subarray(0, bytesRead).toString('utf8'), {
      dropFirst: end === 'tail' && offset > 0,
      dropLast: end === 'head' && span < size,
    })
    covered = span >= size
    if (recovered.length >= wanted || covered || span >= maxProbeBytes) break
  }
  // A window that swallowed the file is returned whole rather than clipped to
  // `wanted`. The extra lines cost nothing to fold, and they are what makes a
  // "no turns here" answer trustworthy — and they sharpen titles besides, since
  // a short session's opening prompt can sit past the line the clip would keep.
  if (end === 'head') return { lines: covered ? recovered : recovered.slice(0, wanted), covered }
  return { lines: recovered.slice(-wanted), covered }
}

/** Split a window into the lines it holds whole. */
function splitComplete(text: string, drop: { dropFirst: boolean; dropLast: boolean }): string[] {
  const lines = text.split('\n')
  if (drop.dropLast) lines.pop()
  if (drop.dropFirst) lines.shift()
  return lines.filter(line => line.trim() !== '')
}

/**
 * Read one window of turns from a transcript.
 *
 * Takes one of two branches. Under `maxScanBytes` it streams the whole file
 * once, so `startIndex` and `totalTurns` are exact. Over it — the 192 MB
 * rollout — it walks backwards from the end far enough to fill the window,
 * which is honest but cannot see the beginning: `totalTurns` is then undefined
 * and the caller must report the snapshot as partial.
 * @param path - absolute path to the transcript.
 * @param size - its size in bytes, from a prior stat.
 * @param adapter - the format's adapter.
 * @param options - projection settings.
 * @param request - which turns to return.
 * @param limits - how much of the file this read may touch.
 * @param signal - cancellation from the caller.
 * @returns the turns and their position in the transcript.
 */
export async function readTurns(
  path: string,
  size: number,
  adapter: TranscriptAdapter,
  options: ConvertOptions,
  request: TurnRequest,
  limits: ReadLimits,
  signal?: AbortSignal,
): Promise<TurnPage> {
  // A document adapter folds nothing per line and emits everything from
  // `flush()`, so the tail-anchored path is not available to it: a region of a
  // document is not a smaller document — half a JSON object parses as nothing,
  // and half a branch tree has no leaf to walk back from. It would fold to zero
  // turns and read as "this session was empty" rather than as "this file is too
  // large to read". Refusing says which. The byte cursor is likewise moot here,
  // since only `readFromTail` ever mints one.
  if (adapter.document === true) {
    if (size > limits.maxScanBytes) {
      throw new ReferenceAnythingError(
        `this transcript is ${size} bytes and its format has to be read whole; raise maxScanBytes past that to read it`,
        'REFERENCE_TRANSCRIPT_TOO_LARGE',
      )
    }
    return await readWholeFile(path, adapter, options, request, limits, signal)
  }
  if (size <= limits.maxScanBytes && request.beforeOffset === undefined) {
    return await readWholeFile(path, adapter, options, request, limits, signal)
  }
  return await readFromTail(path, size, adapter, options, request, limits, signal)
}

/** One sequential pass: exact indices, memory bounded by the window size. */
async function readWholeFile(
  path: string,
  adapter: TranscriptAdapter,
  options: ConvertOptions,
  request: TurnRequest,
  limits: ReadLimits,
  signal?: AbortSignal,
): Promise<TurnPage> {
  const state = adapter.createState()
  const window = new TurnRing(request.limit)
  let total = 0

  const collect = (turns: readonly ParsedTurn[]): void => {
    for (const turn of turns) {
      if (request.before === undefined || total < request.before) window.push(turn, total)
      total += 1
    }
  }
  for await (const line of iterateLines(path, limits.maxLineBytes, signal)) {
    collect(adapter.step(line, state, options))
  }
  collect(adapter.flush(state, options))

  const items = window.drain()
  const startIndex = window.firstIndex ?? Math.min(request.before ?? total, total)
  return {
    items,
    startIndex,
    totalTurns: total,
    hasOlder: startIndex > 0,
    compacted: state.compacted,
    anchored: false,
  }
}

/**
 * Walk backwards from the end until the window is full.
 *
 * Each chunk's leading partial line is discarded — except at offset 0, where
 * the line genuinely starts — and the recovered region is then parsed forward,
 * because an adapter folds records in order and cannot run in reverse.
 */
async function readFromTail(
  path: string,
  size: number,
  adapter: TranscriptAdapter,
  options: ConvertOptions,
  request: TurnRequest,
  limits: ReadLimits,
  signal?: AbortSignal,
): Promise<TurnPage> {
  const end = Math.min(request.beforeOffset ?? size, size)
  const handle = await open(path, 'r')
  try {
    let regionStart = end
    let attempt: { turns: ParsedTurn[]; offsets: number[]; compacted: boolean } = {
      turns: [], offsets: [], compacted: false,
    }
    while (regionStart > 0 && attempt.turns.length < request.limit && end - regionStart < limits.maxScanBytes) {
      signal?.throwIfAborted()
      regionStart = Math.max(0, regionStart - TAIL_CHUNK_BYTES)
      const span = end - regionStart
      const buffer = Buffer.alloc(span)
      const { bytesRead } = await handle.read(buffer, 0, span, regionStart)
      attempt = foldRegion(
        buffer.subarray(0, bytesRead),
        regionStart,
        regionStart > 0,
        adapter,
        options,
        limits.maxLineBytes,
      )
    }

    const kept = attempt.turns.slice(-request.limit)
    const keptOffsets = attempt.offsets.slice(-request.limit)
    const startOffset = keptOffsets[0] ?? regionStart
    // Reaching offset 0 with everything folded means this really is the whole
    // transcript, so the exact answers are available after all.
    const sawStart = regionStart === 0 && attempt.turns.length <= request.limit
    return {
      items: kept,
      startIndex: 0,
      ...sawStart ? { totalTurns: attempt.turns.length } : {},
      hasOlder: !sawStart,
      compacted: attempt.compacted,
      anchored: !sawStart,
      ...sawStart ? {} : { startOffset },
    }
  } finally {
    await handle.close()
  }
}

/**
 * Fold one recovered byte region forward, remembering where each turn began.
 *
 * "Began" is the load-bearing word. An assistant run is emitted only when the
 * *next* user record closes it, so attributing it to the line that flushed it
 * would place it after records it actually precedes — and the next page back,
 * reading everything below that offset, would emit it a second time. Each turn
 * is therefore stamped with the offset of the first line that contributed to
 * it, which makes the pages abut exactly.
 */
function foldRegion(
  region: Buffer,
  regionStart: number,
  dropFirstLine: boolean,
  adapter: TranscriptAdapter,
  options: ConvertOptions,
  maxLineBytes: number,
): { turns: ParsedTurn[]; offsets: number[]; compacted: boolean } {
  const state = adapter.createState()
  const turns: ParsedTurn[] = []
  const offsets: number[] = []
  let runStart: number | undefined
  let cursor = 0
  let first = true
  while (cursor < region.length) {
    const start = cursor
    const breakAt = region.indexOf(0x0a, start)
    const stop = breakAt === -1 ? region.length : breakAt
    const offset = regionStart + start
    const skip = (first && dropFirstLine) || stop - start > maxLineBytes
    first = false
    cursor = stop + 1
    if (skip || stop === start) continue
    for (const turn of adapter.step(region.subarray(start, stop).toString('utf8'), state, options)) {
      turns.push(turn)
      if (turn.role === 'assistant') {
        offsets.push(runStart ?? offset)
        runStart = undefined
      } else {
        offsets.push(offset)
      }
    }
    if (state.pending.length === 0) runStart = undefined
    else runStart ??= offset
  }
  for (const turn of adapter.flush(state, options)) {
    turns.push(turn)
    offsets.push(runStart ?? regionStart + region.length)
  }
  return { turns, offsets, compacted: state.compacted }
}

/**
 * Yield a file's lines without ever holding more than one in memory.
 *
 * Splits on `\n` over raw bytes, so a multi-byte character straddling a chunk
 * boundary cannot be corrupted: `0x0a` never appears inside a UTF-8 sequence.
 * A line longer than `maxLineBytes` is dropped rather than materialized —
 * the corpus contains 4 MB records, and the memory bound is the point.
 */
async function* iterateLines(
  path: string,
  maxLineBytes: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const stream = createReadStream(path)
  let held: Buffer[] = []
  let heldBytes = 0
  let skipping = false
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      signal?.throwIfAborted()
      let cursor = 0
      while (cursor < chunk.length) {
        const breakAt = chunk.indexOf(0x0a, cursor)
        if (breakAt === -1) {
          const rest = chunk.subarray(cursor)
          if (!skipping) {
            held.push(rest)
            heldBytes += rest.length
            if (heldBytes > maxLineBytes) {
              skipping = true
              held = []
              heldBytes = 0
            }
          }
          break
        }
        if (!skipping) {
          held.push(chunk.subarray(cursor, breakAt))
          heldBytes += breakAt - cursor
          if (heldBytes <= maxLineBytes) {
            const line = Buffer.concat(held).toString('utf8')
            if (line.trim() !== '') yield line
          }
        }
        held = []
        heldBytes = 0
        skipping = false
        cursor = breakAt + 1
      }
    }
    if (!skipping && heldBytes > 0 && heldBytes <= maxLineBytes) {
      const line = Buffer.concat(held).toString('utf8')
      if (line.trim() !== '') yield line
    }
  } finally {
    stream.destroy()
  }
}

/**
 * The newest `capacity` turns seen so far, and where the oldest of them sits.
 *
 * A transcript can hold thousands of turns and a window asks for tens, so the
 * pass keeps only what it will return.
 */
class TurnRing {
  private readonly slots: ParsedTurn[]
  private readonly indices: number[]
  private filled = 0
  private next = 0

  constructor(private readonly capacity: number) {
    this.slots = new Array<ParsedTurn>(Math.max(capacity, 0))
    this.indices = new Array<number>(Math.max(capacity, 0))
  }

  push(turn: ParsedTurn, index: number): void {
    if (this.capacity <= 0) return
    this.slots[this.next] = turn
    this.indices[this.next] = index
    this.next = (this.next + 1) % this.capacity
    if (this.filled < this.capacity) this.filled += 1
  }

  /** Index of the oldest retained turn, or undefined when none was kept. */
  get firstIndex(): number | undefined {
    if (this.filled === 0) return undefined
    return this.indices[(this.next - this.filled + this.capacity) % this.capacity]
  }

  /** The retained turns in chronological order. */
  drain(): ParsedTurn[] {
    const out: ParsedTurn[] = []
    for (let step = 0; step < this.filled; step += 1) {
      const slot = (this.next - this.filled + step + this.capacity) % this.capacity
      const turn = this.slots[slot]
      if (turn !== undefined) out.push(turn)
    }
    return out
  }
}
