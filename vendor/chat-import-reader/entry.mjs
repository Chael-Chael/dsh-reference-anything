import { buildImportSources } from 'chat-import-source/lib/tools/import-sources.mjs'
import { previewTranscript } from 'chat-import-source/lib/import-core.mjs'
import { defaultRoots } from 'chat-import-source/lib/discovery/registry.mjs'
import { READ_CONTENT } from './conversation-content.mjs'

export { defaultRoots }

// Only the preview entry points are retained in this snapshot. No host session,
// registry, plugin lifecycle or attachment service is passed to the parsers.
export async function readConversation(fs, input, signal) {
  signal?.throwIfAborted()
  const ctx = { fs }
  const spec = buildImportSources(ctx).find(spec => spec.format === input.format)
  if (!spec || input.format === 'local-jsonl') throw new Error('Unsupported conversation format: ' + input.format)
  const target = await fs.resolve(input.path)
  const info = await fs.stat(target)
  if (!info) throw new Error('Conversation source not found: ' + input.path)
  if (info.type === 'directory' && !(await spec.io?.dirSingle?.(ctx, target))) {
    throw new Error('Select one conversation, not a source directory')
  }
  const args = {
    path: input.path, sessionIds: [input.sessionId], budget: 0,
    fullHistory: true, importSystemPrompt: false, referenceProjection: input.structured === true,
    ...await spec.derive?.args?.(target),
    [READ_CONTENT]: { limit: input.limit, before: input.before, detail: input.detail, structured: input.structured },
  }
  const result = spec.io?.previewFile
    ? await spec.io.previewFile(ctx, target, args)
    : await previewTranscript(ctx, target, args, spec.convert, { readText: spec.readText })
  signal?.throwIfAborted()
  const batch = Array.isArray(result.results)
  const entries = batch ? result.results : [result]
  const pages = entries.flatMap(entry => entry.conversation ? [entry.conversation] : [])
  const selected = batch ? pages.filter(page => page.sessionId === input.sessionId) : pages
  if (input.probe) {
    if (selected.length !== 1 || entries.some(entry => entry.error)) return 'unknown'
    const page = selected[0]
    return page.totalMessages ? 'readable' : page.confirmedEmpty ? 'empty' : 'unknown'
  }
  if (selected.length !== 1 || !selected[0].totalMessages) {
    throw new Error('Conversation could not be read: ' + entries.map(entry => entry.error || entry.skipReason || '').filter(Boolean).join('; '))
  }
  const page = selected[0]
  if (input.revision && input.revision !== page.revision) throw new Error('Conversation changed; read its latest page again')
  return page
}
