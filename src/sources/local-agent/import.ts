import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { ReferenceAnythingError } from '../../errors.ts'
import { readSessionTurns } from './scan.ts'
import type { AgentAdapter, ConvertOptions, ParsedTurn } from './types.ts'
import { isQueryAdapter } from './types.ts'

/** Import budgets are independent from the small interactive picker/read windows. */
export const IMPORT_LIMITS = {
  maxFileBytes: 512 * 1024 * 1024,
  maxDocumentBytes: 64 * 1024 * 1024,
  maxLineBytes: 16 * 1024 * 1024,
  maxTextBytes: 32 * 1024 * 1024,
  maxTurns: 100_000,
  maxSessionRecords: 50_000,
} as const
export type ImportLimits = { [K in keyof typeof IMPORT_LIMITS]: number }

export interface ImportedTurns { turns: ParsedTurn[]; summaryTurns: ParsedTurn[]; partial: boolean }

/** Stat both SQLite's main file and WAL; an append into the WAL leaves the main file unchanged. */
export async function sourceVersion(path: string, sqlite: boolean, options: ConvertOptions): Promise<string> {
  const file = await stat(path)
  const wal = sqlite ? await stat(`${path}-wal`).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }) : undefined
  return JSON.stringify({
    path, size: file.size, mtime: file.mtimeMs, ctime: file.ctimeMs, ino: file.ino,
    ...(wal === undefined ? {} : { walSize: wal.size, walMtime: wal.mtimeMs, walCtime: wal.ctimeMs }),
    options,
  })
}

/** One forward stream, preserving fold state across the entire transcript. */
export async function readForImport(
  path: string, size: number, adapter: AgentAdapter, options: ConvertOptions,
  sessionId: string | undefined, signal?: AbortSignal, limits: ImportLimits = IMPORT_LIMITS,
): Promise<ImportedTurns> {
  signal?.throwIfAborted()
  const summaryOptions = { ...options, toolCalls: 'elide' as const, toolResults: 'drop' as const }
  if (isQueryAdapter(adapter)) {
    const full = await readSessionTurns(path, adapter, sessionId ?? '', options, limits.maxSessionRecords, signal)
    const summary = await readSessionTurns(path, adapter, sessionId ?? '', summaryOptions, limits.maxSessionRecords, signal)
    const turns = [...full.items]
    const summaryTurns = [...summary.items]
    assertTextBudget(turns, summaryTurns, limits)
    return { turns, summaryTurns, partial: full.truncated || full.compacted || summary.truncated || summary.compacted }
  }
  const fileBudget = adapter.document ? limits.maxDocumentBytes : limits.maxFileBytes
  if (size > fileBudget) throw tooLarge(`transcript exceeds the ${fileBudget}-byte history import limit`)
  // A whole-document adapter must receive every byte, including an unusually long JSON line.
  const lineBudget = adapter.document ? limits.maxDocumentBytes : limits.maxLineBytes
  const full = adapter.createState()
  const summary = adapter.createState()
  const turns: ParsedTurn[] = []
  const summaryTurns: ParsedTurn[] = []
  let textBytes = 0
  const collect = (target: ParsedTurn[], added: readonly ParsedTurn[]): void => {
    for (const turn of added) {
      textBytes += Buffer.byteLength(turn.text, 'utf8')
      if (textBytes > limits.maxTextBytes || target.length >= limits.maxTurns) throw tooLarge('projected conversation exceeds the history import limit')
      target.push(turn)
    }
  }
  for await (const line of importLines(path, fileBudget, lineBudget, signal)) {
    if (adapter.kind !== 'gemini-cli') {
      try { JSON.parse(line) } catch {
        throw new ReferenceAnythingError('transcript contains an incomplete or malformed JSON record; the previous history was retained', 'REFERENCE_READ_FAILED')
      }
    }
    collect(turns, adapter.step(line, full, options))
    collect(summaryTurns, adapter.step(line, summary, summaryOptions))
  }
  collect(turns, adapter.flush(full, options))
  collect(summaryTurns, adapter.flush(summary, summaryOptions))
  return { turns, summaryTurns, partial: full.compacted || summary.compacted }
}

function assertTextBudget(turns: readonly ParsedTurn[], summary: readonly ParsedTurn[], limits: ImportLimits): void {
  let bytes = 0
  if (turns.length > limits.maxTurns || summary.length > limits.maxTurns) throw tooLarge('conversation exceeds the history import turn limit')
  for (const turn of [...turns, ...summary]) {
    bytes += Buffer.byteLength(turn.text, 'utf8')
    if (bytes > limits.maxTextBytes) throw tooLarge('projected conversation exceeds the history import text limit')
  }
}

async function* importLines(path: string, fileBudget: number, lineBudget: number, signal?: AbortSignal): AsyncGenerator<string> {
  const stream = createReadStream(path)
  let bytes = 0
  let held: Buffer[] = []
  let heldBytes = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      signal?.throwIfAborted()
      bytes += chunk.length
      if (bytes > fileBudget) throw tooLarge('transcript grew beyond the history import byte limit')
      let at = 0
      while (at < chunk.length) {
        const newline = chunk.indexOf(0x0a, at)
        const end = newline < 0 ? chunk.length : newline
        held.push(chunk.subarray(at, end))
        heldBytes += end - at
        if (heldBytes > lineBudget) throw tooLarge('a transcript record exceeds the history import line limit; nothing was replaced')
        if (newline < 0) break
        const line = Buffer.concat(held).toString('utf8')
        if (line.trim() !== '') yield line
        held = []
        heldBytes = 0
        at = end + 1
      }
    }
    if (heldBytes > 0) {
      const line = Buffer.concat(held).toString('utf8')
      if (line.trim() !== '') yield line
    }
  } finally {
    stream.destroy()
  }
}

function tooLarge(message: string): ReferenceAnythingError { return new ReferenceAnythingError(message, 'REFERENCE_TRANSCRIPT_TOO_LARGE') }
