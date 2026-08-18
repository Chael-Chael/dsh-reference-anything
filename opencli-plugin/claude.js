import { domFallbackScript, registerProvider, sinceGuardSource } from './common.js'
// OpenCLI discovery marker: registerProvider below performs the cli() calls.

const shared = String.raw`
  const organization = async () => {
    const response = await fetch('/api/organizations', { credentials: 'include' })
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('login required'), { code: 'AUTH' })
    if (!response.ok) throw new Error('organizations HTTP ' + response.status)
    const payload = await response.json()
    const organizations = Array.isArray(payload) ? payload : payload.organizations || []
    const item = organizations.find(value => value && (value.uuid || value.id))
    if (!item) throw Object.assign(new Error('no Claude organization'), { code: 'AUTH' })
    return String(item.uuid || item.id)
  }
`

const historyScript = String.raw`async function (args) {
  ${shared}
  const stopEarly = (${sinceGuardSource})(args && args.since)
  const rows = []
  try {
    const org = await organization()
    let offset = 0
    for (let page = 0; page < 500; page++) {
      const response = await fetch('/api/organizations/' + encodeURIComponent(org) + '/chat_conversations?limit=100&offset=' + offset, { credentials: 'include' })
      if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
      if (response.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
      if (!response.ok) throw new Error('history HTTP ' + response.status)
      const payload = await response.json()
      const items = Array.isArray(payload) ? payload : payload.items || payload.chat_conversations || []
      const pageStart = rows.length
      for (const item of items) {
        const id = String(item.uuid || item.id || '')
        if (!id) continue
        rows.push({ provider: 'claude', accountScope: '', id,
          title: String(item.name || item.title || 'Untitled Claude chat'),
          url: location.origin + '/chat/' + encodeURIComponent(id),
          createdAt: String(item.created_at || item.createdAt || ''),
          updatedAt: String(item.updated_at || item.updatedAt || item.created_at || ''),
          messageCount: Number(item.message_count || item.messageCount || 0),
          cursor: String(offset + items.length), partial: false })
      }
      if (items.length < 100) break
      if (stopEarly(rows.slice(pageStart))) break
      offset += items.length
    }
    return JSON.stringify({ ok: true, rows })
  } catch (error) {
    if (error && error.code === 'AUTH') return JSON.stringify({ ok: false, code: 'AUTH' })
    const links = Array.from(document.querySelectorAll('a[href*="/chat/"]'))
    const seen = new Set()
    for (const link of links) {
      const match = link.href.match(/\/chat\/([^/?#]+)/)
      if (!match || seen.has(match[1])) continue
      seen.add(match[1])
      rows.push({ provider: 'claude', accountScope: '', id: match[1],
        title: (link.textContent || '').trim() || 'Untitled Claude chat', url: link.href,
        createdAt: '', updatedAt: '', messageCount: 0, cursor: '', partial: true })
    }
    return JSON.stringify({ ok: rows.length > 0, rows, message: String(error && error.message || error) })
  }
}`

const detailScript = String.raw`async function (args) {
  ${shared}
  const textOf = value => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(textOf).filter(Boolean).join('\n')
    : value && typeof value === 'object' ? textOf(value.text || value.content || value.value || value.markdown || '') : ''
  try {
    const org = await organization()
    const url = '/api/organizations/' + encodeURIComponent(org) + '/chat_conversations/' + encodeURIComponent(args.id)
      + '?tree=True&rendering_mode=messages&render_all_tools=true'
    const response = await fetch(url, { credentials: 'include' })
    if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
    if (response.status === 429) return JSON.stringify({ ok: false, code: 'RATE_LIMIT' })
    if (!response.ok) throw new Error('detail HTTP ' + response.status)
    const payload = await response.json()
    const messages = payload.chat_messages || payload.messages || (payload.conversation && payload.conversation.chat_messages) || []
    const byId = new Map(messages.map(message => [String(message.uuid || message.id || ''), message]))
    const childIds = new Set(messages.map(message => String(message.parent_message_uuid || message.parent_uuid || message.parent_id || '')).filter(Boolean))
    const requestedLeaf = String(payload.current_leaf_message_uuid || payload.current_message_uuid || payload.current_node_uuid || '')
    let leaf = requestedLeaf && byId.has(requestedLeaf) ? requestedLeaf : ''
    if (!leaf) {
      const leaves = messages.filter(message => !childIds.has(String(message.uuid || message.id || '')))
      leaf = String((leaves[leaves.length - 1] || {}).uuid || (leaves[leaves.length - 1] || {}).id || '')
    }
    const active = new Set()
    for (let id = leaf, guard = 0; id && guard++ < messages.length + 1;) {
      active.add(id)
      const message = byId.get(id)
      id = message ? String(message.parent_message_uuid || message.parent_uuid || message.parent_id || '') : ''
    }
    const ordered = messages.slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    const rows = ordered.map((message, ordinal) => {
      const id = String(message.uuid || message.id || ordinal)
      const sender = String(message.sender || message.role || '').toLowerCase()
      const content = message.content || message.text || message.content_blocks || ''
      const attachments = (message.attachments || message.files || []).map((file, index) => {
        const candidate = String(file.download_url || file.url || '')
        let locator = ''
        try { if (candidate) { const url = new URL(candidate, location.origin); if (url.origin === location.origin && url.pathname !== '/') locator = url.pathname + url.search } } catch {}
        const name = String(file.name || file.file_name || 'attachment')
        const mimeType = String(file.mime_type || file.mimeType || '')
        return { attachmentId: String(file.id || file.uuid || index), name: String(file.name || file.file_name || 'attachment'),
          kind: mimeType.startsWith('image/') || /\.(?:gif|jpe?g|png|webp)$/i.test(name) ? 'image' : 'file',
          mimeType, size: Number(file.size || 0),
          locator, status: locator ? 'available' : 'unavailable' }
      })
      return { conversationId: args.id, ordinal, messageId: id,
        parentId: String(message.parent_message_uuid || message.parent_uuid || message.parent_id || ''),
        branchId: String(message.branch_uuid || ''), activeBranch: active.size ? active.has(id) : true,
        role: /assistant|claude|model/.test(sender) ? 'assistant' : 'user', text: textOf(content),
        createdAt: String(message.created_at || message.createdAt || ''), attachmentsJson: JSON.stringify(attachments), partial: false }
    }).filter(row => row.text || row.attachmentsJson !== '[]')
    return JSON.stringify({ ok: rows.length > 0, rows })
  } catch (error) {
    if (error && error.code === 'AUTH') return JSON.stringify({ ok: false, code: 'AUTH' })
    return JSON.stringify({ ok: false, message: String(error && error.message || error) })
  }
}`

registerProvider({
  site: 'dsh-claude', provider: 'Claude', domain: 'claude.ai', home: 'https://claude.ai/',
  conversationUrl: id => `https://claude.ai/chat/${encodeURIComponent(id)}`,
  whoamiScript: String.raw`async function () {
    const response = await fetch('/api/organizations', { credentials: 'include' })
    if (response.status === 401 || response.status === 403) return JSON.stringify({ ok: false, code: 'AUTH' })
    if (!response.ok) return JSON.stringify({ ok: false, message: 'organizations HTTP ' + response.status })
    const payload = await response.json(); const values = Array.isArray(payload) ? payload : payload.organizations || []
    const item = values.find(value => value && (value.uuid || value.id)); const identity = String(item && (item.uuid || item.id) || '')
    return JSON.stringify({ ok: Boolean(identity), identity, code: identity ? undefined : 'AUTH' })
  }`,
  historyScript, detailScript, fallbackScript: domFallbackScript,
})
