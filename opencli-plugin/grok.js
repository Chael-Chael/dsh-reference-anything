import { domFallbackScript, registerProvider } from './common.js'
// OpenCLI discovery marker: registerProvider below performs the cli() calls.

const historyScript = String.raw`async function () {
  const rows = []
  const seen = new Set()
  let token = ''
  try {
    for (let page = 0; page < 200; page++) {
      const url = '/rest/app-chat/conversations?pageSize=100' + (token ? '&pageToken=' + encodeURIComponent(token) : '')
      const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })
      if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
      if (response.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
      if (!response.ok) throw new Error('history HTTP ' + response.status)
      const payload = await response.json()
      const arrays = Object.values(payload || {}).filter(Array.isArray)
      for (const record of arrays.flat()) {
        if (!record || typeof record !== 'object') continue
        const id = String(record.conversationId || record.id || '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        rows.push({ provider: 'grok', accountScope: '', id,
          title: String(record.title || record.name || 'Untitled Grok chat'),
          url: location.origin + '/c/' + encodeURIComponent(id),
          createdAt: String(record.createTime || record.createdAt || record.created_at || ''),
          updatedAt: String(record.updateTime || record.updatedAt || record.updated_at || record.createTime || ''),
          messageCount: Number(record.messageCount || record.message_count || 0),
          cursor: String(payload.nextPageToken || ''), partial: false })
      }
      const next = String(payload.nextPageToken || '')
      if (!next) break
      if (next === token) throw new Error('repeated Grok cursor')
      token = next
    }
    return JSON.stringify({ ok: true, rows })
  } catch (error) {
    const links = Array.from(document.querySelectorAll('a[href*="/c/"]'))
    for (const link of links) {
      const match = link.href.match(/\/c\/([^/?#]+)/)
      if (!match || seen.has(match[1])) continue
      seen.add(match[1])
      rows.push({ provider: 'grok', accountScope: '', id: match[1],
        title: (link.textContent || '').trim() || 'Untitled Grok chat', url: link.href,
        createdAt: '', updatedAt: '', messageCount: 0, cursor: '', partial: true })
    }
    return JSON.stringify({ ok: rows.length > 0, rows, message: String(error && error.message || error) })
  }
}`

const detailScript = String.raw`async function (args) {
  try {
    const init = { credentials: 'include', headers: { Accept: 'application/json' } }
    const detailResponse = await fetch('/rest/app-chat/conversations_v2/' + encodeURIComponent(args.id), init)
    if (detailResponse.status === 401 || detailResponse.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
    if (detailResponse.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
    if (!detailResponse.ok) throw new Error('detail HTTP ' + detailResponse.status)
    const detailPayload = await detailResponse.json()
    const detail = detailPayload.conversation || detailPayload
    const nodeResponse = await fetch('/rest/app-chat/conversations/' + encodeURIComponent(args.id) + '/response-node', init)
    if (nodeResponse.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
    if (!nodeResponse.ok) throw new Error('response-node HTTP ' + nodeResponse.status)
    const nodesPayload = await nodeResponse.json()
    const nodes = Array.isArray(nodesPayload.responseNodes) ? nodesPayload.responseNodes : []
    const ids = Array.from(new Set(nodes.map(node => String(node.responseId || '')).filter(Boolean)))
    if (!ids.length) throw new Error('response-node returned no ids')
    const messagesResponse = await fetch('/rest/app-chat/conversations/' + encodeURIComponent(args.id) + '/load-responses', {
      ...init, method: 'POST', headers: { ...init.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ responseIds: ids }),
    })
    if (messagesResponse.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
    if (!messagesResponse.ok) throw new Error('load-responses HTTP ' + messagesResponse.status)
    const messagesPayload = await messagesResponse.json()
    const records = Array.isArray(messagesPayload.responses) ? messagesPayload.responses : []
    const byId = new Map(records.map(record => [String(record.responseId || ''), record]))
    const rows = []
    for (const responseId of ids) {
      const record = byId.get(responseId)
      if (!record) continue
      const sender = String(record.sender || '').toLowerCase()
      const role = /human|user/.test(sender) ? 'user' : /assistant|bot|grok/.test(sender) ? 'assistant' : null
      const text = String(record.message || '').replace(/<grok:render[^>]*>[\s\S]*?<\/grok:render>/gi, '').trim()
      if (!role || !text) continue
      const files = record.attachments || record.files || []
      const attachments = (Array.isArray(files) ? files : []).map((file, index) => {
        const candidate = String(file.url || file.downloadUrl || '')
        let locator = ''
        try { if (candidate) { const url = new URL(candidate, location.origin); if (url.origin === location.origin && url.pathname !== '/') locator = url.pathname + url.search } } catch {}
        const name = String(file.name || 'attachment')
        const mimeType = String(file.mimeType || file.mime_type || '')
        return { attachmentId: String(file.id || index), kind: mimeType.startsWith('image/') || /\.(?:gif|jpe?g|png|webp)$/i.test(name) ? 'image' : 'file', name,
          mimeType, size: Number(file.size || 0),
          locator, status: locator ? 'available' : 'unavailable' }
      })
      rows.push({ conversationId: args.id, ordinal: rows.length, messageId: responseId,
        parentId: String(record.parentResponseId || ''), branchId: String(record.branchId || ''), activeBranch: true,
        role, text, createdAt: String(record.createTime || ''), attachmentsJson: JSON.stringify(attachments), partial: false })
    }
    return JSON.stringify({ ok: rows.length > 0, rows, title: detail.title || '' })
  } catch (error) {
    return JSON.stringify({ ok: false, message: String(error && error.message || error) })
  }
}`

registerProvider({
  site: 'dsh-grok', provider: 'Grok', domain: 'grok.com', home: 'https://grok.com/',
  conversationUrl: id => `https://grok.com/c/${encodeURIComponent(id)}`,
  whoamiScript: String.raw`async function () {
    for (const url of ['/rest/app-chat/users/me', '/rest/auth/me']) {
      const response = await fetch(url, { credentials: 'include' }); if (!response.ok) continue
      const payload = await response.json(); const user = payload.user || payload
      const identity = String(user.id || user.userId || user.xUserId || user.email || '')
      if (identity) return JSON.stringify({ ok: true, identity })
    }
    return JSON.stringify({ ok: false, code: 'AUTH' })
  }`,
  historyScript, detailScript, fallbackScript: domFallbackScript,
})
