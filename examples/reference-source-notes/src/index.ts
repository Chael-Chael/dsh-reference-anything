/**
 * Host half: a reference source over the notes in one directory.
 *
 * Everything here goes through `ctx.references`, so the source unloads with
 * this plugin: switching its row off removes it from the model's tools, the
 * `@` menu, and the settings panel at once.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { ReferenceSource, ReferenceSummary } from 'dsh-reference-anything/sdk'
import { INVOCATIONS, PACKAGE, SERVICE, SOURCE_ID, type Note } from './contract.ts'

export const name = 'reference-notes'
export const inject = ['references']

/** Deployment config: where the notes live. */
export interface Config { directory?: string }
export const Config: z<Config> = z.object({ directory: z.string().default('notes') })

/** User settings, stored by Reference Anything under this source id. */
const settingsSchema = zod.object({ extensions: zod.array(zod.string().startsWith('.')).default(['.md', '.txt']) })

/** The Remote the browser group calls. */
class NotesRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly notes: () => Promise<Note[]>) { super(ctx, SERVICE) }
  async search(input: { query: string; limit: number }, signal: AbortSignal): Promise<Note[]> {
    signal.throwIfAborted()
    const needle = input.query.toLocaleLowerCase()
    return (await this.notes()).filter(note => note.label.toLocaleLowerCase().includes(needle)).slice(0, input.limit)
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const root = resolve(config.directory ?? 'notes')
  const settings = ctx.references.defineSettings(SOURCE_ID, {
    schema: settingsSchema, defaults: { extensions: ['.md', '.txt'] },
  })

  const notes = async (): Promise<Note[]> => {
    const wanted = new Set(settings.get().extensions)
    let names: string[]
    try { names = await readdir(root) } catch { return [] }
    const rows = await Promise.all(names.filter(entry => wanted.has(extname(entry).toLowerCase())).map(async entry => ({
      id: entry, label: entry, updatedAt: (await stat(join(root, entry))).mtimeMs,
    })))
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  const source: ReferenceSource = {
    id: SOURCE_ID,
    // The user's own files, but outside the task: the model reads only what was named.
    requiresGrant: true,
    available: async () => (await stat(root).catch(() => undefined))?.isDirectory() === true,
    async list(query, limit): Promise<ReferenceSummary[]> {
      const needle = query.toLocaleLowerCase()
      return (await notes()).filter(note => note.label.toLocaleLowerCase().includes(needle)).slice(0, limit)
        .map(note => ({ ref: { source: SOURCE_ID, id: note.id }, label: note.label, updatedAt: note.updatedAt }))
    },
    async read(ref, window) {
      // Ids are file names inside `root`, never paths.
      if (ref.id.includes('/') || ref.id.includes('\\') || ref.id.startsWith('.')) throw new Error(`not a note: ${ref.id}`)
      if (!settings.get().extensions.includes(extname(ref.id).toLowerCase())) throw new Error(`note type is switched off: ${ref.id}`)
      const text = await readFile(join(root, ref.id), 'utf8')
      const blocks = text.split(/\n{2,}/u).filter(block => block.trim() !== '')
      // An empty success would read as "the note says nothing"; fail instead.
      if (blocks.length === 0) throw new Error(`note ${ref.id} is empty`)
      const end = Math.min(window.before ?? blocks.length, blocks.length)
      const start = Math.max(0, end - window.limit)
      return {
        ref, label: ref.id, partial: false, capturedAt: Date.now(),
        body: {
          kind: 'conversation', startIndex: start, totalTurns: blocks.length, hasOlder: start > 0,
          items: blocks.slice(start, end).map(block => ({ role: 'document' as const, text: block })),
        },
      }
    },
  }
  ctx.effect(() => ctx.references.registerSource(source), 'reference-notes.source')

  // The browser half needs a Remote; mount it only where Typert exists.
  ctx.inject(['typert'], scope => {
    new NotesRemote(scope, notes)
    scope.effect(() => {
      const dispose = scope.typert.register({
        package: PACKAGE, face: 'host', schemas: [], invocations: INVOCATIONS,
        model: {
          services: [{
            key: SERVICE, exportName: 'NotesRemote', description: 'Note search for the @ menu.', tags: [], types: [],
            members: [{ kind: 'method', name: 'search', signature: 'search(input: SearchInput, signal: AbortSignal): Promise<Note[]>' }],
          }],
          events: [], objects: [],
        },
      })
      return () => { void dispose() }
    }, 'reference-notes.typert')
  })
}
