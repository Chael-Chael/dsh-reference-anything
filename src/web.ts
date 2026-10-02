import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from './openlist/index.ts'
import { ReferenceAnythingRemote } from './host.ts'
import { TYPERT_MANIFEST } from './typert.ts'

export const name = 'reference-anything-web'
// ReferenceAnythingRemote looks up optional sources through ctx.get(). Making
// cloud drives a required injection blocks all conversation endpoints when
// that source is disabled or unavailable in the active profile.
export const inject = ['typert', 'referenceChatHistory', 'openListManager']

export function apply(ctx: Context): void {
  new ReferenceAnythingRemote(ctx)
  ctx.effect(() => {
    const dispose = ctx.typert.register(TYPERT_MANIFEST)
    return () => { void dispose() }
  }, 'reference-anything-web.typert')
}
