import { domFallbackScript, registerProvider, sinceGuardSource } from './common.js'
// OpenCLI discovery marker: registerProvider below performs the cli() calls.

const authHeaders = String.raw`() => {
  const token = localStorage.getItem('access_token') || ''
  return { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
}`

const historyScript = String.raw`async function (args) {
  const stopEarly = (${sinceGuardSource})(args && args.since)
  const headers = (${authHeaders})()
  const rows = []
  const toDate = value => {
    const numeric = Number(value)
    return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric < 1e12 ? numeric * 1000 : numeric).toISOString() : String(value || '')
  }
  try {
    for (let offset = 0, page = 0; page < 500; page++, offset += 100) {
      const response = await fetch('/api/chat/list', { method: 'POST', credentials: 'include', headers,
        body: JSON.stringify({ offset, size: 100 }) })
      if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
      if (response.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
      if (!response.ok) throw new Error('history HTTP ' + response.status)
      const payload = await response.json()
      const items = payload.items || payload.chats || payload.data && (payload.data.items || payload.data.chats) || []
      const pageStart = rows.length
      for (const item of items) {
        const id = String(item.id || item.chat_id || '')
        if (!id) continue
        rows.push({ provider: 'kimi', accountScope: '', id,
          title: String(item.name || item.title || 'Untitled Kimi chat'),
          url: location.origin + '/chat/' + encodeURIComponent(id),
          createdAt: toDate(item.created_at || item.createdAt || item.created),
          updatedAt: toDate(item.updated_at || item.updatedAt || item.last_updated_at || item.created_at),
          messageCount: Number(item.message_count || item.messageCount || item.messages_count || 0),
          cursor: String(item.updated_at || item.updatedAt || ''), partial: false })
      }
      if (items.length < 100 || stopEarly(rows.slice(pageStart))) break
    }
    return JSON.stringify({ ok: true, rows })
  } catch (error) {
    const seen = new Set()
    for (const link of document.querySelectorAll('a[href*="/chat/"]')) {
      const match = link.href.match(/\/chat\/([0-9a-f-]{8,})/i)
      if (!match || seen.has(match[1])) continue
      seen.add(match[1]); rows.push({ provider: 'kimi', accountScope: '', id: match[1],
        title: (link.textContent || '').trim() || 'Untitled Kimi chat', url: link.href,
        createdAt: '', updatedAt: '', messageCount: 0, cursor: '', partial: true })
    }
    return JSON.stringify({ ok: rows.length > 0, rows, message: rows.length ? '' : String(error && error.message || error) })
  }
}`

export const detailScript = String.raw`async function (args) {
  const headers = (${authHeaders})()
  const textOf = value => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(textOf).filter(Boolean).join('\n')
    : value && typeof value === 'object' ? textOf(value.text || value.content || value.value || value.output || '') : ''
  const attachmentOf = (file, index) => {
    if (!file || typeof file !== 'object') return null
    const candidate = String(file.download_url || file.url || file.path || '')
    let locator = ''
    try { if (candidate) { const url = new URL(candidate, location.origin); if (url.origin === location.origin && url.pathname !== '/') locator = url.pathname + url.search } } catch {}
    const name = String(file.name || file.file_name || 'attachment')
    const mimeType = String(file.mime_type || file.mimeType || file.content_type || '')
    return { attachmentId: String(file.id || file.file_id || index),
      kind: mimeType.startsWith('image/') || /\.(?:gif|jpe?g|png|webp)$/i.test(name) ? 'image' : 'file',
      name, mimeType, size: Number(file.size || file.file_size || 0), locator,
      status: locator ? 'available' : 'unavailable' }
  }
  try {
    const messages = []
    let pageToken = ''
    for (let page = 0; page < 500; page++) {
      let response = await fetch('/apiv2/kimi.chat.v1.ChatService/ListMessages', { method: 'POST', credentials: 'include', headers,
        body: JSON.stringify({ chat_id: args.id, ...(pageToken ? { pageToken } : {}) }) })
      if ((response.status === 404 || response.status === 405) && page === 0) {
        response = await fetch('/api/chat/' + encodeURIComponent(args.id) + '/messages', { credentials: 'include', headers })
      }
      if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
      if (response.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
      if (!response.ok) throw new Error('detail HTTP ' + response.status)
      const payload = await response.json()
      const items = payload.messages || payload.items || payload.data && (payload.data.messages || payload.data.items) || []
      messages.push(...items)
      const next = String(payload.nextPageToken || payload.next_page_token || payload.data && (payload.data.nextPageToken || payload.data.next_page_token) || '')
      if (!next || next === pageToken || items.length === 0) break
      pageToken = next
    }
    // Kimi lists newest messages first. The local mirror and every other
    // adapter use chronological ordinals, so reverse only after all pages land.
    messages.reverse()
    const rows = messages.map((message, ordinal) => {
      const roleRaw = String(message.role || message.sender || message.message_role || message.type || '').toLowerCase()
      const role = /assistant|bot|model|kimi/.test(roleRaw) ? 'assistant' : 'user'
      const files = message.attachments || message.files || message.file_infos || []
      const attachments = (Array.isArray(files) ? files : []).map(attachmentOf).filter(Boolean)
      return { conversationId: args.id, ordinal,
        messageId: String(message.id || message.message_id || ordinal),
        parentId: String(message.parent_id || message.parentId || ''), branchId: '', activeBranch: true,
        role, text: textOf(message.blocks || message.contents || message.content || message.text || message.fragments || ''),
        createdAt: String(message.created_at || message.createdAt || message.timestamp || ''),
        attachmentsJson: JSON.stringify(attachments), partial: false }
    }).filter(row => row.text || row.attachmentsJson !== '[]')
    return JSON.stringify({ ok: rows.length > 0, rows, message: rows.length ? '' : 'response contained no messages' })
  } catch (error) {
    return JSON.stringify({ ok: false, message: String(error && error.message || error) })
  }
}`

registerProvider({
  site: 'dsh-kimi', provider: 'Kimi', domain: 'kimi.com', home: 'https://www.kimi.com/',
  conversationUrl: id => `https://www.kimi.com/chat/${encodeURIComponent(id)}`,
  whoamiScript: String.raw`async function () {
    const headers = (${authHeaders})()
    const response = await fetch('/api/user', { credentials: 'include', headers })
    if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
    if (!response.ok) return JSON.stringify({ ok: false, message: 'user HTTP ' + response.status })
    const user = await response.json(); const identity = String(user.id || user.user_id || user.email || '')
    return JSON.stringify({ ok: Boolean(identity), identity, code: identity ? undefined : 'AUTH' })
  }`,
  historyScript, detailScript, fallbackScript: domFallbackScript,
})
