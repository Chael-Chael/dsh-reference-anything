import { sourceOf, defaultRoots, FORMATS } from 'chat-import-source/lib/discovery/registry.mjs'
import { scanFormat } from 'chat-import-source/lib/discovery/discover.mjs'
import { createRunHost } from 'chat-import-source/lib/discovery/run-host.mjs'
import { DB_SUMMARY_READERS } from 'chat-import-source/lib/discovery-host.mjs'
import { knownWorkspacePaths, resolveCursorSlugPath } from 'chat-import-source/lib/cwd-map.mjs'
import { stat, readdir, readFile, open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export { FORMATS }
const expand = path => resolve(path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path)
async function missingAsNull(read) {
  try { return await read() } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}
async function windowBytes(path, cap, tail = false) {
  return missingAsNull(async () => {
    const file = await open(expand(path), 'r')
    try {
      const size = (await file.stat()).size
      const offset = tail ? Math.max(0, size - cap) : 0
      const buffer = Buffer.alloc(Math.min(size, cap))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      return buffer.subarray(0, bytesRead)
    } finally { await file.close() }
  })
}
const host = {
  stat: path => missingAsNull(async () => {
    const s = await stat(expand(path))
    return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs }
  }),
  readDir: path => missingAsNull(async () => (await readdir(expand(path), { withFileTypes: true })).map(e => ({
    name: e.name, type: e.isDirectory() ? 'directory' : 'file', path: join(expand(path), e.name),
  }))),
  readText: path => missingAsNull(() => readFile(expand(path), 'utf8')),
  readHead: async (path, cap = 256 * 1024) => (await windowBytes(path, cap))?.toString('utf8') ?? null,
  readTail: async (path, cap = 64 * 1024) => (await windowBytes(path, cap, true))?.toString('utf8') ?? null,
  async readBytes(path, cap = 256 * 1024) {
    const s = await host.stat(path)
    return s?.type === 'file' && s.size <= cap ? windowBytes(path, cap) : null
  },
  async *readLines(path) {
    const input = createReadStream(expand(path), { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try { yield* lines } finally { lines.close(); input.destroy() }
  },
  readSessions: (format, path) => DB_SUMMARY_READERS[format]?.(expand(path)) ?? null,
  resolveCursorSlug: slug => resolveCursorSlugPath(context, slug),
  listWorkspaces: async () => [...await knownWorkspacePaths(context)],
}
const context = { fs: { resolve: async path => expand(path), stat: host.stat } }

export async function scanConversations(input) {
  if (!sourceOf(input.format)) throw new Error('Unsupported conversation format: ' + input.format)
  const root = input.path || defaultRoots()[input.format]
  const targets = Array.isArray(root) ? root : root ? [root] : []
  const sessions = [], warnings = []
  const run = createRunHost(host)
  for (const target of targets) sessions.push(...await scanFormat(run, input.format, expand(target), null, null, warnings))
  return { sessions: sessions.map(({ importStatus, ...entry }) => entry), warnings }
}
