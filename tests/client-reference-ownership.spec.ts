// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { FILE_SOURCE, SESSION_SOURCE, AGENT_SOURCE } from '../src/client/source.ts'
import { defaultPickerSettings, settingsRecordSchema } from '../src/wire.ts'

it.each(['official-first', 'ra-first', 'official-disabled', 'ra-picker-hidden'] as const)('%s preserves native and saved RA references without duplicate candidates', async order => {
  const officialEnabled = order !== 'official-disabled'
  const sources = new Map<string, InputTriggerSource>()
  const rules = new Map<string, unknown>()
  const effects: Promise<unknown>[] = []
  const registerSource = (source: InputTriggerSource) => {
    if (sources.has(source.name)) throw new Error(`slash source "${source.trigger}${source.name}" is already registered`)
    sources.set(source.name, source)
    return () => { sources.delete(source.name) }
  }
  const registerRule = (rule: { id: string }) => {
    if (rules.has(rule.id)) throw new Error(`user-text rule "${rule.id}" is already registered`)
    rules.set(rule.id, rule)
    return () => { rules.delete(rule.id) }
  }
  const official: InputTriggerSource = {
    trigger: '@', name: 'reference', candidates: async () => [], onPick: () => undefined,
    codec: { serialize: async ref => ref, clipboardText: ref => ref },
  }
  const mountOfficial = () => {
    registerRule({ id: 'file' }); registerRule({ id: 'folder' }); registerSource(official)
  }
  if (order === 'official-first') mountOfficial()
  const ok = <T,>(value: T) => ({ ok: true, value })
  const settings = settingsRecordSchema.parse({ opencliPath: 'opencli', profile: '', detailConcurrency: 2, picker: defaultPickerSettings() })
  if (order === 'ra-picker-hidden') {
    settings.picker!.files.enabled = false
    settings.picker!.sessions.enabled = false
  }
  settings.picker!.files.aliases = ['file', '文档']
  settings.picker!.sessions.aliases = ['session', '聊天']
  const remote = {
    settingsGet: async () => ok(settings), settingsUpdate: async () => ok(settings),
    quickHealth: async () => ok({}), updateStatus: async () => ok({}),
    stats: async () => ok([]), agentStats: async () => ok([]), storageStats: async () => ok({}),
    chatImportStatus: async () => ok({}), openListStatus: async () => ok({}),
  }
  const openResource = vi.fn()
  const fileList = vi.fn(async () => ok([{ path: 'readme.md', kind: 'file' }]))
  const candidates = vi.fn(async () => ok([{ sessionId: 'existing', label: 'Existing', mention: '@[Existing](dsh-session:existing)', createdAt: 1 }]))
  const inputTriggers = { registerSource, sessionOf: vi.fn() }
  // This roster includes the official plugin before its apply() runs; a module-only row is not an enabled plugin.
  const loader = { internal: { manifest: {
    plugins: officialEnabled ? [{ id: '@deepseek-ai/dsh-client-ui-reference' }] : [],
    modules: [{ id: '@deepseek-ai/dsh-client-ui-reference' }],
  } } }
  const ctx = {
    get: (name: string) => ({ inputTriggers, loader, uiConversation: { userText: { register: registerRule } } }[name]),
    effect: (fn: () => unknown) => { effects.push(Promise.resolve(fn())) },
    inputTriggers, sidebarRight: { openResource },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    remote: { $mount: async () => () => {}, fileReferences: { list: fileList }, sessionReferenceResolver: { candidates } },
    reflect: { get: () => remote },
    sessions: {
      scope: () => undefined, binding: () => ({}), list: { getSnapshot: () => ({ byId: {} }) },
      using: async (_id: unknown, _options: unknown, fn: Function) => fn({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } }),
    },
    slots: { inject: (_name: string, fn: Function) => { const result = fn(); if (result?.next) [...result] }, register: () => undefined },
  } as unknown as Context
  try {
    apply(ctx)
    if (order === 'ra-first' || order === 'ra-picker-hidden') mountOfficial()
    await Promise.all(effects)
    expect([...rules.keys()].sort()).toEqual(['file', 'folder'])
    expect(sources.has(AGENT_SOURCE)).toBe(true)
    if (officialEnabled) expect(sources.get('reference')).toBe(official)
    const session = { sessionId: 'test' as never }
    const request = { query: '', position: 'inline' as const, drilled: false, signal: new AbortController().signal }
    for (const name of [FILE_SOURCE, SESSION_SOURCE]) {
      const source = sources.get(name)!
      expect(source).toBeDefined()
      expect((await source.candidates(session, request)).length).toBe(officialEnabled ? 0 : 1)
      for (const ref of ['@readme.md', '@"dir a/"', '@[Existing](dsh-session:existing)']) {
        expect(await source.codec!.serialize(ref, request.signal)).toBe(ref)
        expect(source.codec!.clipboardText(ref)).toBe(ref)
      }
    }
    if (officialEnabled) {
      expect(fileList).not.toHaveBeenCalled(); expect(candidates).not.toHaveBeenCalled()
      expect(sources.get(FILE_SOURCE)!.header).toBeUndefined()
    }
    for (const [name, prefixes, load] of [[FILE_SOURCE, ['file', '文档'], fileList], [SESSION_SOURCE, ['session', '聊天'], candidates]] as const) {
      const source = sources.get(name)!
      for (const prefix of prefixes) {
        load.mockClear()
        if (officialEnabled) {
          expect(await source.candidates(session, { ...request, query: prefix })).toEqual([])
          expect(load).not.toHaveBeenCalled()
        }
        for (const colon of [':', '：']) {
          const rows = await source.candidates(session, { ...request, query: `${prefix}${colon}needle` })
          expect(rows.length).toBe(order === 'ra-picker-hidden' ? 0 : 1)
          if (order === 'ra-picker-hidden') expect(load).not.toHaveBeenCalled()
          else expect(load).toHaveBeenLastCalledWith('test', 'needle', request.signal)
        }
      }
    }
    expect(sources.get(FILE_SOURCE)!.openReference!(session, { ref: '@readme.md', appearance: 'file' })).toBe(true)
    expect(openResource).toHaveBeenCalledWith('dsh-resource://file/session/test/readme.md')
  } finally {
    for (const dispose of (await Promise.all(effects)).reverse()) if (typeof dispose === 'function') await dispose()
  }
  expect(sources.has(FILE_SOURCE)).toBe(false)
  expect(sources.has('reference')).toBe(officialEnabled)
  expect(rules.size).toBe(officialEnabled ? 2 : 0)
})
