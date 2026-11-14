import type { Page } from '@jackwener/opencli/browser/page'
import { credentialEndpoints, newWebHomes, type CapturedWebCredential, type NewWebProvider, type RequestTemplate } from './web-chat-new-providers.ts'

/** Copy only read endpoints and their domain-scoped credentials; never persist network response bodies. */
export async function captureNewWebCredential(page: Page, provider: NewWebProvider, signal?: AbortSignal): Promise<string> {
  if (provider === 'qwen') {
    for (let attempt = 0; attempt < 15; attempt++) {
      signal?.throwIfAborted()
      const ready = await page.evaluate<boolean>(`(async () => { try {
        const token = JSON.parse(localStorage.getItem('qwen_access_token_state') || 'null')?.token || localStorage.getItem('token') || ''
        if (!token) return false
        const response = await fetch('https://auth.qwen.ai/api/v2/auths/', { headers: { Authorization: 'Bearer ' + token, Version: '0.3.20', source: 'web' } })
        const value = await response.json(); return value.success === true && typeof value.data?.id === 'string'
      } catch { return false } })()`)
      if (ready) break
      if (attempt === 14) throw new Error('Login required')
      await page.wait(1)
    }
    const token = await page.evaluate<string>(`(() => { try { return JSON.parse(localStorage.getItem('qwen_access_token_state') || 'null')?.token || localStorage.getItem('token') || '' } catch { return '' } })()`)
    if (!token || token.length > 16384 || /[\r\n]/.test(token)) throw new Error('Login required')
    return token
  }
  await page.startNetworkCapture()
  await page.goto(newWebHomes[provider])
  const captured: any[] = []
  let openedDetail = false
  const endpoint = credentialEndpoints[provider]
  const find = (url: string) => captured.findLast(row => row.method !== 'OPTIONS' && !row.requestBodyTruncated
    && new URL(row.url).origin + new URL(row.url).pathname === url && row.responseStatus === 200)
  for (let attempt = 0; attempt < 20; attempt++) {
    signal?.throwIfAborted()
    captured.push(...await page.readNetworkCapture())
    if (find(endpoint.identity) && find(endpoint.list) && find(endpoint.detail)) break
    if (!openedDetail && find(endpoint.list)) {
      const request = find(endpoint.list)
      const first = await page.evaluate(async (request: { url: string; method: string; requestHeaders: Record<string, string>; requestBodyPreview: string }, provider: string) => {
        const response = await fetch(request.url, { method: request.method, headers: request.requestHeaders, body: request.requestBodyPreview, credentials: 'include' })
        const payload = await response.json()
        const list = provider === 'qianwen' ? payload.data?.list : payload.downlink_body?.pull_recent_conv_chain_downlink_body?.cells
        return { id: provider === 'qianwen' ? list?.[0]?.session_id : list?.[0]?.conversation?.conversation_id, empty: Array.isArray(list) && list.length === 0 }
      }, { url: request.url, method: request.method, requestHeaders: request.requestHeaders, requestBodyPreview: request.requestBodyPreview }, provider)
      const id = first.id
      if (typeof id === 'string' && id) {
        openedDetail = true
        await page.goto(`${new URL(newWebHomes[provider]).origin}/chat/${encodeURIComponent(id)}`)
      } else if (first.empty) break
    }
    await page.wait(1)
  }
  const result: Partial<CapturedWebCredential> = {}
  for (const operation of ['identity', 'list', 'detail'] as const) {
    const row = find(endpoint[operation])
    if (!row) { if (operation === 'detail') continue; throw new Error('Open the website history and reconnect') }
    const url = new URL(row.url)
    const headers: Record<string, string> = { Accept: 'application/json', Origin: new URL(newWebHomes[provider]).origin }
    for (const [key, value] of Object.entries(row.requestHeaders || {})) {
      if (/^(content-type|user-agent|referer|x-deviceid|x-platform|x-xsrf-token|x-user-id|agw-js-conv)$/i.test(key)
        && typeof value === 'string' && !/[\r\n]/.test(value)) headers[key] = value
    }
    const cookies = await page.getCookies({ url: url.href })
    headers.Cookie = cookies.filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '')
      const path = cookie.path || '/'
      return (url.hostname === domain || cookie.domain.startsWith('.') && url.hostname.endsWith('.' + domain))
        && (url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : path + '/'))
        && (!cookie.secure || url.protocol === 'https:')
        && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) && !/[\r\n;]/.test(cookie.value)
    }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    const template: RequestTemplate = { url: url.href, method: row.method, headers }
    if (row.method === 'POST') {
      JSON.parse(row.requestBodyPreview)
      template.body = row.requestBodyPreview
    }
    result[operation] = template
  }
  signal?.throwIfAborted()
  return JSON.stringify(result)
}
