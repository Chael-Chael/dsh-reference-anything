// Adapted from DeepSeek Harness 687f282e, ui-reference/user-text-rules and FileReference (MIT; see NOTICE.md).
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useState, type ComponentType } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { REFERENCE_ANYTHING_NS } from './locale.ts'

// The userText API and ReferenceChip were added after the minimum supported host.
interface PathNode { id: 'file' | 'folder'; start: number; end: number; data: { path: string; label: string } }
interface PathRule { id: 'file' | 'folder'; order: number; match(text: string, from: number): PathNode | undefined }
interface NodeProps { node: PathNode; raw: string; interactive: boolean }
interface FileProps extends NodeProps { openFile(path: string): void; t: TranslateNS<typeof REFERENCE_ANYTHING_NS> }
const { Button, Modal } = primitives
const { ReferenceChip } = primitives as typeof primitives & { ReferenceChip: ComponentType<{
  appearance: 'file' | 'folder'; label: string; title: string; onActivate?: () => void
}> }

function nextPath(text: string, from: number, folder: boolean) {
  const tokens = /(?<!\S)(@"[^"\n]+"|@[^\s]+)/gu
  tokens.lastIndex = from
  for (let match = tokens.exec(text); match !== null; match = tokens.exec(text)) {
    const token = match[0]
    const raw = token.startsWith('@"') ? token : token.replace(/[.,;:!?，。；：！？]+$/u, '')
    if (raw.length <= 1) continue
    const path = raw.slice(1).replace(/^"|"$/gu, '')
    if (path.endsWith('/') !== folder) continue
    const label = path.split(/[\\/]/u).filter(Boolean).at(-1) ?? raw.slice(1)
    return { start: match.index, end: match.index + raw.length, data: { path, label } }
  }
  return undefined
}

export const nativeFileRule: PathRule = {
  id: 'file', order: 30,
  match(text, from) { const node = nextPath(text, from, false); return node && { id: 'file', ...node } },
}
export const nativeFolderRule: PathRule = {
  id: 'folder', order: 30,
  match(text, from) { const node = nextPath(text, from, true); return node && { id: 'folder', ...node } },
}

export function NativeFileReference({ node, raw, interactive, openFile, t }: FileProps) {
  const [failedPath, setFailedPath] = useState<string | null>(null)
  const { path, label } = node.data
  const close = () => { setFailedPath(null) }
  const open = () => {
    try { openFile(path) } catch { setFailedPath(path); return }
    setFailedPath(null)
  }
  return <>
    <ReferenceChip appearance="file" label={label} title={raw} {...interactive ? { onActivate: open } : {}} />
    {interactive && failedPath === path && <Modal open onClose={close}
      closeLabel={t('native.fileOpen.close')} title={t('native.fileOpen.title')}
      description={t('native.fileOpen.failed', { path })}
      footer={<><Button variant="outline" onClick={close}>{t('native.fileOpen.close')}</Button>
        <Button variant="primary" onClick={open}>{t('native.fileOpen.retry')}</Button></>} />}
  </>
}

export function NativeFolderReference({ node, raw }: NodeProps) {
  return <ReferenceChip appearance="folder" label={node.data.label} title={raw} />
}

/** Older hosts render these in ui-conversation; newer hosts delegate them to the disabled ui-reference. */
export function registerNativeReferenceText(ctx: Context, openFile: (sessionId: SessionId, path: string) => void, t: FileProps['t']): void {
  const conversation = ctx.get('uiConversation') as { userText?: { register(rule: PathRule): () => void } } | undefined
  if (!conversation?.userText) return
  const userText = conversation.userText
  ctx.effect(() => userText.register(nativeFileRule), 'reference-anything.client.file-text')
  ctx.effect(() => userText.register(nativeFolderRule), 'reference-anything.client.folder-text')
  const slots = ctx.slots as unknown as {
    inject(name: string, register: () => Generator<unknown>): void
    register<Props>(config: { name: string; key: string; priority: number; inject?: (sessionId: SessionId) => unknown }, component: ComponentType<Props>): unknown
  }
  slots.inject('conversation.user.text.node', function* () {
    yield slots.register({ name: 'conversation.user.text.node', key: 'file', priority: 100,
      inject: (sessionId) => ({ openFile: (path: string) => openFile(sessionId, path), t }),
    }, NativeFileReference)
    yield slots.register({ name: 'conversation.user.text.node', key: 'folder', priority: 100 }, NativeFolderReference)
  })
}
