/**
 * Reference source over files kept in a personal cloud drive.
 *
 * Bringing a 网盘 file into a session used to mean downloading it into the
 * workspace first. This registers the drive itself as a referenceable source:
 * the `@` menu lists what is there, and the bytes are fetched only when the
 * model asks for one by reference.
 *
 * Two properties shape everything below. The first is that these are the
 * user's own remote files, so reading one needs a per-task grant and no
 * credential or signed URL may appear in anything a summary, a log, or an
 * error carries. The second is that a drive holds binaries, so the source is
 * text-only on purpose and says so rather than emitting mojibake.
 *
 * @module dsh-reference-anything/cloud-drive
 */

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
import { sliceTurns } from '../../window.ts'
import { DriveCache } from './cache.ts'
import { DRIVE_KINDS, decodeDriveId, encodeDriveId, providerFor } from './registry.ts'
import type { DriveEntry, DriveKind, DriveProvider } from './types.ts'
import type {} from '../../index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'reference-cloud-drive'

/** The services this source is built on. */
export const inject = ['references']

/** Registry id, and the `source` half of every reference this source owns. */
export const CLOUD_DRIVE_SOURCE_ID = 'cloud-drive'

/**
 * Extensions this source will decode.
 *
 * An allowlist rather than a denylist: a drive is mostly photos and archives,
 * and the failure mode of guessing wrong is a screenful of replacement
 * characters presented to the model as if it were the document.
 */
const TEXT_EXTENSIONS: readonly string[] = [
  '.txt', '.md', '.markdown', '.rst', '.org', '.tex',
  '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.csv', '.tsv', '.log', '.diff', '.patch',
  '.xml', '.html', '.htm', '.svg', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.vue', '.svelte',
  '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.m', '.mm',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
  '.sql', '.graphql', '.proto', '.lua', '.r', '.jl', '.dart', '.pl',
  '.srt', '.vtt', '.ass',
]

/**
 * Bytes sniffed for a NUL before the decode is trusted.
 *
 * A NUL inside the first few kilobytes of a UTF-8 text file is not something
 * that happens; in a binary it almost always is.
 */
const SNIFF_BYTES = 4096

/** What a recalled passage is prefixed with, so it is never read as the file. */
const RECALL_NOTICE
  = 'The file itself could not be downloaded. What follows is a passage the drive\'s '
  + 'search index recalled for this file — an extract chosen by the provider, not the document.'

/** Deployment settings for the cloud drive source. */
export interface Config {
  /**
   * Drives to search.
   *
   * Both ship enabled because enabling one costs nothing until it is logged
   * into: a drive with no credential on disk is skipped, so it is absent from
   * the menu rather than an empty group or a recurring warning.
   */
  drives?: DriveKind[]
  /**
   * Where listing starts, for every drive that has no entry in {@link Config.roots}.
   *
   * Means different things per drive — a path under `/apps/bdpan/` for 百度网盘,
   * a folder id or absolute path for 阿里云盘 — so it is only safe to share when
   * it is empty, which is why the default is `''` and {@link Config.roots}
   * exists.
   */
  root?: string
  /**
   * Per-drive override of {@link Config.root}, keyed by drive name.
   *
   * Needed as soon as two drives are enabled at once: the two products address
   * a folder differently, so one string cannot name a real folder in both.
   */
  roots?: Record<string, string>
  /** How long one listing is reused across a typing burst. */
  listTtlMs?: number
  /** Bytes one read may transfer, however large the file is. */
  maxReadBytes?: number
  /** Blocks one read may return, however many the caller asks for. */
  maxReadTurns?: number
  /** Characters of the document projected into one block. */
  blockChars?: number
  /** Filename extensions this source will decode as text. */
  extensions?: string[]
}

/**
 * Runtime schema for {@link Config}.
 *
 * The three read defaults are chosen together rather than independently:
 * 64 KiB at 4000 characters a block is at most seventeen blocks, which fits
 * inside `maxReadTurns`. That is what makes the default read of an ordinary
 * text file return the whole of it, beginning at its beginning — raising
 * `maxReadBytes` past that point buys reach at the cost of a first page that
 * lands at the end of the file and pages backwards, which is the right shape
 * for a conversation and an awkward one for a document.
 */
export const Config: z<Config> = z.object({
  drives: z.array(z.union(DRIVE_KINDS)).default(['baidu', 'pds']),
  root: z.string().default(''),
  roots: z.dict(z.string()).default({}),
  listTtlMs: z.natural().default(30_000),
  maxReadBytes: z.natural().default(64 * 1024),
  maxReadTurns: z.natural().default(20),
  blockChars: z.natural().default(4000),
  extensions: z.array(z.string()).default([...TEXT_EXTENSIONS]),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    referenceCloudDrive: CloudDriveService
  }
}

/** Lists and reads text files held in the user's cloud drives. */
export class CloudDriveService extends Service implements ReferenceSource {
  static inject = inject
  static Config = Config
  readonly id = CLOUD_DRIVE_SOURCE_ID
  /**
   * Gated: these are the user's own remote files. The model may read one only
   * after its user named it.
   */
  readonly requiresGrant = true

  private readonly settings: Required<Config>
  private readonly providers: ReadonlyMap<DriveKind, DriveProvider>
  private readonly cache: DriveCache
  private readonly extensions: ReadonlySet<string>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'referenceCloudDrive')
    this.settings = { ...defaults(), ...definedOnly(config) }
    const built = new Map<DriveKind, DriveProvider>()
    for (const kind of this.settings.drives) {
      const root = this.settings.roots[kind] ?? this.settings.root
      const provider = providerFor(kind, root === '' ? {} : { root })
      if (provider === undefined) {
        throw new ReferenceAnythingError(
          `reference-cloud-drive: "${kind}" has no transport in this build; remove it from "drives"`,
          'REFERENCE_INVALID_CONFIG',
        )
      }
      built.set(kind, provider)
    }
    this.providers = built
    this.cache = new DriveCache(this.settings.listTtlMs)
    this.extensions = new Set(this.settings.extensions.map(value => value.toLocaleLowerCase()))
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => this.ctx.references.registerSource(this), 'reference-cloud-drive.registerSource()')
  }

  /**
   * @returns whether any configured drive holds a usable credential.
   */
  async available(): Promise<boolean> {
    const checks = await Promise.all([...this.providers.values()].map(async (provider) => {
      try {
        return await provider.credentialed()
      } catch {
        // A drive that cannot answer locally is not configured, which is
        // ordinary rather than an error worth propagating to discovery.
        return false
      }
    }))
    return checks.includes(true)
  }

  /**
   * Enumerate drive files matching a query.
   *
   * Fans out across every configured drive at once and merges the results, so
   * one slow or unreachable drive costs latency rather than emptying the menu
   * of the others. Directories and files this source could not decode are
   * dropped by the same rule: neither has text to read, so offering one would
   * produce a reference that can only fail.
   *
   * @param query - free text; empty means the default directory listing.
   * @param limit - hard cap on returned items.
   * @param signal - cancellation from the caller.
   */
  async list(query: string, limit: number, signal?: AbortSignal): Promise<ReferenceSummary[]> {
    const bounded = Math.max(0, Math.trunc(limit))
    if (bounded === 0) return []
    const trimmed = query.trim()

    const collected: DriveEntry[] = []
    await Promise.all([...this.providers.values()].map(async (provider) => {
      const key = `${provider.kind}\0${trimmed}`
      const cached = this.cache.listing(key)
      if (cached !== undefined) {
        collected.push(...cached)
        return
      }
      try {
        // A drive that has never been logged into is absent rather than
        // broken. Worth a branch of its own now that two drives ship enabled:
        // `available()` speaks for the source as a whole, so one credentialed
        // drive keeps the group alive and the other would otherwise warn on
        // every keystroke. Local by contract, and behind the cache, so it
        // costs a stat only when a listing is actually about to happen.
        if (!await provider.credentialed()) return
        const entries = await provider.list(trimmed, bounded, signal)
        const files = entries.filter(entry => !entry.isDirectory && this.readable(entry))
        this.cache.remember(key, files)
        collected.push(...files)
      } catch (cause) {
        if (cause instanceof ReferenceAnythingError && cause.code === 'REFERENCE_CANCELLED') return
        // Only the drive and the error class are reported. The message may
        // quote a request URL, and a request URL carries the credential.
        const code = cause instanceof ReferenceAnythingError ? cause.code : 'REFERENCE_READ_FAILED'
        this.ctx.logger.warn(`reference cloud-drive: listing ${provider.kind} failed (${code})`)
      }
    }))

    return rank(collected, trimmed).slice(0, bounded).map(entry => this.summarize(entry))
  }

  /**
   * Read one window of a drive file, as text.
   *
   * @param ref - a reference this source owns.
   * @param window - which blocks to return.
   * @param signal - cancellation from the caller.
   */
  async read(ref: ReferenceRef, window: ReferenceWindow, signal?: AbortSignal): Promise<ReferenceSnapshot> {
    const { kind, fileId } = decodeDriveId(ref.id)
    const provider = this.providers.get(kind)
    if (provider === undefined) {
      throw new ReferenceAnythingError(
        `cloud-drive: "${kind}" is not among the configured drives`,
        'SOURCE_UNAVAILABLE',
      )
    }

    const entry = this.cache.entry(kind, fileId) ?? await provider.describe(fileId, signal)
    if (entry === undefined) {
      throw new ReferenceAnythingError('cloud-drive: no such file', 'REFERENCE_NOT_FOUND')
    }
    if (entry.isDirectory) {
      throw new ReferenceAnythingError(
        `cloud-drive: ${JSON.stringify(entry.name)} is a folder, which has no text to read`,
        'REFERENCE_READ_FAILED',
      )
    }
    this.assertTextual(entry)

    const loaded = await this.load(provider, entry, signal)
    const blocks = splitBlocks(loaded.text, this.settings.blockChars)
    const items: ConversationItem[] = blocks.map(text => ({ role: 'document', text }))
    if (loaded.recalled) items.unshift({ role: 'document', text: RECALL_NOTICE })
    if (items.length === 0) {
      // An empty success is indistinguishable from a broken reader, so say
      // which of the two this is.
      throw new ReferenceAnythingError(
        `cloud-drive: ${JSON.stringify(entry.name)} decoded to no text at all`,
        'REFERENCE_READ_FAILED',
      )
    }

    const body = sliceTurns(items, {
      ...window,
      limit: Math.min(Math.max(0, Math.trunc(window.limit)), this.settings.maxReadTurns),
    })
    return {
      ...this.summarize(entry),
      body,
      partial: loaded.partial,
      capturedAt: Date.now(),
      provider: provider.displayName,
    }
  }

  /**
   * Project one entry for discovery.
   *
   * Deliberately carries no excerpt and no URL: `origin` is the drive's own
   * display path, which is user-facing only, and everything else a drive
   * knows about a file either identifies it or is a secret.
   */
  private summarize(entry: DriveEntry): ReferenceSummary {
    const provider = this.providers.get(entry.kind)
    return {
      ref: { source: this.id, id: encodeDriveId(entry.kind, entry.id) },
      label: entry.name,
      ...(entry.path === '' ? {} : { origin: entry.path }),
      ...(entry.modifiedAt === undefined ? {} : { updatedAt: entry.modifiedAt }),
      ...(provider === undefined ? {} : { provider: provider.displayName }),
    }
  }

  /**
   * Fetch the file's text, best tier first.
   *
   * Downloading comes first and the drive's own recalled passage second,
   * rather than the other way around: the passage is an extract a search index
   * chose, so answering "read this file" with it would be answering a
   * different question. It earns its place as the fallback — for an image with
   * OCR text, or a file too large or too binary to decode, it is the only text
   * that exists.
   */
  private async load(
    provider: DriveProvider,
    entry: DriveEntry,
    signal?: AbortSignal,
  ): Promise<{ text: string, partial: boolean, recalled: boolean }> {
    const cap = this.settings.maxReadBytes
    const wanted = entry.size > 0 ? Math.min(entry.size, cap) : cap
    try {
      if (wanted === 0) throw new ReferenceAnythingError('cloud-drive: the file is empty', 'REFERENCE_READ_FAILED')
      const result = await provider.read(entry.id, 0, wanted, signal)
      if (looksBinary(result.bytes)) {
        throw new ReferenceAnythingError(
          `cloud-drive: ${JSON.stringify(entry.name)} is not text`,
          'REFERENCE_READ_FAILED',
        )
      }
      const total = result.totalSize ?? entry.size
      return {
        text: decodeText(result.bytes),
        partial: total > result.bytes.byteLength,
        recalled: false,
      }
    } catch (cause) {
      if (cause instanceof ReferenceAnythingError && cause.code === 'REFERENCE_CANCELLED') throw cause
      const recalled = await provider.extractedText(entry.id, signal).catch(() => undefined)
      if (recalled === undefined || recalled.trim() === '') throw cause
      return { text: recalled, partial: true, recalled: true }
    }
  }

  /** Whether the allowlist admits this file's extension. */
  private readable(entry: DriveEntry): boolean {
    return this.extensions.has(extensionOf(entry.name))
  }

  /**
   * Reject a file whose extension is not on the allowlist, naming what happened.
   *
   * `list` applies the same rule, so reaching this is either a reference kept
   * from before the allowlist changed or one the model composed itself — both
   * worth an explicit error rather than a download.
   */
  private assertTextual(entry: DriveEntry): void {
    if (this.readable(entry)) return
    const extension = extensionOf(entry.name)
    throw new ReferenceAnythingError(
      `cloud-drive: ${JSON.stringify(entry.name)} is not a text file this source can read`
      + `${extension === '' ? ' (it has no extension)' : ` (${extension})`}`,
      'REFERENCE_READ_FAILED',
    )
  }
}

/** A filename's lowercased extension, including the dot; empty when it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLocaleLowerCase()
}

/**
 * Register the cloud drive reference source.
 * @param ctx - the mounting context.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const drives = config.drives ?? defaults().drives
  if (drives.length === 0) {
    throw new ReferenceAnythingError(
      'reference-cloud-drive needs at least one entry in "drives"; mounting it with none can never resolve a reference',
      'REFERENCE_INVALID_CONFIG',
    )
  }
  // Checked here as well as in the constructor, because only here does it reach
  // the person who wrote the config: `ctx.plugin` starts a fiber of its own, and
  // a constructor that throws inside it fails that fiber quietly rather than
  // this one. `DRIVE_KINDS` is the durable reference vocabulary and stays wider
  // than the set of transports, so a drive this build cannot reach should stop
  // startup rather than become an empty menu group.
  for (const kind of drives) {
    if (providerFor(kind) === undefined) {
      throw new ReferenceAnythingError(
        `reference-cloud-drive: "${kind}" has no transport in this build; remove it from "drives"`,
        'REFERENCE_INVALID_CONFIG',
      )
    }
  }
  ctx.plugin(CloudDriveService, config)
}

/**
 * Order entries for the menu.
 *
 * Matching is against the filename only. The body is never ranked over —
 * a drive file's contents are untrusted material that belongs inside
 * `reference_read`'s envelope, and scoring against it would leak what a file
 * says into a surface that is supposed to say only that it exists.
 */
function rank(entries: readonly DriveEntry[], query: string): DriveEntry[] {
  if (query === '') {
    return [...entries].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
  }
  const scored: { entry: DriveEntry, match: TitleMatch }[] = []
  // A semantic search returns hits whose relevance the filename cannot show,
  // so an unmatched name is kept rather than dropped — just placed after the
  // ones where the user can see why they matched.
  const unmatched: DriveEntry[] = []
  for (const entry of entries) {
    const match = scoreTitle(entry.name, query)
    if (match === undefined) unmatched.push(entry)
    else scored.push({ entry, match })
  }
  scored.sort((a, b) => compareMatches(a.match, b.match))
  return [...scored.map(hit => hit.entry), ...unmatched]
}

/**
 * Split decoded text into blocks at line boundaries.
 *
 * Line-aligned because a block is what the model sees as one unit, and cutting
 * mid-line puts half a statement at the end of one and half at the start of
 * the next. A single line longer than the budget is hard-split rather than
 * allowed to blow it.
 */
export function splitBlocks(text: string, blockChars: number): string[] {
  const budget = Math.max(1, Math.trunc(blockChars))
  const blocks: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    for (const piece of hardSplit(line, budget)) {
      if (current !== '' && current.length + piece.length + 1 > budget) {
        blocks.push(current)
        current = ''
      }
      current = current === '' ? piece : `${current}\n${piece}`
    }
  }
  if (current.trim() !== '') blocks.push(current)
  else if (current !== '' && blocks.length === 0) blocks.push(current)
  return blocks.filter(block => block.trim() !== '')
}

/** Cut one over-long line into budget-sized pieces. */
function hardSplit(line: string, budget: number): string[] {
  if (line.length <= budget) return [line]
  const pieces: string[] = []
  for (let at = 0; at < line.length; at += budget) pieces.push(line.slice(at, at + budget))
  return pieces
}

/**
 * Whether these bytes are binary.
 *
 * A NUL in the first few kilobytes is the test, because it is the one byte
 * valid UTF-8 text effectively never contains and the one nearly every binary
 * format does.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, SNIFF_BYTES)
  for (let at = 0; at < end; at += 1) {
    if (bytes[at] === 0) return true
  }
  return false
}

/**
 * Decode bytes as UTF-8, dropping a trailing partial character.
 *
 * A capped read almost always lands mid-sequence, and letting the decoder turn
 * that tail into a replacement character would put a visible corruption at the
 * end of every truncated document.
 */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(trimPartialUtf8(bytes))
}

/** Drop up to three trailing bytes that begin a character the read cut short. */
function trimPartialUtf8(bytes: Uint8Array): Uint8Array {
  for (let back = 1; back <= 3 && back <= bytes.byteLength; back += 1) {
    const byte = bytes[bytes.byteLength - back]
    if (byte === undefined || byte < 0x80) return bytes
    // A lead byte this close to the end starts a character whose continuation
    // bytes were never read; anything shorter than its declared width is cut.
    if (byte >= 0xc0) {
      const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
      return width > back ? bytes.subarray(0, bytes.byteLength - back) : bytes
    }
  }
  return bytes
}

/** Every default, as one object. */
function defaults(): Required<Config> {
  return Config({}) as Required<Config>
}

/** Drop keys explicitly set to undefined so they do not shadow a default. */
function definedOnly(config: Config): Config {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as Config
}
