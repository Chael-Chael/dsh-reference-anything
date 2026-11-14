import { createHash } from 'node:crypto'
import { OpenCliError } from './opencli.ts'

export type NewWebProvider = 'qwen' | 'qianwen' | 'doubao'
export const newWebHomes = { qwen: 'https://chat.qwen.ai/', qianwen: 'https://www.qianwen.com/', doubao: 'https://www.doubao.com/chat/' }
export const credentialEndpoints = {
  qianwen: {
    identity: 'https://api.qianwen.com/growth/user/benefit/user/member/info',
    list: 'https://chat2-api.qianwen.com/api/v2/session/page/list',
    detail: 'https://chat2-api.qianwen.com/api/v1/session/msg/list',
  },
  doubao: {
    identity: 'https://www.doubao.com/im/chain/recent_conv',
    list: 'https://www.doubao.com/im/chain/recent_conv',
    detail: 'https://www.doubao.com/im/chain/single',
  },
} as const
export interface RequestTemplate { url: string; method: string; headers: Record<string, string>; body?: string }
export interface CapturedWebCredential { identity: RequestTemplate; list: RequestTemplate; detail?: RequestTemplate }
function fail(message = 'Provider response changed or could not be read completely'): never { throw new OpenCliError(message, 'OPENCLI_FAILED') }
const date = (value: unknown) => {
  const n = Number(value)
  const time = typeof value === 'number' || /^\d+$/.test(String(value)) ? (n < 1e12 ? n * 1000 : n) : Date.parse(String(value))
  return Number.isFinite(time) ? new Date(time).toISOString() : ''
}

/** These sources intentionally never claim a complete account-wide inventory. */
export class NewWebChatClient {
  private credential?: CapturedWebCredential
  constructor(readonly provider: NewWebProvider, private readonly secret: string, private readonly fetcher: typeof fetch = fetch) {
    if (provider !== 'qwen') {
      try { this.credential = JSON.parse(secret) } catch { fail('Invalid saved credential; reconnect this account') }
      for (const operation of ['identity', 'list', 'detail'] as const) {
        const template = this.credential?.[operation]
        if (!template && operation === 'detail') continue
        if (!template) fail('Invalid saved credential; reconnect this account')
        let url: URL
        try { url = new URL(template.url); if (template.method === 'POST') JSON.parse(template.body || '{}') }
        catch { fail('Invalid saved credential; reconnect this account') }
        if (url.origin + url.pathname !== credentialEndpoints[provider][operation] || url.username || url.password
          || !['GET', 'POST'].includes(template.method) || !template.headers || typeof template.headers !== 'object') fail('Provider URL rejected')
        if (Object.entries(template.headers).some(([key, value]) => /[\r\n]/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value))) fail('Invalid saved credential; reconnect this account')
      }
    }
  }

  private async json(template: RequestTemplate, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted()
    try {
      const response = await this.fetcher(template.url, { method: template.method, headers: template.headers,
        ...(template.method === 'POST' ? { body: template.body } : {}), redirect: 'error', credentials: 'omit',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]) })
      if ([401, 403, 429].includes(response.status)) {
        await response.body?.cancel()
        throw new OpenCliError('Login expired or provider rate limited; reconnect or retry later', response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_NOT_LOGGED_IN')
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) { await response.body?.cancel(); fail() }
      const reader = response.body?.getReader()
      if (!reader) fail()
      const chunks: Uint8Array[] = []; let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break
          size += value.byteLength
          if (size > 32 * 1024 * 1024) fail('Provider response exceeds size limit')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (value.success === false || value.failed === true || (value.code !== undefined && Number(value.code) !== 0)
        || (value.status_code !== undefined && Number(value.status_code) !== 0)) fail('Provider rejected the request; reconnect or retry')
      return value
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof OpenCliError) throw error
      const code = (error as { cause?: { code?: string } })?.cause?.code
      if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
        throw new OpenCliError('Provider certificate was rejected; configure Node to trust the system CA, then retry. TLS verification remains enabled.', 'OPENCLI_CONFIGURATION')
      }
      throw new OpenCliError('Provider request failed; reconnect or retry', 'OPENCLI_FAILED')
    }
  }

  private qwen(path: string): RequestTemplate {
    const url = new URL(path, newWebHomes.qwen)
    if (!['https://chat.qwen.ai', 'https://auth.qwen.ai'].includes(url.origin) || url.username || url.password) fail('Provider URL rejected')
    return { url: url.href, method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${this.secret}`, Version: '0.3.20', source: 'web' } }
  }

  async identity(signal?: AbortSignal) {
    const payload = await this.json(this.provider === 'qwen' ? this.qwen('https://auth.qwen.ai/api/v2/auths/') : this.credential!.identity, signal)
    const identity = this.provider === 'qwen' ? payload.data?.id : this.provider === 'qianwen' ? payload.data?.userId
      : payload.downlink_body?.pull_recent_conv_chain_downlink_body?.user_id
    if (typeof identity !== 'string' || !identity || identity === '0') throw new OpenCliError('Server account identity unavailable; reconnect', 'PROVIDER_NOT_LOGGED_IN')
    return { identity, accountScope: createHash('sha256').update(`${this.provider}\0${identity}`).digest('hex') }
  }

  async run(operation: string, args: string[], savedScope: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const { identity, accountScope } = await this.identity(signal)
    const scopeIndex = args.indexOf('--accountScope')
    if (savedScope !== accountScope || operation !== 'sync-index' && scopeIndex >= 0 && args[scopeIndex + 1] !== accountScope) {
      throw new OpenCliError('Conversation belongs to a different account; sync and reselect it', 'PROVIDER_ACCOUNT_MISMATCH')
    }
    if (operation === 'whoami') return [{ identity }]
    if (operation === 'sync-index' || operation === 'history-all') {
      const rows = await this.list(signal)
      return operation === 'sync-index' ? [{ kind: 'identity', identity, sinceApplied: '', listingComplete: false }, ...rows.map(row => ({ ...row, kind: 'conversation' }))] : rows
    }
    if (operation === 'detail') return this.detail(args[0] ?? '', signal)
    throw new OpenCliError('This source does not support attachment downloads', 'OPENCLI_CONFIGURATION')
  }

  private async list(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const items: any[] = []
    const seen = new Set<string>()
    let next = ''
    for (let page = 1; page <= 500; page++) {
      let payload: any
      if (this.provider === 'qwen') payload = await this.json(this.qwen(`/api/v2/chats/?page=${page}&exclude_project=true`), signal)
      else {
        const template = this.credential!.list
        const body = JSON.parse(template.body || '{}')
        if (this.provider === 'qianwen' && page > 1) body.next_token = next
        payload = await this.json({ ...template, body: JSON.stringify(body) }, signal)
      }
      const data = this.provider === 'doubao' ? payload.downlink_body?.pull_recent_conv_chain_downlink_body : payload.data
      // Qianwen returns a successful absent data object at the end of some inventories.
      if (this.provider === 'qianwen' && page > 1 && data === undefined && payload.success === true) break
      const batch = this.provider === 'qwen' ? data : this.provider === 'qianwen' ? data?.list : data?.cells
      if (!Array.isArray(batch)) fail()
      if (!batch.length) break
      let added = 0
      for (const item of batch) {
        const row = this.provider === 'doubao' ? item.conversation : item
        const id = String(row?.id || row?.session_id || row?.conversation_id || '')
        if (!id) fail()
        if (seen.has(id)) continue
        seen.add(id); added++; items.push({ provider: this.provider, id, title: String(row.title || row.name || 'Untitled'),
          url: this.provider === 'qwen' ? `https://chat.qwen.ai/c/${encodeURIComponent(id)}` : this.provider === 'qianwen'
            ? `https://www.qianwen.com/chat/${encodeURIComponent(id)}` : `https://www.doubao.com/chat/${encodeURIComponent(id)}`,
          updatedAt: date(row.updated_at ?? row.update_time), createdAt: date(row.created_at ?? row.create_time) })
      }
      // shortcut: Doubao's next-page protocol is unverified; expose the captured recent page without treating absent chats as deleted.
      if (this.provider === 'doubao' || this.provider === 'qianwen' && !data.have_next_page) break
      if (!added || page === 500) fail('Provider pagination did not advance')
      if (this.provider === 'qianwen') {
        if (!data.next_token || data.next_token === next) fail('Provider pagination did not advance')
        next = data.next_token
      }
    }
    return items
  }

  private async detail(id: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    if (!id) fail('Missing conversation id')
    let payload: any
    if (this.provider === 'qwen') payload = await this.json(this.qwen(`/api/v2/chats/${encodeURIComponent(id)}`), signal)
    else {
      const template = this.credential!.detail
      if (!template) fail('Open an existing conversation on the website, then reconnect this source')
      const url = new URL(template.url)
      const body = JSON.parse(template.body || '{}')
      if (this.provider === 'qianwen') url.searchParams.set('session_id', id)
      else {
        if (!body.uplink_body?.pull_singe_chain_uplink_body) fail()
        body.uplink_body.pull_singe_chain_uplink_body.conversation_id = id
      }
      payload = await this.json({ ...template, url: url.href, body: JSON.stringify(body) }, signal)
    }
    return parseNewWebDetail(this.provider, id, payload)
  }
}

export function parseNewWebDetail(provider: NewWebProvider, id: string, payload: any): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  const push = (role: string, text: unknown, messageId: unknown, timestamp: unknown, partial = false) => {
    if (!['user', 'assistant'].includes(role) || typeof text !== 'string') fail()
    result.push({ conversationId: id, ordinal: result.length, messageId: String(messageId || ''), role, text, createdAt: date(timestamp), partial, attachmentsJson: '[]' })
  }
  if (provider === 'qwen') {
    const data = payload.data
    if (data?.id !== id || !Array.isArray(data?.chat?.messages)) fail()
    const chat = data.chat
    const pagination = chat.history?.pagination
    if (pagination?.has_more || pagination?.hasMore || pagination?.has_previous || pagination?.has_more_older) fail('Older messages require unsupported pagination')
    // messages is the server-selected active branch; history.messages includes regenerated alternatives.
    for (const message of chat.messages) {
      if (message.role === 'system') continue
      push(message.role, message.content, message.id, message.timestamp, Boolean(message.files?.length))
    }
  } else if (provider === 'qianwen') {
    const data = payload.data
    if (!Array.isArray(data?.list) || data.have_next_page) fail('Older messages require unsupported pagination')
    for (const batch of [...data.list].sort((a, b) => Number(a.request_timestamp) - Number(b.request_timestamp))) {
      if (batch.session_id !== id) fail()
      for (const [role, blocks] of [['user', batch.request_messages], ['assistant', batch.response_messages]] as const) {
        if (!Array.isArray(blocks)) fail()
        const texts = blocks.filter((block: any) => typeof block.content === 'string' && /^(text\/|application\/markdown$|multi_load\/iframe$)/.test(block.mime_type))
        const omitted = blocks.some((block: any) => !texts.includes(block) && !/^(signal\/|bar\/|paa\/iframe$)/.test(block.mime_type))
        push(role, texts.map((block: any) => block.content).join('\n'), `${batch.req_id}:${role}`, batch.request_timestamp, omitted)
      }
    }
  } else {
    const data = payload.downlink_body?.pull_singe_chain_downlink_body
    if (!Array.isArray(data?.messages) || data.has_more) fail('Older messages require unsupported pagination')
    for (const message of [...data.messages].sort((a, b) => Number(a.index_in_conv) - Number(b.index_in_conv))) {
      if (message.conversation_id && message.conversation_id !== id) fail()
      const role = message.user_type === 1 ? 'user' : message.user_type === 2 ? 'assistant' : ''
      const blocks = Array.isArray(message.content_block) ? message.content_block : []
      const text = typeof message.content === 'string' && message.content ? message.content
        : blocks.map((block: any) => block.content?.text_block?.text).filter((text: unknown) => typeof text === 'string').join('\n')
      const omitted = blocks.some((block: any) => Object.keys(block.content || {}).some(key => !['text_block', 'pc_event_block'].includes(key)))
      push(role, text, message.message_id, message.create_time, omitted || Boolean(message.regen_msg_list?.length))
    }
  }
  return result
}
