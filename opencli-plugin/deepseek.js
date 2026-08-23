import { domFallbackScript, registerProvider, sinceGuardSource } from './common.js'
// OpenCLI discovery marker: registerProvider below performs the cli() calls.

const historyScript = String.raw`async function (args) {
  const stopEarly = (${sinceGuardSource})(args && args.since)
  const normalize = value => Array.isArray(value) ? value : []
  const headers = (() => {
    try {
      const stored = JSON.parse(localStorage.getItem('userToken') || 'null')
      const token = typeof stored === 'string' ? stored : stored && (stored.value || stored.token)
      return token ? { Accept: 'application/json', Authorization: 'Bearer ' + token } : { Accept: 'application/json' }
    } catch { return { Accept: 'application/json' } }
  })()
  const toDate = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString()
    return String(value || '')
  }
  const rows = []
  let cursorPinned = false
  let cursorUpdatedAt = ''
  let guard = 0
  try {
    do {
      const query = new URLSearchParams({ count: '100', 'lte_cursor.pinned': String(cursorPinned) })
      if (cursorUpdatedAt) query.set('lte_cursor.updated_at', cursorUpdatedAt)
      const response = await fetch('/api/v0/chat_session/fetch_page?' + query, { credentials: 'include', headers })
      if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
      if (response.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
      if (!response.ok) throw new Error('history HTTP ' + response.status)
      const payload = await response.json()
      if (payload && (payload.code === 40002 || /missing token|unauth/i.test(String(payload.msg || payload.message || '')))) {
        return JSON.stringify({ ok: false, code: 'AUTH' })
      }
      const data = payload.data && payload.data.biz_data || payload.biz_data || payload.data || payload
      const items = normalize(data.chat_sessions || data.sessions || data.items || data.conversations)
      const pageStart = rows.length
      for (const item of items) {
        const id = String(item.id || item.chat_session_id || item.uuid || '')
        if (!id) continue
        rows.push({
          provider: 'deepseek', accountScope: '', id,
          title: String(item.title || item.name || 'Untitled DeepSeek chat'),
          url: location.origin + '/a/chat/s/' + encodeURIComponent(id),
          createdAt: toDate(item.inserted_at || item.created_at || item.createdAt || ''),
          updatedAt: toDate(item.updated_at || item.updatedAt || item.inserted_at || item.created_at || ''),
          messageCount: Number(item.message_count || item.messageCount || 0),
          cursor: String(item.updated_at || item.updatedAt || ''), partial: false,
        })
      }
      const last = items[items.length - 1]
      const nextUpdatedAt = String(last && (last.updated_at || last.updatedAt) || '')
      const nextPinned = Boolean(last && last.pinned)
      if (!data.has_more || !nextUpdatedAt || (nextUpdatedAt === cursorUpdatedAt && nextPinned === cursorPinned)) break
      if (stopEarly(rows.slice(pageStart))) break
      cursorUpdatedAt = nextUpdatedAt
      cursorPinned = nextPinned
    } while (++guard < 500)
    return JSON.stringify({ ok: true, rows })
  } catch (error) {
    const links = Array.from(document.querySelectorAll('a[href*="/a/chat/s/"]'))
    const seen = new Set()
    for (const link of links) {
      const match = link.href.match(/\/a\/chat\/s\/([^/?#]+)/)
      if (!match || seen.has(match[1])) continue
      seen.add(match[1])
      rows.push({ provider: 'deepseek', accountScope: '', id: match[1],
        title: (link.textContent || '').trim() || 'Untitled DeepSeek chat', url: link.href,
        createdAt: '', updatedAt: '', messageCount: 0, cursor: '', partial: true })
    }
    return JSON.stringify({ ok: rows.length > 0, rows, message: String(error && error.message || error) })
  }
}`

const detailScript = String.raw`async function (args) {
  const headers = (() => {
    try {
      const stored = JSON.parse(localStorage.getItem('userToken') || 'null')
      const token = typeof stored === 'string' ? stored : stored && (stored.value || stored.token)
      return token ? { Accept: 'application/json', Authorization: 'Bearer ' + token } : { Accept: 'application/json' }
    } catch { return { Accept: 'application/json' } }
  })()
  const toText = value => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(toText).filter(Boolean).join('\n')
    : value && typeof value === 'object' ? toText(value.text || value.content || value.value || '') : ''
  try {
    const response = await fetch('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(args.id), { credentials: 'include', headers })
    if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
    if (response.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
    if (!response.ok) throw new Error('detail HTTP ' + response.status)
    const payload = await response.json()
    if (payload && (payload.code === 40002 || /missing token|unauth/i.test(String(payload.msg || payload.message || '')))) {
      return JSON.stringify({ ok: false, code: 'AUTH' })
    }
    const data = payload.data && payload.data.biz_data || payload.biz_data || payload.data || payload
    const messages = data.chat_messages || data.messages || data.items || []
    const rows = messages.map((message, ordinal) => {
      const roleRaw = String(message.role || message.message_role || message.sender || '').toLowerCase()
      const role = /assistant|bot|model/.test(roleRaw) ? 'assistant' : 'user'
      const files = message.attachments || message.files || message.file_infos || []
      const attachments = (Array.isArray(files) ? files : []).map((file, index) => {
        const candidate = String(file.download_url || file.url || file.path || '')
        let locator = ''
        try { if (candidate) { const url = new URL(candidate, location.origin); if (url.origin === location.origin && url.pathname !== '/') locator = url.pathname + url.search } } catch {}
        const name = String(file.name || file.file_name || 'attachment')
        const mimeType = String(file.mime_type || file.mimeType || '')
        return { attachmentId: String(file.id || file.file_id || index),
          kind: mimeType.startsWith('image/') || /\.(?:gif|jpe?g|png|webp)$/i.test(name) ? 'image' : 'file',
          name, mimeType,
          size: Number(file.size || file.file_size || 0), locator, status: locator ? 'available' : 'unavailable' }
      })
      return { conversationId: args.id, ordinal,
        messageId: String(message.id || message.message_id || ordinal),
        parentId: String(message.parent_id || message.parentId || ''), branchId: '', activeBranch: true,
        role, text: toText(message.content || message.text || message.fragments || ''),
        createdAt: String(message.created_at || message.createdAt || ''),
        attachmentsJson: JSON.stringify(attachments), partial: false }
    }).filter(row => row.text || row.attachmentsJson !== '[]')
    return JSON.stringify({ ok: rows.length > 0, rows })
  } catch (error) {
    return JSON.stringify({ ok: false, message: String(error && error.message || error) })
  }
}`

export const whoamiScript = String.raw`async function () {
    const headers = (() => {
      try {
        const stored = JSON.parse(localStorage.getItem('userToken') || 'null')
        const token = typeof stored === 'string' ? stored : stored && (stored.value || stored.token)
        return token ? { Accept: 'application/json', Authorization: 'Bearer ' + token } : { Accept: 'application/json' }
      } catch { return { Accept: 'application/json' } }
    })()
    for (const url of ['/api/v0/users/current', '/api/v0/user/profile']) {
      const response = await fetch(url, { credentials: 'include', headers })
      if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
      if (response.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
      if (!response.ok) continue
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) continue
      const payload = await response.json()
      if (payload && (payload.code === 40002 || /missing token|unauth/i.test(String(payload.msg || payload.message || '')))) {
        return JSON.stringify({ ok: false, code: 'AUTH' })
      }
      const user = payload.data && payload.data.biz_data || payload.biz_data || payload.data || payload
      const identity = String(user.id || user.user_id || user.uuid || user.email || '')
      if (identity) return JSON.stringify({ ok: true, identity })
    }
    return JSON.stringify({ ok: false, code: 'AUTH' })
  }`

registerProvider({
  site: 'dsh-deepseek', provider: 'DeepSeek', domain: 'chat.deepseek.com',
  home: 'https://chat.deepseek.com/', conversationUrl: id => `https://chat.deepseek.com/a/chat/s/${encodeURIComponent(id)}`,
  whoamiScript,
  historyScript, detailScript, fallbackScript: domFallbackScript,
})
