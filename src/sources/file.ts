/**
 * Reference source over exported conversations stored on disk.
 *
 * Every chat product can export a conversation, and an exported file is the
 * one form of outside material that needs no browser, no credentials, and no
 * network — which also makes it the source that end-to-end tests can drive.
 *
 * @module dsh-reference-anything/file
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReferenceAnythingError } from '../errors.ts'
import type {
  ConversationItem,
  ReferenceRef,
  ReferenceSnapshot,
  ReferenceSource,
  ReferenceSummary,
  ReferenceWindow,
} from '../types.ts'
import { sliceTurns } from '../window.ts'
import type {} from '../index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'reference-file'

/** The registry this source registers into. */
export const inject = ['references']

/** Registry id, and the `source` half of every reference this source owns. */
export const FILE_SOURCE_ID = 'file'

/** Directory depth walked below each root. */
const MAX_DEPTH = 4

/** Deployment settings for the file source. */
export interface Config {
  /**
   * Directories holding exported conversations. Required and never defaulted:
   * a reference source that reads an unbounded part of the filesystem by
   * default is not a safe thing to mount.
   */
  roots?: string[]
  /** File extensions treated as exports. */
  extensions?: string[]
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  roots: z.array(z.string()).default([]),
  extensions: z.array(z.string()).default(['.json']),
})

/**
 * On-disk export document.
 *
 * Deliberately smaller than {@link ReferenceSnapshot}: this is a format people
 * and export scripts write by hand, so it carries only what cannot be derived.
 */
interface ExportDocument {
  readonly label?: string
  readonly origin?: string
  readonly updatedAt?: number
  readonly messages: readonly ConversationItem[]
}

/** Reads exported conversations out of a fixed set of directories. */
export class FileReferenceSource implements ReferenceSource {
  readonly id = FILE_SOURCE_ID
  /** Ungated on purpose: the configured roots are already inside the task's scope. */
  readonly requiresGrant = false

  /**
   * @param roots - absolute or process-relative directories to search.
   * @param extensions - file extensions treated as exports.
   */
  constructor(
    private readonly roots: readonly string[],
    private readonly extensions: readonly string[],
  ) {}

  /** @returns whether at least one configured root is a readable directory. */
  async available(): Promise<boolean> {
    const checks = await Promise.all(this.roots.map(async (root) => {
      try {
        return (await stat(root)).isDirectory()
      } catch {
        // A root that does not exist yet is an ordinary state (the user has
        // not exported anything), not a misconfiguration to fail on.
        return false
      }
    }))
    return checks.includes(true)
  }

  /**
   * List exports whose label, id, or filename contains `query`.
   * @param query - case-insensitive substring; empty matches everything.
   * @param limit - maximum items to return.
   * @param signal - cancellation from the caller.
   * @returns matching exports, at most `limit`.
   */
  async list(query: string, limit: number, signal?: AbortSignal): Promise<ReferenceSummary[]> {
    const needle = query.toLocaleLowerCase()
    const found: ReferenceSummary[] = []
    for (const root of this.roots) {
      for (const path of await this.walk(root, root, 0, signal)) {
        if (found.length >= limit) return found
        const summary = await this.summarize(root, path)
        if (summary === undefined) continue
        const haystack = `${summary.label} ${summary.ref.id}`.toLocaleLowerCase()
        if (needle !== '' && !haystack.includes(needle)) continue
        found.push(summary)
      }
    }
    return found.slice(0, limit)
  }

  /**
   * Read one window of turns from an export.
   * @param ref - a reference this source owns; `ref.id` is a root-relative path.
   * @param window - which turns to return.
   * @param signal - cancellation from the caller.
   * @returns the requested turns and their position in the conversation.
   */
  async read(ref: ReferenceRef, window: ReferenceWindow, signal?: AbortSignal): Promise<ReferenceSnapshot> {
    signal?.throwIfAborted()
    const path = await this.locate(ref.id)
    const document = parseExport(await readFile(path, 'utf8'), path)
    const slice = sliceTurns(document.messages, window)
    return {
      ref,
      label: labelOf(document, ref.id),
      ...document.origin === undefined ? {} : { origin: document.origin },
      ...document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt },
      body: slice,
      // The whole file is read every time, so nothing is beyond this source's reach.
      partial: false,
      capturedAt: Date.now(),
    }
  }

  /**
   * Resolve a root-relative id to a real path inside a configured root.
   *
   * The check runs against the resolved real path, so neither `..` segments
   * nor a symlink pointing outside a root can reach a file the deployment did
   * not offer.
   */
  private async locate(id: string): Promise<string> {
    for (const root of this.roots) {
      const candidate = resolve(root, id)
      let real: string
      let realRoot: string
      try {
        real = await realpath(candidate)
        realRoot = await realpath(root)
      } catch {
        continue
      }
      if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
        throw new ReferenceAnythingError(
          `exported conversation ${JSON.stringify(id)} resolves outside its configured root`,
          'REFERENCE_NOT_FOUND',
        )
      }
      return real
    }
    throw new ReferenceAnythingError(
      `no exported conversation named ${JSON.stringify(id)} exists under the configured roots`,
      'REFERENCE_NOT_FOUND',
    )
  }

  private async walk(root: string, dir: string, depth: number, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    if (depth > MAX_DEPTH) return []
    // An unreadable directory is one the user cannot reference from anyway;
    // the other roots still list.
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const paths: string[] = []
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        paths.push(...await this.walk(root, path, depth + 1, signal))
      } else if (this.extensions.includes(extname(entry.name))) {
        paths.push(path)
      }
    }
    return paths
  }

  private async summarize(root: string, path: string): Promise<ReferenceSummary | undefined> {
    const id = relative(root, path)
    let document: ExportDocument
    try {
      document = parseExport(await readFile(path, 'utf8'), path)
    } catch {
      // Discovery skips a malformed file so one bad export does not hide the
      // rest; naming it by reference still fails loudly through read().
      return undefined
    }
    return {
      ref: { source: FILE_SOURCE_ID, id },
      label: labelOf(document, id),
      origin: path,
      ...document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt },
    }
  }
}

/**
 * Register the file reference source.
 * @param ctx - the mounting context.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const roots = config.roots ?? []
  const extensions = config.extensions ?? ['.json']
  if (roots.length === 0) {
    throw new ReferenceAnythingError(
      'reference-file needs at least one directory in "roots"; mounting it with none can never resolve a reference',
      'REFERENCE_INVALID_CONFIG',
    )
  }
  const source = new FileReferenceSource(roots, extensions)
  ctx.effect(() => ctx.references.registerSource(source), 'reference-file.registerSource()')
}

/**
 * Validate one export document.
 *
 * A file is an untrusted durable boundary — hand-written, produced by an
 * exporter this package does not control, possibly written by an older
 * version — so its shape is checked rather than assumed.
 * @param raw - the file's UTF-8 contents.
 * @param path - the path, for the diagnostic.
 * @returns the validated document.
 */
export function parseExport(raw: string, path: string): ExportDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    throw invalid(path, 'is not valid JSON', error)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid(path, 'is not a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const { label, origin, updatedAt, messages } = record
  if (!Array.isArray(messages)) throw invalid(path, 'has no "messages" array')
  const items: ConversationItem[] = messages.map((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null) throw invalid(path, `message ${index} is not an object`)
    const { role, text } = entry as Record<string, unknown>
    if (role !== 'user' && role !== 'assistant') {
      throw invalid(path, `message ${index} has role ${JSON.stringify(role)}, expected "user" or "assistant"`)
    }
    if (typeof text !== 'string') throw invalid(path, `message ${index} has no string "text"`)
    return { role, text }
  })
  if (label !== undefined && typeof label !== 'string') throw invalid(path, 'has a non-string "label"')
  if (origin !== undefined && typeof origin !== 'string') throw invalid(path, 'has a non-string "origin"')
  if (updatedAt !== undefined && typeof updatedAt !== 'number') throw invalid(path, 'has a non-numeric "updatedAt"')
  return {
    ...label === undefined ? {} : { label },
    ...origin === undefined ? {} : { origin },
    ...updatedAt === undefined ? {} : { updatedAt },
    messages: items,
  }
}

function labelOf(document: ExportDocument, id: string): string {
  const label = document.label?.trim() ?? ''
  return label === '' ? id : label
}

function invalid(path: string, detail: string, cause?: unknown): ReferenceAnythingError {
  return new ReferenceAnythingError(
    `exported conversation ${JSON.stringify(path)} ${detail}`,
    'REFERENCE_READ_FAILED',
    cause === undefined ? undefined : { cause },
  )
}
