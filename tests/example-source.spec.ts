import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ReferenceRuntime from '../src/index.ts'
import * as tool from '../src/tool.ts'
import { parseReferenceText } from '../src/uri.ts'
import { createReferenceGroupRegistry } from '../src/client/source-registry.ts'
import * as notes from '../examples/reference-source-notes/src/index.ts'
import { notesGroup } from '../examples/reference-source-notes/src/client.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reference-notes-'))
  await writeFile(join(root, 'plan.md'), 'first block\n\nsecond block')
  await writeFile(join(root, 'ignored.json'), '{}')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function mount() {
  const ctx = new Context()
  await ctx.plugin(ReferenceRuntime, {})
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(tool, {})
  const fiber = await ctx.plugin(notes, { directory: root })
  return { ctx, fiber }
}

let call = 0
const agent = { session: Session.create(SessionId('notes-task')), options: { provider: 'test', model: 'test' } } as Agent
function run(ctx: Context, args: unknown) {
  return ctx.tools.execute({ agent, signal: new AbortController().signal, callId: `notes-${++call}` as never, name: 'reference', arguments: args })
}
const text = (result: { content: readonly { type: string; text?: string }[] }) => result.content.map(block => block.text ?? '').join('')

describe('example third-party source', () => {
  it('needs only load and list for the whole list, search and read flow, with no change to the core', async () => {
    const { ctx } = await mount()
    // Reading needs the user's @; listing never grants it.
    const listed = await run(ctx, { source: 'notes', op: 'list', args: { query: 'plan' } })
    expect(listed.isError, text(listed)).not.toBe(true)
    expect((listed.value as { items: unknown[] }).items).toMatchObject([{ source: 'notes', id: 'plan.md', title: 'plan.md' }])
    expect(text(listed)).not.toContain('ignored.json')
    const refused = await run(ctx, { source: 'notes', id: 'plan.md', op: 'read' })
    expect(text(refused)).toContain('UNAUTHORIZED')
    ctx.references.grantPlugin(String(agent.session.id), 'notes', 'plan.md')
    const read = await run(ctx, { source: 'notes', id: 'plan.md', op: 'read' })
    expect(read.isError, text(read)).not.toBe(true)
    expect(text(read)).toContain('second block')
    expect((read.value as { content: Array<{ role: string }> }).content.every(item => item.role === 'document')).toBe(true)
    const search = await run(ctx, { source: 'notes', id: 'plan.md', op: 'search', args: { query: 'second' } })
    expect((search.value as { hits: unknown[] }).hits).toHaveLength(1)
    const titles = await run(ctx, { source: 'notes', op: 'search', args: { query: 'plan' } })
    expect((titles.value as { hits: unknown[] }).hits).toMatchObject([{ id: 'plan.md' }])
  })

  it('keeps its settings in the core and takes its source with it when switched off', async () => {
    const { ctx, fiber } = await mount()
    expect(ctx.references.settingsOf('notes')).toEqual({ extensions: ['.md', '.txt'] })
    await ctx.references.updateSettings('notes', { extensions: ['.txt'] })
    expect((await run(ctx, { source: 'notes', op: 'list' })).value).toMatchObject({ items: [] })
    await fiber.dispose()
    expect(ctx.references.plugin('notes')).toBeUndefined()
    expect(ctx.references.settingsIds()).not.toContain('notes')
  })

  it('adds an @ group that inserts a reference the core can parse', async () => {
    const registry = createReferenceGroupRegistry(['agents'])
    const dispose = registry.register(notesGroup(async () => [{ id: 'plan.md', label: 'plan.md', updatedAt: 1 }]))
    const group = registry.list()[0]!
    const source = group.create({ order: 45, limit: 6, maxCandidates: 50, displayMode: 'collapse', shortcuts: { note: ['notes'], agent: ['agents'] } })
    const signal = new AbortController().signal
    const request = (query: string) => ({ query, quoted: false, position: 0, drilled: undefined, signal }) as never
    expect(await source.candidates({} as never, request('agent:x'))).toEqual([])
    const candidates = await source.candidates({} as never, request('note:plan'))
    expect(candidates).toHaveLength(1)
    const outcome = await source.onPick({ candidate: candidates[0]! } as never) as { insert: { ref: string } }
    expect(parseReferenceText(outcome.insert.ref).references[0]?.ref).toEqual({ source: 'notes', id: 'plan.md' })
    dispose()
  })
})
