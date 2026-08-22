import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from './openlist/index.ts'
import { ReferenceAnythingRemote } from './host.ts'
import { TYPERT_MANIFEST } from './typert.ts'

export const name = 'reference-anything-web'
// `referenceCloudDrive` is consumed lazily by ReferenceAnythingRemote when the
// composer asks for @drive candidates. Declare it here so Cordis exposes the
// sibling service in this plugin scope instead of making driveSearch silently
// look like an unconfigured installation.
export const inject = ['typert', 'referenceChatHistory', 'openListManager', 'referenceCloudDrive']

export function apply(ctx: Context): void {
  new ReferenceAnythingRemote(ctx)
  ctx.effect(() => {
    const dispose = ctx.typert.register(TYPERT_MANIFEST)
    return () => { void dispose() }
  }, 'reference-anything-web.typert')
}
