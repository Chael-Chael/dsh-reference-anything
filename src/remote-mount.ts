import type { Context } from '@deepseek-ai/cordis'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import type {} from '@deepseek-ai/dsh-typert-registry'

/**
 * Mount one Remote for as long as Typert is present. Without Typert the
 * owning plugin still works for the model; only its browser surface is absent.
 * @param ctx - the owning plugin's context; the Remote unloads with it.
 * @param create - constructs the Remote service in the given scope.
 * @param manifest - the Typert contribution describing that Remote.
 */
export function mountRemote(ctx: Context, create: (scope: Context) => unknown, manifest: TypertContribution): void {
  ctx.inject(['typert'], scope => {
    create(scope)
    scope.effect(() => {
      const dispose = scope.typert.register(manifest)
      return () => { void dispose() }
    }, `remote:${manifest.model.services[0]?.key ?? manifest.package}`)
  })
}
