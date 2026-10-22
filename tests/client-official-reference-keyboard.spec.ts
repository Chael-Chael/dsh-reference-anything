// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'
import * as store from '@deepseek-ai/dsh-client-store'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputTriggerController, InputTriggerSource, InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { expect, it, vi } from 'vitest'
import { adoptOfficialReferenceMenu } from '../src/client/official-reference-menu.ts'
import { adoptMenuOpening } from '../src/client/menu-opening.ts'
import { defaultPickerSettings } from '../src/wire.ts'

it.each(['official-first', 'ra-first'].flatMap(order => ['file', 'session'].map(kind => ({ order, kind }))))('$order / $kind uses native keyboard navigation and official picks', async ({ order, kind }) => {
  const require = createRequire(import.meta.url)
  const modules: Record<string, unknown> = { '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-store': store, react, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  let Controller!: typeof InputTriggerController
  runInNewContext(readFileSync(process.env.DSH_TRIGGER_BUNDLE ?? require.resolve('@deepseek-ai/dsh-client-ui-input-trigger/client'), 'utf8'), {
    document, window: { __ModuleLoader__: { load: ({ factory }: { factory: (require: (id: string) => unknown) => { InputTriggerController: typeof InputTriggerController } }) => { Controller = factory(id => modules[id]).InputTriggerController } } }, AbortController, console,
  })
  const candidates = Array.from({ length: 14 }, (_, i) => ({ name: `file${i}`, section: kind, value: JSON.stringify({ kind, mention: `@file${i}` }) }))
  const onPick = vi.fn<InputTriggerSource['onPick']>(({ candidate }) => ({ insert: { source: 'reference', ref: JSON.parse(candidate.value!).mention, label: candidate.name, clipboardText: JSON.parse(candidate.value!).mention } }))
  const official: InputTriggerSource = { name: 'reference', trigger: '@', candidates: async () => candidates, onPick, codec: { serialize: async ref => ref, clipboardText: ref => ref } }
  const sources: InputTriggerSource[] = order === 'official-first' ? [official] : []
  const bail = vi.fn(() => true)
  const controller = new Controller({ sessionId: 'test' as never, actx: { bail } as never, roster: { sources: () => sources, all: () => sources } })
  const service = { sessionOf: () => controller } as unknown as InputTriggerServiceContract
  const opening = adoptMenuOpening(service)
  const dispose = adoptOfficialReferenceMenu(service, defaultPickerSettings, key => key)
  service.sessionOf({} as never)
  if (order === 'ra-first') { sources.push(official); controller.sourceAdded(official) }
  try {
    controller.track('@', 1, { tier: 'plain' }, 1)
    await vi.waitFor(() => expect(controller.menu.getSnapshot().groups.find(g => g.items.length)?.status).toBe('ready'))
    const items = () => controller.menu.getSnapshot().groups.find(g => g.source === (kind === 'file' ? 'reference' : 'reference-anything:official-sessions'))!.items
    expect(items()).toHaveLength(7)
    for (let i = 0; i < 6; i++) controller.arbitrate('down', false)
    expect(controller.menu.getSnapshot().highlight?.index).toBe(6)
    controller.arbitrate('enter', false)
    expect(items()).toHaveLength(13)
    expect(controller.menu.getSnapshot().open).toBe(true)
    expect(onPick).not.toHaveBeenCalled(); expect(bail).not.toHaveBeenCalled()
    controller.arbitrate('down', false)
    expect(items()[controller.menu.getSnapshot().highlight!.index]!.name).toBe('menu.collapse')
    controller.arbitrate('tab', false)
    expect(items()).toHaveLength(7)
    controller.arbitrate('up', false)
    expect(controller.menu.getSnapshot().highlight?.index).toBe(5)
    controller.arbitrate('enter', false)
    expect(onPick.mock.calls[0]![0].candidate).toBe(candidates[5])
    expect(bail).toHaveBeenCalledWith(expect.anything(), 'slash/input-insert-reference', expect.objectContaining({ reference: expect.objectContaining({ source: 'reference', ref: '@file5' }) }))
  } finally { dispose(); opening(); controller.dispose() }
})

