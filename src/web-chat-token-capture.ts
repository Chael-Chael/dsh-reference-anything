import { randomUUID } from 'node:crypto'
import { Page } from '@jackwener/opencli/browser/page'
// @ts-expect-error -- shipped browser adapter helpers.
import { evaluateWhenProviderReady } from '../opencli-plugin/common.js'
// @ts-expect-error -- shipped browser adapter script.
import { whoamiScript as deepseekIdentity } from '../opencli-plugin/deepseek-scripts.js'
// @ts-expect-error -- shipped browser adapter script.
import { whoamiScript as kimiIdentity } from '../opencli-plugin/kimi-scripts.js'
import type { TokenProvider } from './web-chat-token.ts'

/** OpenCLI's public Page API keeps the credential out of child-process output. */
export async function captureWebChatToken(provider: TokenProvider, profile: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const page = new Page(`dsh-token-${randomUUID()}`, 60, profile, 'background', 'browser')
  try {
    // Adapter containers may retain stale login snapshots; capture the user's live browser login.
    const tab = await page.newTab(provider === 'deepseek' ? 'https://chat.deepseek.com/' : 'https://www.kimi.com/')
    if (!tab) throw new Error('Browser did not create a login tab')
    page.setActivePage(tab)
    const identity = await evaluateWhenProviderReady(page, provider === 'deepseek' ? deepseekIdentity : kimiIdentity, {}, 'connect account', {
      // A freshly opened SPA can still be refreshing an expired access token.
      accepts: (result: { ok?: boolean; code?: string }) => result?.ok === true || result?.code === 'RATE_LIMIT',
    })
    if (identity?.ok !== true || !identity.identity) throw new Error('Login required')
    signal?.throwIfAborted()
    const token = await page.evaluate<string>(`(() => {
      const key = ${JSON.stringify(provider === 'deepseek' ? 'userToken' : 'access_token')}
      const raw = localStorage.getItem(key) || ''
      if (key !== 'userToken') return raw
      try { const value = JSON.parse(raw); return typeof value === 'string' ? value : value?.value || value?.token || '' } catch { return '' }
    })()`)
    signal?.throwIfAborted()
    if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n]/.test(token)) throw new Error('Invalid credential')
    return token
  } finally { await page.closeTab().catch(() => {}) }
}
