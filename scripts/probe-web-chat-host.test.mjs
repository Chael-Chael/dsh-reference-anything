import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cookieHeader, hostFetch, loadAdapter, parseGeminiBootstrap, probeHost, providers } from './probe-web-chat-host.mjs'

test('all six shipped adapters load without OpenCLI or browser fallbacks', async () => {
  for (const provider of providers) {
    const adapter = await loadAdapter(provider)
    assert.equal(adapter.site, `dsh-${provider}`)
    for (const key of ['whoamiScript', 'historyScript', 'detailScript']) assert.equal(typeof adapter[key], 'string')
  }
  await assert.rejects(loadAdapter('../secret'), /UNKNOWN_PROVIDER/)
})

test('cookies respect domains, paths, expiry and header boundaries', () => {
  const base = { name: 'session', value: 'secret', domain: '.example.com', path: '/api', secure: true }
  assert.equal(cookieHeader([base], new URL('https://sub.example.com/api/list')), 'session=secret')
  for (const url of ['https://evil-example.com/api', 'https://example.com/apix', 'http://example.com/api']) {
    assert.equal(cookieHeader([base], new URL(url)), '')
  }
  const url = new URL('https://sub.example.com/api')
  for (const changes of [{ expirationDate: 1 }, { expires: 1 }, { hostOnly: true }, { value: 'x\r\nInjected: yes' }]) {
    assert.equal(cookieHeader([{ ...base, ...changes }], url), '')
  }
})

test('Host transport rejects other origins and disables redirects before sending secrets', async () => {
  let calls = 0
  const requests = []
  const request = hostFetch('https://example.com', [], '', requests, async (_url, init) => {
    calls++
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.get('cookie'), null)
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  })
  await assert.rejects(request('https://other.com'), /ORIGIN_REJECTED/)
  await assert.rejects(request('https://user:secret@example.com'), /ORIGIN_REJECTED/)
  assert.equal(calls, 0)
  await request('/api', { headers: { cookie: 'unscoped=secret' } })
  assert.deepEqual(requests, [{ status: 200, json: true }])
})

test('Gemini bootstrap parses JSON strings without executing returned scripts', () => {
  assert.deepEqual(parseGeminiBootstrap('<script>throw 1; {"SNlM0e":"a\\u003db","oPEP7c":"user","FdrFJe":"sid"}</script>'), {
    SNlM0e: 'a=b', oPEP7c: 'user', FdrFJe: 'sid',
  })
})

test('DeepSeek token-only probe validates identity, stops after one page, and redacts output', async () => {
  const adapter = await loadAdapter('deepseek')
  const credentials = { storage: { userToken: JSON.stringify({ value: 'TOP_SECRET' }) }, cookies: [], userAgent: '' }
  const paths = []
  const fetch = async (url, init) => {
    paths.push(url.pathname)
    assert.equal(init.headers.get('authorization'), 'Bearer TOP_SECRET')
    assert.equal(init.headers.get('cookie'), null)
    const data = url.pathname.endsWith('/current') ? { id: 'ACCOUNT' }
      : url.pathname.endsWith('/fetch_page') ? { has_more: true, chat_sessions: [{ id: 'CHAT', title: 'PRIVATE_TITLE', updated_at: 1700000000 }] }
        : { chat_messages: [{ id: 'MSG', role: 'user', content: 'PRIVATE_BODY' }] }
    return Response.json({ data: { biz_data: data } })
  }
  const result = await probeHost(adapter, credentials, 'ACCOUNT', true, fetch)
  assert.equal(result.identity, true)
  assert.equal(result.list, true)
  assert.equal(result.detail, true)
  assert.equal(paths.length, 3)
  assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET|ACCOUNT|PRIVATE_TITLE|PRIVATE_BODY|CHAT/)
  paths.length = 0
  const mismatch = await probeHost(adapter, credentials, 'OTHER_ACCOUNT', true, fetch)
  assert.equal(mismatch.identity, false)
  assert.equal(paths.length, 1)
})

test('HTML challenge and network exceptions cannot leak raw output or count as success', async () => {
  const adapter = await loadAdapter('deepseek')
  const credentials = { storage: {}, cookies: [], userAgent: '' }
  for (const fetch of [async () => new Response('<html>secret</html>', { status: 403 }), async () => { throw new Error('SECRET') }]) {
    const result = await probeHost(adapter, credentials, 'ACCOUNT', false, fetch)
    assert.equal(result.identity, false)
    assert.equal(result.detail, false)
    assert.doesNotMatch(JSON.stringify(result), /secret|SECRET/)
  }
})
