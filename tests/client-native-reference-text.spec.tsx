// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import React, { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { en } from '../src/client/locale.ts'
import { NativeFileReference, NativeFolderReference, nativeFileRule, nativeFolderRule, registerNativeReferenceText } from '../src/client/native-reference-text.tsx'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async importOriginal => ({
  ...await importOriginal<object>(),
  ReferenceChip: ({ label, title, onActivate }: { label: string; title: string; onActivate?: () => void }) => onActivate
    ? <button title={title} onClick={onActivate}>{label}</button> : <span title={title}>{label}</span>,
}))
const t: ComponentProps<typeof NativeFileReference>['t'] = (key, params) => {
  let text = (en as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

it('matches upstream file/folder grammar, source offsets, punctuation and boundaries', () => {
  for (const [raw, path, label, folder] of [
    ['@src/a.ts，', 'src/a.ts', 'a.ts', false],
    ['@"a b!.md"', 'a b!.md', 'a b!.md', false],
    ['@C:\\src\\a.ts', 'C:\\src\\a.ts', 'a.ts', false],
    ['@docs/。', 'docs/', 'docs', true],
    ['@"dir a/"', 'dir a/', 'dir a', true],
    ['@/', '/', '/', true],
  ] as const) {
    const text = `前文 ${raw} 后文`
    const rule = folder ? nativeFolderRule : nativeFileRule
    const node = rule.match(text, 0)!
    expect(node).toMatchObject({ start: 3, data: { path, label }, id: folder ? 'folder' : 'file' })
    expect(text.slice(node.start, node.end)).toBe(raw.replace(/[，。]$/u, ''))
    expect(rule.match(text, node.end)).toBeUndefined()
  }
  for (const rule of [nativeFileRule, nativeFolderRule]) {
    expect(rule.match('mail@host prefix@file.ts @。 @', 0)).toBeUndefined()
    expect(rule.match('prefix@file.ts', 6)).toBeUndefined()
  }
})

it('registers new-host rules and slots with session-owned navigation, and disposes rules', () => {
  const rules = new Map<string, unknown>(), slots = new Map<string, { key: string; inject?: (id: string) => { openFile(path: string): void } }>()
  const effects: Array<() => void> = []
  const openFile = vi.fn()
  const userText = { register: (rule: typeof nativeFileRule) => { rules.set(rule.id, rule); return () => { rules.delete(rule.id) } } }
  const ctx = { get: () => ({ userText }), effect: (fn: () => () => void) => effects.push(fn()), slots: {
    inject: (_name: string, run: () => Generator<unknown>) => [...run()],
    register: (config: { key: string }) => { slots.set(config.key, config) },
  } } as unknown as Context
  registerNativeReferenceText(ctx, openFile, t)
  expect([...rules.keys()]).toEqual(['file', 'folder'])
  expect([...slots.keys()]).toEqual(['file', 'folder'])
  slots.get('file')!.inject!('origin-session').openFile('docs/a b.md')
  expect(openFile).toHaveBeenCalledWith('origin-session', 'docs/a b.md')
  for (const dispose of effects) dispose()
  expect(rules.size).toBe(0)
  registerNativeReferenceText({ get: () => ({}) } as unknown as Context, openFile, t)
})

it('keeps file navigation errors local, supports retry, and leaves summaries/folders inert', () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const openFile = vi.fn().mockImplementationOnce(() => { throw new Error('unavailable') })
  const props = { node: { id: 'file' as const, start: 0, end: 14, data: { path: 'docs/a b.md', label: 'a b.md' } }, raw: '@"docs/a b.md"', interactive: true, openFile, t }
  try {
    act(() => { root.render(<NativeFileReference {...props} />) })
    act(() => { host.querySelector('button')!.click() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Couldn’t open “docs/a b.md”')
    act(() => { Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Retry')!.click() })
    expect(openFile).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    act(() => { root.render(<NativeFileReference {...props} interactive={false} />) })
    expect(host.querySelector('button')).toBeNull()
    act(() => { root.render(<NativeFolderReference {...props} node={{ ...props.node, id: 'folder' }} />) })
    expect(host.querySelector('button')).toBeNull()
  } finally { act(() => root.unmount()); host.remove() }
})
