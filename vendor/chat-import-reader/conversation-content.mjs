import { createHash } from 'node:crypto'

// 仅由只读服务设置，普通 preview 与工具参数不能启用正文投影。
export const READ_CONTENT = Symbol('readConversation')

export function conversationContent(out, options) {
  if (options.structured) return structuredContent(out)
  const messages = []
  const blocks = (content, tool = false, detail = options.detail) => (Array.isArray(content) ? content : []).flatMap((b) => {
    if (!b || typeof b !== 'object') return []
    if (b.type === 'image' || (b.type === 'text' && (!tool || detail === 'full'))) return [b]
    if (b.type === 'tool-result') return blocks(b.content, true, detail)
    if (b.type === 'tool-call') return [{ type: 'text', text: `[tool ${b.name}]${detail === 'full' ? ` ${JSON.stringify(b.arguments)}` : ''}` }]
    return []
  })
  for (const event of out.events || []) {
    if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type)) continue
    const message = event.data?.message || event.data
    if (message?.source?.plugin === 'chat-import') continue
    const tool = event.type === 'tool/result'
    if (blocks(message?.content, tool, 'full').length) messages.push({
      role: event.type === 'assistant/message' ? 'assistant' : 'user', content: message.content, tool,
    })
  }
  // Hash and paginate the same source messages before applying display detail.
  const revision = createHash('sha256').update(JSON.stringify(messages)).digest('hex')
  const end = Math.min(options.before ?? messages.length, messages.length)
  const startIndex = Math.max(0, end - options.limit)
  const items = messages.slice(startIndex, end).map(message => {
    const content = blocks(message.content, message.tool)
    if (message.tool && content.length) content.unshift({ type: 'text', text: '[historical tool result]' })
    if (!content.length) content.push({ type: 'text', text: '[tool details omitted; use detail: "full"]' })
    return { role: message.role, content }
  })
  // 图片只保留所选窗口内且输出预算允许的载荷，降级原因随正文返回。
  let bytes = 0
  let imagesOmitted = 0
  for (const item of items) item.content = item.content.map((block) => {
    bytes += Buffer.byteLength(JSON.stringify(block))
    if (block.type === 'image' && bytes > 24 * 1024 * 1024) {
      imagesOmitted++
      return { type: 'text', text: '[image omitted: page image budget exceeded]' }
    }
    return block
  })
  return {
    sessionId: out.meta?.sourceId || out.meta?.id || '',
    title: out.title || '', cwd: out.meta?.cwd || null,
    items, startIndex, totalMessages: messages.length, hasOlder: startIndex > 0, revision,
    partial: Boolean(out.trimmed || out.compacted || out.skipped || out.imagesDegraded || imagesOmitted),
    skipped: out.skipped || 0, imagesOmitted: (out.imagesDegraded || 0) + imagesOmitted,
    // A conversion failure or discarded record is not evidence of an empty source.
    confirmedEmpty: Boolean(out.meta && !out.records && !out.skipped && !out.skipReason && !out.imagesDegraded
      && !(out.turns?.length) && !(out.messages) && !(out.toolCalls)
      && !(out.events || []).some(event => ['user/message', 'assistant/message', 'tool/result'].includes(event.type))),
  }
}


// One numbering system for text, linked tool details and images; never cached.
function structuredContent(out) {
  const messages = [], tools = [], images = []
  const events = (out.events || []).filter(event => ['user/message', 'assistant/message', 'tool/result'].includes(event.type)
    && (event.data?.message || event.data)?.source?.plugin !== 'chat-import')
  const calls = new Map()
  for (const event of events) {
    const message = event.data?.message || event.data
    const content = Array.isArray(message?.content) ? message.content : []
    const isTool = event.type === 'tool/result'
    const body = content.filter(block => block.type === 'text').map(block => block.text || '').join('\n')
    let owner
    if (!isTool && (body || content.some(block => block.type === 'image'))) {
      owner = messages.length + 1
      const source = message.source
      const checkpoint = source?.kind === 'compact-checkpoint' || source?.kind === 'plugin:compact'
        || (source?.kind === 'plugin' && source.plugin === 'compact')
      messages.push({ number: owner, role: event.type === 'assistant/message' ? 'assistant' : 'user', text: body,
        checkpoint, images: [] })
    }
    const visit = (blocks, messageId = owner) => {
      for (const block of blocks) {
        if (block.type === 'image') {
          const id = `image-${images.length + 1}`
          const name = block.attachment?.name || block.name
          images.push({ id, ...(messageId ? { message: messageId } : {}), ...(typeof name === 'string' && name ? { name } : {}), block })
          if (messageId) messages[messageId - 1].images.push(id)
        } else if (block.type === 'tool-call') {
          if (block.id) calls.set(block.id, { messageId, name: block.name, sourceId: !block.generatedId })
          tools.push({ ...(messageId ? { message: messageId } : {}), kind: 'call', name: block.name || '',
            ...(block.id && !block.generatedId ? { callId: block.id } : {}), text: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments) ?? '' })
        } else if (block.type === 'tool-result') {
          const callId = block.toolCallId || block.id
          const linked = calls.get(callId)?.messageId ?? messageId
          tools.push({ ...(linked ? { message: linked } : {}), kind: 'result', ...(callId && calls.get(callId)?.sourceId !== false ? { callId } : {}),
            text: (block.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n') })
          visit((block.content || []).filter(b => b.type !== 'text'), linked)
        }
      }
    }
    const callId = message.toolCallId || message.source?.callId
    const linked = calls.get(callId)?.messageId
    if (isTool && body) tools.push({ ...(linked ? { message: linked } : {}), kind: 'result', ...(callId && calls.get(callId)?.sourceId !== false ? { callId } : {}), text: body })
    if (isTool) owner = linked
    visit(content)
  }
  return { sessionId: out.meta?.sourceId || out.meta?.id || '', title: out.title || '', cwd: out.meta?.cwd || null,
    revision: createHash('sha256').update(JSON.stringify({ messages, tools, images })).digest('hex'),
    messages, tools, images, totalMessages: messages.length,
    partial: Boolean(out.trimmed || out.compacted || out.skipped || out.imagesDegraded),
    confirmedEmpty: Boolean(!events.length && out.meta && !out.records && !out.skipped && !out.skipReason && !out.imagesDegraded) }
}
