import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as bootstrap from '../src/chat-import-runtime.ts'

it('loads the shipped upstream package and scans an isolated fixture through its public API', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'reference-import-integration-'))
  const ctx = new Context()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  try {
    const transcript = join(directory, 'fixture.jsonl')
    await fs.writeFile(transcript, JSON.stringify({ sessionId: 'fixture', type: 'user', message: { role: 'user', content: 'Integration fixture' } }) + '\n')
    ctx.provide('sessionPersistence', {})
    ctx.provide('fs', {
      resolve: (path: string) => path,
      stat: async (path: string) => {
        const info = await fs.stat(path)
        return { type: info.isDirectory() ? 'directory' : 'file', size: info.size, mtimeMs: info.mtimeMs }
      },
      readText: (path: string) => fs.readFile(path, 'utf8'),
    })
    ctx.provide('tools', { register: () => () => {} })
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(directory).href + '/' })
    await ctx.plugin(bootstrap)
    await vi.waitFor(() => expect(ctx.get('chatImport')).toBeDefined())
    const service = ctx.get('chatImport')!
    expect(typeof service.importPath).toBe('function')
    expect(typeof service.resumeSummary).toBe('function')
    const result = await service.scanDiscover({ format: 'claude', path: transcript })
    expect(result).toMatchObject({ total: 1, sessions: [{ sessionId: 'fixture' }] })
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fs.rm(directory, { recursive: true, force: true })
  }
})
