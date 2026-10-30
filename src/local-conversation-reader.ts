import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { defaultRoots, readConversation } from '../vendor/chat-import-reader/parsers.mjs'

export { defaultRoots as localConversationRoots }

type Target = { displayPath: string }

// The parser gets only filesystem reads, never the Cordis host context.
export async function readLocalConversation(input: Parameters<typeof readConversation>[1], signal?: AbortSignal) {
  if (!isAbsolute(input.path) || !input.sessionId) throw new Error('Invalid conversation locator')
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('Invalid conversation page size')
  if (input.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 0)) throw new Error('Invalid conversation page offset')
  if (input.format === 'claude' && /\.json$/i.test(input.path)) {
    const raw = await readFile(input.path, { encoding: 'utf8', signal })
    let metadata: unknown
    try { metadata = JSON.parse(raw) } catch { /* Line-based transcripts are parsed below. */ }
    if (metadata && typeof metadata === 'object' && 'cliSessionId' in metadata && !('messages' in metadata)) {
      throw new Error('Conversation body unavailable: this Claude Desktop file contains metadata only. Open the conversation in Claude Desktop to restore its transcript, then refresh and reselect it. Do not retry or search unrelated files.')
    }
  }
  const fingerprints: string[] = []
  const versions = async () => {
    const paths = input.format === 'doubao'
      ? [input.path, ...(await readdir(input.path)).filter(name => /\.(ldb|log)$/.test(name)).sort().map(name => join(input.path, name))]
      : [input.path, input.path + '-wal']
    return Promise.all(paths.map(async path => {
      try { const info = await stat(path); return `${path}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${path}:missing`; throw error }
    }))
  }
  const initial = input.structured ? await versions() : []
  const target = (path: string): Target => ({ displayPath: resolve(path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path) })
  const fs = {
    streamText: async (value: Target) => createReadStream(value.displayPath, { encoding: 'utf8', signal }),
    resolve: async (path: string) => { signal?.throwIfAborted(); return target(path) },
    processPath: (value: Target) => value.displayPath,
    stat: async (value: Target) => {
      signal?.throwIfAborted()
      try {
        const info = await stat(value.displayPath)
        return { type: info.isDirectory() ? 'directory' : 'file', size: info.size, mtimeMs: info.mtimeMs, version: `${info.mtimeMs}:${info.size}` }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    readText: async (value: Target) => {
      signal?.throwIfAborted()
      const text = await readFile(value.displayPath, { encoding: 'utf8', signal })
      if (input.structured) fingerprints.push(createHash('sha256').update(text).digest('hex'))
      return text
    },
    listDir: async (value: Target) => {
      signal?.throwIfAborted()
      return (await readdir(value.displayPath, { withFileTypes: true })).map(entry => ({
        name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', target: target(join(value.displayPath, entry.name)),
      }))
    },
  }
  const result = await readConversation(fs, input.structured ? { ...input, revision: undefined } : input, signal)
  if (input.structured && result && typeof result === 'object' && 'revision' in result) {
    const final = await versions()
    if (JSON.stringify(initial) !== JSON.stringify(final)) throw new Error('Conversation changed while reading; retry to refresh the preview')
    result.revision = createHash('sha256').update(JSON.stringify([result.revision, fingerprints, final])).digest('hex')
    if (input.revision && input.revision !== result.revision) throw new Error('Conversation changed; read its latest page again')
  }
  return result
}
