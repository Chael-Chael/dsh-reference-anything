import { parentPort } from 'node:worker_threads'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readConversation } from './parsers.mjs'
const channel = parentPort || { on: (...args) => process.on(...args), postMessage: value => process.send(value) }
if (!parentPort) process.on('disconnect', () => process.exit(0))

// Parsing stays off the picker thread. Only states and file fingerprints cross back.
channel.on('message', async ({ id, target }) => {
  const dependencies = new Map()
  const inspect = async path => {
    try {
      const s = await stat(path)
      dependencies.set(path, `${s.size}:${s.mtimeMs}:${s.ctimeMs}`)
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      dependencies.set(path, 'missing')
      return undefined
    }
  }
  const fs = {
    resolve: async path => ({ displayPath: resolve(path) }),
    processPath: value => value.displayPath,
    stat: async value => inspect(value.displayPath),
    readText: async value => {
      const info = await inspect(value.displayPath)
      // shortcut: large sources stay unknown; use streaming probes before raising this background budget.
      if (info?.size > 8 * 1024 * 1024) throw new Error('Background validation budget exceeded')
      const raw = await readFile(value.displayPath, 'utf8')
      // A tolerant converter may skip broken lines; that must never prove emptiness.
      if (/\.jsonl$/i.test(value.displayPath)) for (const line of raw.split(/\r?\n/)) if (line.trim()) JSON.parse(line)
      return raw
    },
    listDir: async value => {
      await inspect(value.displayPath)
      return (await readdir(value.displayPath, { withFileTypes: true })).map(e => ({
        name: e.name, type: e.isDirectory() ? 'directory' : 'file', target: { displayPath: join(value.displayPath, e.name) },
      }))
    },
  }
  let state = 'unknown'
  try {
    const info = await inspect(target.path)
    if (!info || (info.type === 'file' && info.size === 0)) state = 'empty'
    else if (target.format === 'claude' && /\.json$/i.test(target.path)) {
      const meta = JSON.parse(await fs.readText({ displayPath: target.path }))
      if (meta.cliSessionId && !meta.messages) {
        // Match the exact CLI identity; never substitute another chat in the project.
        const root = join(homedir(), '.claude', 'projects')
        let found = false
        const walk = async dir => {
          await inspect(dir)
          for (const e of await readdir(dir, { withFileTypes: true })) {
            if (e.isDirectory()) await walk(join(dir, e.name))
            else if (e.name === `${meta.cliSessionId}.jsonl`) found = true
          }
        }
        if (await inspect(root)) await walk(root)
        state = found ? 'unknown' : 'empty'
      }
    } else {
      if (info.type === 'directory' && ['grokbuild', 'vibe', 'kimi'].includes(target.format)) {
        const names = target.format === 'grokbuild' ? ['chat_history.jsonl']
          : target.format === 'vibe' ? ['messages.jsonl'] : ['wire.jsonl', 'agents/main/wire.jsonl']
        const bodies = await Promise.all(names.map(name => inspect(join(target.path, name))))
        if (bodies.every(body => !body || body.size === 0)) {
          channel.postMessage({ id, state: 'empty', dependencies: [...dependencies] })
          return
        }
      }
      if (/\.(?:db|vscdb)$/i.test(target.path)) {
        await inspect(target.path + '-wal')
        await inspect(target.path + '-shm')
        const schemas = {
          opencode: ['session', 'message'], mimocode: ['session', 'message'], kilocode: ['session', 'message'],
          teleagent: ['session', 'message'], zcode: ['session', 'message'],
          hermes: ['sessions', 'messages'], goose: ['sessions', 'messages'], crush: ['sessions', 'messages'],
        }
        let schema = schemas[target.format]
        if (schema) {
          const { DatabaseSync } = await import('node:sqlite')
          const db = new DatabaseSync(target.path, { readOnly: true })
          try {
            const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name))
            if (schema[0] === 'session' && tables.has('session_v2')) schema = ['session_v2', 'session_message']
            if (tables.has(schema[0]) && tables.has(schema[1])
              && db.prepare(`SELECT 1 FROM ${schema[0]} WHERE id = ? LIMIT 1`).get(target.sessionId)
              && !db.prepare(`SELECT 1 FROM ${schema[1]} WHERE session_id = ? LIMIT 1`).get(target.sessionId)) {
              channel.postMessage({ id, state: 'empty', dependencies: [...dependencies] })
              return
            }
          } finally { db.close() }
        }
      }
      if (target.format === 'chatgpt') {
        const exported = JSON.parse(await fs.readText({ displayPath: target.path }))
        const chat = Array.isArray(exported) ? exported.find(c => c.id === target.sessionId) : null
        if (chat?.mapping && Object.values(chat.mapping).every(node => node && !node.message)) {
          channel.postMessage({ id, state: 'empty', dependencies: [...dependencies] })
          return
        }
      }
      state = await readConversation(fs, { ...target, limit: 1, detail: 'full', probe: true })
      if (state === 'unknown' && ['pi', 'codex', 'openclaw', 'hermes', 'dsh', 'dsh4'].includes(target.format) && info.type === 'file' && !/\.(db|vscdb|zstd)$/i.test(target.path)) {
        const records = (await fs.readText({ displayPath: target.path })).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
        const allowed = target.format === 'codex' ? ['session_meta'] : ['session', 'session_info', 'session/title']
        if (records.length && records.every(r => allowed.includes(r.type))) state = 'empty'
      }
    }
  } catch { state = 'unknown' }
  channel.postMessage({ id, state, dependencies: [...dependencies] })
})
