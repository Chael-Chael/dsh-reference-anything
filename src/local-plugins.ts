import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { LocalPluginCandidate } from './contract.ts'

const manifestSchema = z.object({
  name: z.string().optional(), version: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  dsh: z.object({
    bundle: z.object({ patch: z.string() }).optional(),
    client: z.unknown().optional(),
    profile: z.object({ bundles: z.array(z.string()).optional() }).optional(),
  }).optional(),
})

async function readManifest(directory: string) {
  try { return manifestSchema.parse(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))) }
  catch { return undefined /* Missing or invalid optional metadata must not hide a configured entry. */ }
}

async function pluginPackage(name: string, baseUrl: string | undefined) {
  if (!baseUrl?.startsWith('file:')) return undefined
  const require = createRequire(new URL('./package.json', baseUrl))
  if (!name.startsWith('.') && !name.startsWith('/') && !name.includes(':')) {
    const packageName = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
    for (const searchPath of require.resolve.paths(packageName) ?? []) {
      const directory = join(searchPath, packageName)
      const manifest = await readManifest(directory)
      if (manifest) return { directory: await realpath(directory), manifest }
    }
    return undefined
  }
  try {
    const url = isAbsolute(name) ? pathToFileURL(name) : new URL(name.replace(/\\/gu, '/'), baseUrl)
    const path = await realpath(fileURLToPath(url))
    const directory = (await stat(path)).isDirectory() ? path : dirname(path)
    let parent = directory
    while (true) {
      const manifest = await readManifest(parent)
      if (manifest) return manifest.dsh?.profile ? { directory, manifest: {} } : { directory: parent, manifest }
      if (dirname(parent) === parent) return { directory, manifest: {} }
      parent = dirname(parent)
    }
  } catch { return undefined /* A disabled or failed local entry may no longer exist on disk. */ }
}

const STATUS_ORDER = { live: 0, inert: 1, disabled: 2 } as const
// Cordis publishes FiberState as an ambient const enum, unavailable with verbatimModuleSyntax.
const ACTIVE = 2 // FiberState.ACTIVE

/** Read the active loader's composed entries, including bundle patches and effective disables. */
export async function resolveLocalPlugins(ctx: Context): Promise<readonly LocalPluginCandidate[]> {
  const loader = ctx.get('loader')
  if (!loader) return []
  const plugins = new Map<string, LocalPluginCandidate>()
  for (const entry of loader.entries()) {
    if (entry.options.name.startsWith('cordis:') || entry.options.group) continue
    const info = await pluginPackage(entry.options.name, entry.parent.tree.ctx.baseUrl)
    const name = info?.manifest.name ?? entry.options.name
    const status = entry.disabled ? 'disabled' : entry.fiber?.state === ACTIVE ? 'live' : 'inert'
    const previous = plugins.get(name)
    if (previous && STATUS_ORDER[previous.status] <= STATUS_ORDER[status]) continue
    plugins.set(name, {
      id: entry.id, name, label: name, status,
      ...(info ? { directory: info.directory, version: info.manifest.version } : {}),
    })
  }

  // Installed bundles/client plugins can exist without a host entry. Ordinary dependencies are omitted.
  const baseUrl = loader.root.ctx.baseUrl
  if (baseUrl?.startsWith('file:')) {
    const profile = await readManifest(fileURLToPath(new URL('.', baseUrl)))
    const bundles = new Set(profile?.dsh?.profile?.bundles ?? [])
    for (const packageName of new Set([...Object.keys(profile?.dependencies ?? {}), ...bundles])) {
      const info = await pluginPackage(packageName, baseUrl)
      if (!bundles.has(packageName) && !info?.manifest.dsh?.bundle && !info?.manifest.dsh?.client) continue
      const name = info?.manifest.name ?? packageName
      if (plugins.has(name)) continue
      plugins.set(name, {
        id: packageName, name, label: name, status: 'inert',
        ...(info ? { directory: info.directory, version: info.manifest.version } : {}),
      })
    }
  }
  return [...plugins.values()].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name))
}
