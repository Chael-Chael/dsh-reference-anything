import { domFallbackScript, registerProvider, sinceGuardSource } from './common.js'
// OpenCLI discovery marker: registerProvider below performs the cli() calls.

const historyScript = String.raw`async function (args) {
  const stopEarly = (${sinceGuardSource})(args && args.since)
  const fallback = () => Array.from(document.querySelectorAll('a[href*="/c/"]')).map((a, i) => {
    const match = a.href.match(/\/c\/([^/?#]+)/)
    return match ? { provider: 'chatgpt', accountScope: '', id: match[1], title: (a.innerText || a.textContent || 'Untitled').trim(), url: a.href, createdAt: '', updatedAt: '', messageCount: '', cursor: '', partial: true } : null
  }).filter(Boolean)
  try {
    const session = await fetch('/api/auth/session', { credentials: 'include' })
    if (session.status === 401 || session.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
    const sessionData = session.ok ? await session.json() : {}
    const token = sessionData.accessToken || sessionData.access_token || ''
    const headers = { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
    const rows = []
    for (let offset = 0, page = 0; page < 200; page++, offset += 100) {
      const response = await fetch('/backend-api/conversations?offset=' + offset + '&limit=100&order=updated', { credentials: 'include', headers })
      if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
      if (response.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
      if (!response.ok) throw new Error('history HTTP ' + response.status)
      const data = await response.json()
      const items = data.items || data.conversations || []
      const pageStart = rows.length
      for (const item of items) rows.push({
        provider: 'chatgpt', accountScope: '', id: String(item.id), title: item.title || 'Untitled Conversation',
        url: location.origin + '/c/' + item.id,
        createdAt: item.create_time ? new Date(item.create_time * 1000).toISOString() : '',
        updatedAt: item.update_time ? new Date(item.update_time * 1000).toISOString() : '',
        messageCount: item.message_count || item.messageCount || '', cursor: '', partial: false,
      })
      if (items.length < 100) return JSON.stringify({ ok: true, rows })
      if (stopEarly(rows.slice(pageStart))) return JSON.stringify({ ok: true, rows })
    }
    return JSON.stringify({ ok: false, message: 'pagination exceeded 200 pages' })
  } catch (error) {
    const rows = fallback()
    return JSON.stringify({ ok: rows.length > 0, rows, message: rows.length ? '' : String(error && error.message || error) })
  }
}`

const detailScript = String.raw`async function (args) {
  const attachment = (part, index) => {
    if (!part || typeof part !== 'object') return null
    const pointer = part.asset_pointer || part.file_id || part.id || ''
    const rawUrl = part.url || part.download_url || ''
    let locator = ''
    try { if (rawUrl) { const u = new URL(rawUrl, location.origin); if (u.origin === location.origin) locator = u.pathname } } catch {}
    if (!pointer && !locator) return null
    return { id: String(pointer || locator || index), type: part.content_type === 'image_asset_pointer' || /^image\//.test(part.mime_type || '') ? 'image' : 'file', name: part.name || part.file_name || '', mimeType: part.mime_type || '', size: part.size || null, locator, status: locator ? 'available' : 'metadata-only' }
  }
  const partsOf = (msg) => {
    const parts = Array.isArray(msg && msg.content && msg.content.parts) ? msg.content.parts : []
    const text = parts.filter(p => typeof p === 'string').join('\n').trim()
    const attachments = parts.map(attachment).filter(Boolean)
    return { text, attachments }
  }
  try {
    const session = await fetch('/api/auth/session', { credentials: 'include' })
    const sessionData = session.ok ? await session.json() : {}
    const token = sessionData.accessToken || sessionData.access_token || ''
    const response = await fetch('/backend-api/conversation/' + encodeURIComponent(args.id), { credentials: 'include', headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } })
    if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
    if (response.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
    if (!response.ok) return JSON.stringify({ ok: false, message: 'detail HTTP ' + response.status })
    const data = await response.json()
    const mapping = data.mapping && typeof data.mapping === 'object' ? data.mapping : {}
    const active = new Set()
    let cursor = data.current_node
    while (cursor && mapping[cursor] && !active.has(cursor)) { active.add(cursor); cursor = mapping[cursor].parent }
    const rows = []
    for (const [nodeId, node] of Object.entries(mapping)) {
      const msg = node && node.message
      const role = msg && msg.author && msg.author.role
      if (role !== 'user' && role !== 'assistant') continue
      const projected = partsOf(msg)
      if (!projected.text && projected.attachments.length === 0) continue
      rows.push({
        conversationId: args.id, ordinal: 0, messageId: msg.id || nodeId,
        parentId: node.parent || '', branchId: nodeId, activeBranch: active.has(nodeId),
        role, text: projected.text,
        createdAt: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : '',
        attachmentsJson: JSON.stringify(projected.attachments), partial: false,
      })
    }
    const ordered = []
    let nodeId = data.current_node
    while (nodeId && mapping[nodeId]) { ordered.unshift(nodeId); nodeId = mapping[nodeId].parent }
    const position = new Map(ordered.map((id, index) => [id, index]))
    rows.sort((a, b) => (position.get(a.branchId) ?? 100000) - (position.get(b.branchId) ?? 100000))
    rows.forEach((row, index) => { row.ordinal = index })
    return JSON.stringify({ ok: rows.length > 0, rows, message: rows.length ? '' : 'mapping contained no messages' })
  } catch (error) {
    return JSON.stringify({ ok: false, message: String(error && error.message || error) })
  }
}`

registerProvider({
  site: 'dsh-chatgpt', provider: 'ChatGPT', domain: 'chatgpt.com', home: 'https://chatgpt.com/',
  conversationUrl: id => `https://chatgpt.com/c/${encodeURIComponent(id)}`,
  whoamiScript: String.raw`async function () {
    const response = await fetch('/api/auth/session', { credentials: 'include' })
    if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
    if (!response.ok) return JSON.stringify({ ok: false, message: 'session HTTP ' + response.status })
    const payload = await response.json(); const user = payload.user || payload.account || {}
    const identity = String(user.id || user.account_id || user.email || '')
    return JSON.stringify({ ok: Boolean(identity), identity, code: identity ? undefined : 'AUTH' })
  }`,
  historyScript, detailScript, fallbackScript: domFallbackScript,
})
