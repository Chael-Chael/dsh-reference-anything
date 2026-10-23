import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { readFile } from 'node:fs/promises'
import { resolveLocalPlugins } from './local-plugins.ts'
import { compareVersions } from './update.ts'

const PACKAGE = 'dsh-chat-import'
const MIN_VERSION = '0.26.2'
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
  const outdated = Boolean(installed?.version && compareVersions(installed.version, MIN_VERSION) < 0)
  const incompatible = missing.length > 0 || outdated
  return {
    state: operation.pending ? 'installing' : operation.restart ? 'restart-required' : disabled ? 'disabled' : !incompatible ? 'ready' : installed?.status === 'live' ? 'incompatible' : 'unavailable',
    version: installed?.version ?? '', missing,
    canUpgrade: Boolean(manager) && !disabled && incompatible && !operation.pending && !operation.restart,
    ...(operation.error ? { error: operation.error } : !manager && missing.length ? { error: 'DSH Plugin Manager is unavailable. Install Chat Import through DSH or upgrade DSH.' } : {}),
  }
}
export async function chatImportUpgradeTarget(signal?: AbortSignal): Promise<{ spec: string; version: string }> {
  const response = await fetch('https://registry.npmjs.org/dsh-chat-import/latest', { signal: AbortSignal.any([AbortSignal.timeout(15_000), ...signal ? [signal] : []]) })
  if (!response.ok) throw new Error(`Chat Import update lookup failed (${response.status})`)
  const latest = await response.json() as { name?: string; version?: string }
  if (latest.name !== PACKAGE || !latest.version || !/^\d+\.\d+\.\d+$/.test(latest.version)) throw new Error('Invalid Chat Import registry response')
  if (compareVersions(latest.version, MIN_VERSION) < 0) throw new Error(`dsh-chat-import ${MIN_VERSION} or newer is required; no compatible npm release is available.`)
  return { spec: `${PACKAGE}@${latest.version}`, version: latest.version }
}
/** Auto-install only absent providers; explicit requests can upgrade incompatible providers. */
export function ensureChatImport(ctx: Context, upgrade = false, signal?: AbortSignal): Promise<void> {
  const operation = installation(ctx)
  if (operation.pending) return operation.pending
  operation.pending = (async () => {
    const current = await provider(ctx)
    if (current.disabled || operation.restart || (!upgrade && (current.present || !missingChatImportApis(ctx.get('chatImport')).length))) return
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
