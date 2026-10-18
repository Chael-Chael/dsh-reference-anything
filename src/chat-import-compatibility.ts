import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { readFile } from 'node:fs/promises'
import { resolveLocalPlugins } from './local-plugins.ts'
import { compareVersions } from './update.ts'

const PACKAGE = 'dsh-chat-import'
// shortcut: npm has not published the API release; remove this fallback once it has.
const API_RELEASE = 'https://codeload.github.com/Nwflower/dsh-chat-import/tar.gz/90377104c2b0f8932a63daa871ff7083ddb7c77d'
export const CHAT_IMPORT_APIS = ['scanDiscover', 'importPath', 'resumeSummary'] as const
export interface ChatImportCompatibility {
  state: 'ready' | 'incompatible' | 'unavailable' | 'disabled' | 'installing' | 'restart-required'
  version: string
  missing: string[]
  canUpgrade: boolean
  error?: string
}
interface Installation { pending?: Promise<void>; restart?: boolean; error?: string }
const installations = new WeakMap<Context, Installation>()
function installation(ctx: Context): Installation {
  let value = installations.get(ctx.root)
  if (!value) installations.set(ctx.root, value = {})
  return value
}
export function missingChatImportApis(service: unknown): string[] {
  const api = service as Record<string, unknown> | undefined
  return CHAT_IMPORT_APIS.filter(name => typeof api?.[name] !== 'function')
}
async function profile(ctx: Context) {
  const base = ctx.get('loader')?.root.ctx.baseUrl
  if (!base?.startsWith('file:')) return undefined
  return JSON.parse(await readFile(new URL('package.json', base), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}'
    throw error
  }))
}
async function provider(ctx: Context) {
  const installed = (await resolveLocalPlugins(ctx)).find(row => row.name === PACKAGE)
  const owner = await profile(ctx)
  const declared = typeof owner?.dependencies?.[PACKAGE] === 'string'
  return { installed, present: declared || Boolean(installed) || Boolean(ctx.get('chatImport')),
    disabled: installed?.status === 'disabled' || (declared && !owner?.dsh?.profile?.bundles?.includes(PACKAGE)) }
}
export async function chatImportCompatibility(ctx: Context): Promise<ChatImportCompatibility> {
  const { installed, disabled } = await provider(ctx)
  const missing = missingChatImportApis(ctx.get('chatImport'))
  const operation = installation(ctx)
  const manager = ctx.get('pluginManager')
  return {
    state: operation.pending ? 'installing' : operation.restart ? 'restart-required' : !missing.length ? 'ready' : disabled ? 'disabled' : installed?.status === 'live' ? 'incompatible' : 'unavailable',
    version: installed?.version ?? '', missing,
    canUpgrade: Boolean(manager) && !disabled && missing.length > 0 && !operation.pending && !operation.restart,
    ...(operation.error ? { error: operation.error } : !manager && missing.length ? { error: 'DSH Plugin Manager is unavailable. Install Chat Import through DSH or upgrade DSH.' } : {}),
  }
}
export async function chatImportUpgradeTarget(signal?: AbortSignal): Promise<{ spec: string; version: string }> {
  const response = await fetch('https://registry.npmjs.org/dsh-chat-import/latest', { signal: AbortSignal.any([AbortSignal.timeout(15_000), ...signal ? [signal] : []]) })
  if (!response.ok) throw new Error(`Chat Import update lookup failed (${response.status})`)
  const latest = await response.json() as { name?: string; version?: string }
  if (latest.name !== PACKAGE || !latest.version || !/^\d+\.\d+\.\d+$/.test(latest.version)) throw new Error('Invalid Chat Import registry response')
  return compareVersions(latest.version, '0.26.0') >= 0 ? { spec: `${PACKAGE}@${latest.version}`, version: latest.version } : { spec: API_RELEASE, version: '0.26.0' }
}
/** Auto-install only absent providers; explicit requests can upgrade incompatible providers. */
export function ensureChatImport(ctx: Context, upgrade = false, signal?: AbortSignal): Promise<void> {
  const operation = installation(ctx)
  if (operation.pending) return operation.pending
  operation.pending = (async () => {
    const current = await provider(ctx)
    if (current.disabled || operation.restart || (!upgrade && current.present) || !missingChatImportApis(ctx.get('chatImport')).length) return
    const manager = ctx.get('pluginManager')
    if (!manager) throw new Error('DSH Plugin Manager is unavailable. Install Chat Import through DSH or upgrade DSH.')
    const target = await chatImportUpgradeTarget(signal)
    if (current.installed?.version && /^\d+\.\d+\.\d+$/.test(current.installed.version) && compareVersions(current.installed.version, target.version) >= 0) throw new Error('No newer compatible Chat Import release is available. Restart DSH or check the plugin installation.')
    signal?.throwIfAborted()
    // Recheck after the network lookup in case the user installed or disabled it meanwhile.
    const latest = await provider(ctx)
    if (latest.disabled || (!upgrade && latest.present)) return
    const result = await manager.installBundle(target.spec, { enabled: true })
    if (result.application !== 'applied' && result.application !== 'restart-required') throw new Error(result.error?.diagnostic || `Chat Import installation ${result.application}`)
    operation.restart = result.application === 'restart-required'
  })().then(() => { operation.error = undefined }).catch(error => {
    operation.error = error instanceof Error ? error.message : String(error)
    throw error
  }).finally(() => { operation.pending = undefined })
  return operation.pending
}
export const upgradeChatImport = (ctx: Context, signal?: AbortSignal) => ensureChatImport(ctx, true, signal)
