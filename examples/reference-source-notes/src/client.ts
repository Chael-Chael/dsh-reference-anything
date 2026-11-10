/**
 * Browser half: a "Notes" group in the `@` menu.
 *
 * Reference Anything applies the user's order, limit and shortcut settings to
 * the group and hides it while the Host source is not loaded.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { formatReferenceMention, scopedGroupQuery, type ReferenceGroup } from 'dsh-reference-anything/sdk'
import { INVOCATIONS, PACKAGE, SERVICE, SOURCE_ID, type Note } from './contract.ts'

export const inject = ['remote', 'referenceSources']

interface NotesFace { search(input: { query: string; limit: number }, signal?: AbortSignal): Promise<RemoteResult<readonly Note[]>> }

/** The group alone, so it can be built and tested without a page. */
export function notesGroup(search: (query: string, limit: number, signal: AbortSignal) => Promise<readonly Note[]>): ReferenceGroup {
  return {
    id: 'notes', label: 'Notes', hostSource: SOURCE_ID, order: 45, aliases: ['note'],
    create: options => ({
      trigger: '@', name: 'Notes', order: options.order,
      async candidates(_session, { query, quoted, signal }) {
        const scoped = quoted ? undefined : scopedGroupQuery(query, 'notes', options)
        if (scoped === undefined) return []
        return (await search(scoped, options.maxCandidates, signal)).map(note => ({ name: note.label, icon: 'file' as const, value: note.id }))
      },
      onPick({ candidate }) {
        const mention = formatReferenceMention({ source: SOURCE_ID, id: String(candidate.value) }, candidate.name)
        return { insert: { source: 'Notes', ref: mention, label: candidate.name, appearance: 'file' as const, clipboardText: mention } }
      },
      codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
    }),
  }
}

export async function apply(ctx: Context): Promise<void> {
  const contribution: TypertRemoteContribution = { package: PACKAGE, descriptors: INVOCATIONS }
  const disposeRemote = await ctx.remote.$mount(contribution)
  ctx.effect(() => () => { void disposeRemote() }, 'reference-notes.remote')
  const face = (ctx.reflect as unknown as { get(name: string): unknown }).get(`remote.${SERVICE}`) as NotesFace
  ctx.effect(() => ctx.referenceSources.register(notesGroup(async (query, limit, signal) => {
    const result = await face.search({ query, limit }, signal)
    return result.ok ? result.value : []
  })), 'reference-notes.group')
}
