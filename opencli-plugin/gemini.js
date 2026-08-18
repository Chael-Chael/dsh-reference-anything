import { domFallbackScript, registerProvider, sinceGuardSource } from './common.js'
// OpenCLI discovery marker: registerProvider below performs the cli() calls.

const helpers = String.raw`
  const auth = () => {
    const wiz = window.__WIZ_global_data || window.WIZ_global_data || {}
    if (wiz.SNlM0e) return String(wiz.SNlM0e)
    for (const script of document.scripts) {
      const match = (script.textContent || '').match(/"SNlM0e"\s*:\s*"([^"]+)"/)
      if (match) return match[1]
    }
    return ''
  }
  const sid = () => {
    const entries = performance.getEntriesByType('resource') || []
    for (let index = entries.length - 1; index >= 0; index--) {
      try {
        const value = new URL(entries[index].name).searchParams.get('f.sid')
        if (value) return value
      } catch {}
    }
    return ''
  }
  const rpc = async (id, sourcePath, args) => {
    const token = auth()
    if (!token) return { code: 'AUTH' }
    const query = new URLSearchParams({ rpcids: id, 'source-path': sourcePath,
      'f.sid': sid(), _reqid: String(Math.floor(Math.random() * 100000)), rt: 'c' })
    const body = new URLSearchParams({ 'f.req': JSON.stringify([[[id, JSON.stringify(args), null, 'generic']]]), at: token })
    const response = await fetch('/_/BardChatUi/data/batchexecute?' + query, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' }, body,
    })
    if (response.status === 401 || response.status === 403) return { code: 'AUTH' }
    if (response.status === 429) return { code: 'RATE_LIMIT' }
    if (!response.ok) return { error: 'batchexecute HTTP ' + response.status }
    const text = await response.text()
    for (const line of text.split('\n')) {
      const at = line.indexOf('[[')
      if (at < 0) continue
      try {
        const outer = JSON.parse(line.slice(at))
        for (const entry of outer) if (Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === id && typeof entry[2] === 'string') return { payload: JSON.parse(entry[2]) }
      } catch {}
    }
    return { error: 'batchexecute returned no typed payload' }
  }
`

const historyScript = String.raw`async function (args) {
  ${helpers}
  const stopEarly = (${sinceGuardSource})(args && args.since)
  const rows = []
  const byId = new Map()
  let complete = true
  try {
    for (const mode of [1, 0]) {
      let cursor = null
      const seen = new Set()
      for (let page = 0; page < 200; page++) {
        const result = await rpc('MaZiqc', '/app', [100, cursor, [mode, null, 1]])
        if (result.code) return JSON.stringify({ ok: false, code: result.code })
        if (!Array.isArray(result.payload)) { complete = false; break }
        const pageRows = []
        const walk = value => {
          if (!Array.isArray(value)) return
          if (typeof value[0] === 'string' && /^c_[A-Za-z0-9_-]+$/.test(value[0]) && typeof (value[1] || value[2]) === 'string') {
            const id = value[0].slice(2)
            if (!byId.has(id)) {
              const row = { provider: 'gemini', accountScope: '', id,
                title: String(value[1] || value[2]), url: location.origin + '/app/' + encodeURIComponent(id),
                createdAt: '', updatedAt: String(value[5] || ''), messageCount: 0, cursor: '', partial: false }
              byId.set(id, row)
              pageRows.push(row)
            }
          }
          for (const child of value) walk(child)
        }
        walk(result.payload)
        const nested = Array.isArray(result.payload[0]) ? result.payload[0] : []
        const next = typeof result.payload[1] === 'string' ? result.payload[1] : typeof nested[1] === 'string' ? nested[1] : ''
        if (!next) break
        if (stopEarly(pageRows)) break
        if (seen.has(next)) { complete = false; break }
        seen.add(next); cursor = next
      }
    }
    rows.push(...byId.values())
    return JSON.stringify({ ok: true, rows: rows.map(row => ({ ...row, partial: !complete })) })
  } catch (error) {
    const links = Array.from(document.querySelectorAll('a[href*="/app/"]'))
    for (const link of links) {
      const match = link.href.match(/\/app\/([A-Za-z0-9_-]+)/)
      if (!match || byId.has(match[1])) continue
      byId.set(match[1], true)
      rows.push({ provider: 'gemini', accountScope: '', id: match[1], title: (link.textContent || '').trim() || 'Untitled Gemini chat',
        url: link.href, createdAt: '', updatedAt: '', messageCount: 0, cursor: '', partial: true })
    }
    return JSON.stringify({ ok: rows.length > 0, rows, message: String(error && error.message || error) })
  }
}`

const detailScript = String.raw`async function (args) {
  ${helpers}
  try {
    const id = String(args.id).replace(/^c_/, '')
    const result = await rpc('hNvQHb', '/app/' + id, ['c_' + id, 1000, null, 1, [1], [4], null, 1])
    if (result.code) return JSON.stringify({ ok: false, code: result.code })
    const turns = result.payload && result.payload[0]
    if (!Array.isArray(turns)) return JSON.stringify({ ok: false, message: result.error || 'Gemini detail payload missing turns' })
    const rows = []
    for (const turn of turns.slice().reverse()) {
      if (!Array.isArray(turn)) continue
      const stamp = turn && turn[4] && turn[4][0]
      const createdAt = typeof stamp === 'number' ? String(stamp * 1000) : ''
      const responseId = turn && turn[0] && typeof turn[0][1] === 'string' ? turn[0][1] : String(rows.length)
      const user = turn && turn[2] && turn[2][0] && turn[2][0][0]
      const assistant = turn && turn[3] && turn[3][0] && turn[3][0][0] && turn[3][0][0][1] && turn[3][0][0][1][0]
      if (typeof user === 'string' && user.trim()) rows.push({ conversationId: id, ordinal: rows.length,
        messageId: responseId + '-user', parentId: '', branchId: responseId, activeBranch: true,
        role: 'user', text: user.trim(), createdAt, attachmentsJson: '[]', partial: false })
      if (typeof assistant === 'string' && assistant.trim()) rows.push({ conversationId: id, ordinal: rows.length,
        messageId: responseId, parentId: responseId + '-user', branchId: responseId, activeBranch: true,
        role: 'assistant', text: assistant.trim(), createdAt, attachmentsJson: '[]', partial: false })
    }
    return JSON.stringify({ ok: rows.length > 0, rows })
  } catch (error) {
    return JSON.stringify({ ok: false, message: String(error && error.message || error) })
  }
}`

registerProvider({
  site: 'dsh-gemini', provider: 'Gemini', domain: 'gemini.google.com', home: 'https://gemini.google.com/app',
  conversationUrl: id => `https://gemini.google.com/app/${encodeURIComponent(id)}`,
  whoamiScript: String.raw`async function () {
    const match = location.pathname.match(/\/u\/(\d+)(?:\/|$)/); const slot = match ? match[1] : 'default'
    const wiz = window.__WIZ_global_data || window.WIZ_global_data || {}; const identity = String(wiz.oPEP7c || wiz.CfO9Re || slot)
    return JSON.stringify({ ok: Boolean(identity), identity })
  }`,
  historyScript, detailScript, fallbackScript: domFallbackScript,
})
