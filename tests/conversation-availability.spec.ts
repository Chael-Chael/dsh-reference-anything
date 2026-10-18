import { afterEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationAvailability } from '../src/conversation-availability.ts'
import { DatabaseSync } from 'node:sqlite'

const caches: ConversationAvailability[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const cache of caches.splice(0)) cache.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function setup(format: string, raw: string) {
  const dir = await mkdtemp(join(tmpdir(), 'ref-availability-')); dirs.push(dir)
  const path = join(dir, 'session.json')
  await writeFile(path, raw)
  const cache = new ConversationAvailability(); caches.push(cache)
  return { cache, target: { format, path, sessionId: 'sample' } }
}
it.each([
  ['gemini', { sessionId: 'sample', messages: [] }],
  ['continue', { sessionId: 'sample', history: [] }],
  ['codex', { type: 'session_meta', payload: { id: 'sample' } }],
  ['openclaw', { type: 'session', id: 'sample', version: 3 }],
  ['pi', { type: 'session', id: 'sample', version: 3 }],
  ['chatgpt', [{ id: 'sample', mapping: {} }]],
])('hides confirmed empty %s after background validation', async (format, record) => {
  const { cache, target } = await setup(format, JSON.stringify(record))
  expect(await cache.visible(target)).toBe(true)
  await expect.poll(() => cache.visible(target), { timeout: 5000 }).toBe(false)
})
it('restores visibility when a previously empty source changes', async () => {
  const { cache, target } = await setup('gemini', JSON.stringify({ sessionId: 'sample', messages: [] }))
  await expect.poll(() => cache.visible(target), { timeout: 5000 }).toBe(false)
  await writeFile(target.path, JSON.stringify({ sessionId: 'sample', messages: [{ type: 'user', content: [{ text: 'hello' }] }] }))
  expect(await cache.visible(target)).toBe(true)
})
it('keeps corrupt and unsupported records visible after probing', async () => {
  for (const [format, raw] of [['gemini', '{broken'], ['unsupported', '{}']] as const) {
    const { cache, target } = await setup(format, raw)
    await cache.visible(target)
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await cache.visible(target)).toBe(true)
  }
})
it('hides a missing body and restores it when recreated', async () => {
  const { cache, target } = await setup('gemini', '')
  await rm(target.path)
  await expect.poll(() => cache.visible(target), { timeout: 5000 }).toBe(false)
  await writeFile(target.path, '{broken')
  expect(await cache.visible(target)).toBe(true)
})

it('keeps nonempty unrecognized messages visible instead of treating parser loss as empty', async () => {
  const { cache, target } = await setup('gemini', JSON.stringify({ sessionId: 'sample', messages: [{ type: 'future-message', content: [{ image: 'data' }] }] }))
  await cache.visible(target)
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(await cache.visible(target)).toBe(true)
})

it.each(['opencode', 'mimocode', 'kilocode', 'teleagent', 'zcode', 'hermes', 'goose', 'crush'])('checks empty %s database sessions without reading unrelated messages', async format => {
  const dir = await mkdtemp(join(tmpdir(), 'ref-empty-db-')); dirs.push(dir)
  const path = join(dir, 'sessions.db')
  const plural = ['hermes', 'goose', 'crush'].includes(format)
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE ${plural ? 'sessions' : 'session'} (id TEXT); CREATE TABLE ${plural ? 'messages' : 'message'} (session_id TEXT); INSERT INTO ${plural ? 'sessions' : 'session'} VALUES ('sample');`)
  db.close()
  const cache = new ConversationAvailability(); caches.push(cache)
  await expect.poll(() => cache.visible({ format, path, sessionId: 'sample' }), { timeout: 4000 }).toBe(false)
})
