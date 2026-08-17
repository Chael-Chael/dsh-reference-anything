import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { ReferenceAnythingRemote } from './host.ts'
import { TYPERT_MANIFEST } from './typert.ts'

export const name = 'reference-anything-web'
export const inject = ['typert', 'referenceChatHistory', 'sessionReferenceResolver']

export function apply(ctx: Context): void {
  new ReferenceAnythingRemote(ctx)
  ctx.effect(() => {
    const dispose = ctx.typert.register(TYPERT_MANIFEST)
    return () => { void dispose() }
  }, 'reference-anything-web.typert')
}
