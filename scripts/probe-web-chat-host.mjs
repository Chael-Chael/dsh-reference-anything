import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

export const providers = ['deepseek', 'kimi', 'chatgpt', 'claude', 'grok', 'gemini']

export function failureCode(error) {
  if (error?.cause?.code === 'UND_ERR_HEADERS_OVERFLOW') return 'HEADERS_TOO_LARGE'
  const message = String(error?.message || '')
  if (/Navigation rejected/i.test(message)) return 'NAVIGATION_REJECTED'
  if (/not connected/i.test(message)) return 'EXTENSION_DISCONNECTED'
  if (/timeout|timed out/i.test(message)) return 'TIMEOUT'
  if (/fetch failed/i.test(message)) return 'NETWORK_FAILED'
  return 'PROBE_UNAVAILABLE'
}

// Reuse the shipped parsers, but stop after one list page during diagnostics.
export async function loadAdapter(provider) {
  if (!providers.includes(provider)) throw new Error('UNKNOWN_PROVIDER')
  let source = await readFile(new URL(`../opencli-plugin/${provider}.js`, import.meta.url), 'utf8')
  if (provider === 'deepseek' || provider === 'kimi') source = (await readFile(new URL(`../opencli-plugin/${provider}-scripts.js`, import.meta.url), 'utf8')) + '\n' + source
  source = source.replace(/^export \{.*$/gm, '')
  let adapter
  runInNewContext(source.replace(/^import .*$/gm, '').replace(/^export /gm, ''), {
    registerProvider: value => { adapter = value }, domFallbackScript: '',
    sinceGuardSource: '() => () => true',
  }, { timeout: 1000 })
  return adapter
}

export function cookieHeader(cookies, url, now = Date.now() / 1000) {
  return cookies.filter(cookie => {
    const domain = String(cookie.domain || '').replace(/^\./, '')
    const path = cookie.path || '/'
    return (cookie.hostOnly ? url.hostname === domain : url.hostname === domain || url.hostname.endsWith('.' + domain))
      && (url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : path + '/'))
      && (!cookie.secure || url.protocol === 'https:')
      && (!(cookie.expirationDate > 0) || cookie.expirationDate > now)
      && (!(cookie.expires > 0) || cookie.expires > now)
      && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)
      && !/[\r\n;]/.test(cookie.value)
  }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

export function hostFetch(origin, cookies, userAgent, requests, fetchImpl = fetch) {
  return async (input, init = {}) => {
    const url = new URL(input, origin)
    if (url.origin !== origin || url.username || url.password) throw new Error('ORIGIN_REJECTED')
    if (requests.length >= 12) throw new Error('REQUEST_LIMIT')
    const headers = new Headers(init.headers)
    headers.delete('cookie')
    const cookie = cookieHeader(cookies, url)
    if (cookie) headers.set('cookie', cookie)
    if (userAgent) headers.set('user-agent', userAgent)
    const record = { status: null, json: false }
    requests.push(record)
    const response = await fetchImpl(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(15000) })
    record.status = response.status
    record.json = (response.headers.get('content-type') || '').includes('json')
    return response
  }
}

export function parseGeminiBootstrap(html) {
  const wiz = {}
  for (const key of ['SNlM0e', 'oPEP7c', 'CfO9Re', 'FdrFJe']) {
    const match = html.match(new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")'))
    if (match) wiz[key] = JSON.parse(match[1])
  }
  return wiz
}

function execute(script, globals, args = {}) {
  const fn = runInNewContext(`(${script})`, { ...globals, URL, URLSearchParams }, { timeout: 1000 })
  return Promise.resolve(fn(args)).then(JSON.parse)
}

export async function probeHost(adapter, credentials, browserIdentity, tokenOnly = false, fetchImpl = fetch) {
  const requests = []
  const origin = new URL(adapter.home).origin
  const request = hostFetch(origin, tokenOnly ? [] : credentials.cookies, credentials.userAgent, requests, fetchImpl)
  const report = { mode: tokenOnly ? 'token-only' : 'cookies-and-token', identity: false, list: false, detail: false, requests }
  const globals = {
    fetch: request, location: { origin },
    localStorage: { getItem: key => credentials.storage[key] || null },
    document: { scripts: [], querySelectorAll: () => { throw new Error('BROWSER_FALLBACK_REQUIRED') } },
    window: {}, performance: { getEntriesByType: () => [] },
  }
  try {
    if (adapter.site === 'dsh-gemini') {
      const response = await request(adapter.home)
      if (!response.ok) return report
      const wiz = parseGeminiBootstrap(await response.text())
      globals.window.__WIZ_global_data = wiz
      globals.performance.getEntriesByType = () => wiz.FdrFJe
        ? [{ name: origin + '/?f.sid=' + encodeURIComponent(wiz.FdrFJe) }] : []
    }
    const identity = await execute(adapter.whoamiScript, globals)
    if (!identity.ok || !identity.identity || identity.identity !== browserIdentity) return report
    report.identity = true
    const listing = await execute(adapter.historyScript, globals, { since: new Date().toISOString() })
    if (!listing.ok || !Array.isArray(listing.rows) || listing.rows.some(row => row.partial)) return report
    report.list = true
    report.listCount = listing.rows.length
    if (!listing.rows.length) { report.detailSkipped = 'EMPTY_LIST'; return report }
    const detail = await execute(adapter.detailScript, globals, { id: listing.rows[0].id })
    report.detail = detail.ok === true && Array.isArray(detail.rows) && detail.rows.length > 0 && detail.rows.every(row => !row.partial)
    if (report.detail) report.turnCount = detail.rows.length
  } catch (error) {
    // Never print provider exceptions: they can contain account data or credentials.
    report.error = failureCode(error)
  }
  return report
}

async function main() {
  const [opencliRoot, ...selected] = process.argv.slice(2)
  if (!opencliRoot) throw new Error('Usage: node scripts/probe-web-chat-host.mjs <opencli-package-directory> [provider ...]')
  const targets = selected.length ? selected : providers
  if (targets.some(provider => !providers.includes(provider))) throw new Error('UNKNOWN_PROVIDER')
  const { Page } = await import(pathToFileURL(resolve(opencliRoot, 'dist/src/browser/page.js')).href)
  for (const provider of targets) {
    const page = new Page(`dsh-host-probe-${provider}`, 60, undefined, 'background')
    let stage = 'browser-connect'
    try {
      const adapter = await loadAdapter(provider)
      for (let attempt = 0; ; attempt++) {
        try { await page.goto(adapter.home, { settleMs: 800 }); break } catch (error) {
          if (failureCode(error) !== 'NAVIGATION_REJECTED' || attempt >= 2) throw error
          if (attempt === 1) {
            const pageId = await page.newTab(adapter.home)
            if (pageId) await page.setActivePage(pageId)
          }
        }
      }
      stage = 'browser-identity'
      const identity = JSON.parse(await page.evaluate(`(${adapter.whoamiScript})()`))
      if (!identity.ok || !identity.identity) {
        console.log(JSON.stringify({ provider, stage, status: 'BROWSER_AUTH_UNAVAILABLE' }))
        continue
      }
      stage = 'credential-capture'
      const credentials = await page.evaluate(`(() => ({ userAgent: navigator.userAgent, storage: {
        userToken: localStorage.getItem('userToken'), access_token: localStorage.getItem('access_token')
      }}))()`)
      credentials.cookies = await page.getCookies({ url: adapter.home })
      stage = 'host-probe'
      // Credentials remain in memory and never enter output or a persistent file.
      if (provider === 'deepseek' || provider === 'kimi') {
        console.log(JSON.stringify({ provider, ...await probeHost(adapter, credentials, identity.identity, true) }))
      }
      console.log(JSON.stringify({ provider, ...await probeHost(adapter, credentials, identity.identity) }))
    } catch (error) {
      console.log(JSON.stringify({ provider, stage, status: failureCode(error) }))
    } finally {
      await page.closeTab().catch(() => {})
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Probe could not start; check OpenCLI package path and provider names.'); process.exitCode = 1 })
}
