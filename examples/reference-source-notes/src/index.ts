/**
 * Host half: a reference source over the notes in one directory.
 *
 * The source writes only `load` (one note as records) and `list` (candidates);
 * `defineReferenceSource` gives the `reference` tool its list, search, read,
 * paging, continuation and revision checks. Everything goes through
 * `ctx.references`, so the source unloads with this plugin: switching its row
 * off removes it from the `reference` tool, the `@` menu and the settings panel at once.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { defineReferenceSource, referenceError } from 'dsh-reference-anything/source'
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

  const available = async () => (await stat(root).catch(() => undefined))?.isDirectory() === true
  ctx.effect(() => ctx.references.registerPlugin(defineReferenceSource({
    source: SOURCE_ID,
    usage: 'Markdown and text notes from one folder. Ids are file names such as plan.md; read one for its paragraphs.',
    async list(query) {
      if (!await available()) throw referenceError('SOURCE_UNAVAILABLE', 'The notes folder is missing.')
      return { items: (await notes()).filter(note => note.label.includes(query)).map(note => ({ id: note.id, title: note.label, updatedAt: note.updatedAt })) }
    },
    async load(id) {
      // Ids are file names inside `root`, never paths.
      if (id.includes('/') || id.includes('\\') || id.startsWith('.')) throw referenceError('NOT_FOUND', `not a note: ${id}`)
      if (!settings.get().extensions.includes(extname(id).toLowerCase())) throw referenceError('SOURCE_DISABLED', `note type is switched off: ${id}`)
      const text = await readFile(join(root, id), 'utf8').catch(() => { throw referenceError('NOT_FOUND', `no such note: ${id}`, 'relist') })
      const blocks = text.split(/\n{2,}/u).filter(block => block.trim() !== '')
      return { title: id, content: blocks.map(block => ({ role: 'document' as const, text: block })) }
    },
  })), 'reference-notes.source')

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
