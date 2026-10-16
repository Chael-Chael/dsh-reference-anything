import { type Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import * as ChatImport from 'dsh-chat-import'
import { resolveLocalPlugins } from './local-plugins.ts'
import { readFile } from 'node:fs/promises'

export const name = 'reference-chat-import-runtime'
export const inject = ['loader']
// Upstream's hand-written HostContext types do not model Cordis's required inject callback.
const plugin = ChatImport as unknown as Plugin.Object

/** Prefer profile-owned providers; own only the fallback created here. */
export function apply(ctx: Context): void {
  let owned: Fiber | undefined
  let starting = false
  let disposed = false

  ctx.on('internal/plugin', fiber => {
    if (!owned || starting || fiber.uid === null || fiber === owned) return
    if (fiber.runtime?.callback !== ChatImport.apply && fiber.runtime?.name !== ChatImport.name) return
    // Hold the new provider before activation until our registrations are gone.
    const handoffService = `referenceChatImportReleased${fiber.uid}`
    fiber.inject[handoffService] = null
    const previous = owned
    owned = undefined
    void Promise.resolve(previous.dispose()).then(() => {
      if (fiber.uid !== null) {
        const release = ctx.root.provide(handoffService, true)
        fiber.ctx.effect(() => () => { void release() }, 'reference-chat-import-runtime.handoff')
      }
    }).catch(error => ctx.logger.error(error))
  })

  const start = async (): Promise<void> => {
    await ctx.loader.await()
    const baseUrl = ctx.loader.root.ctx.baseUrl
    if (baseUrl?.startsWith('file:')) {
      const manifest = await readFile(new URL('./package.json', baseUrl), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '{}'
        throw error
      })
      const profile = JSON.parse(manifest)
      if (Object.hasOwn(profile.dependencies ?? {}, 'dsh-chat-import')) return
    }
    const independent = (await resolveLocalPlugins(ctx)).some(plugin => plugin.name === 'dsh-chat-import')
    if (disposed || independent || ctx.get('chatImport') || ctx.registry.has(plugin)
      || [...ctx.registry.values()].some(runtime => runtime.name === ChatImport.name)) return
    starting = true
    try {
      owned = ctx.plugin(plugin).ctx.fiber
    } finally { starting = false }
    await owned.await()
  }
  // Defer until this bootstrap fiber is active, so loader.await cannot await itself.
  const timer = setTimeout(() => { void start().catch(error => ctx.logger.error(error)) }, 0)
  ctx.effect(() => () => {
    disposed = true
    clearTimeout(timer)
  }, 'reference-chat-import-runtime.stop')
}
