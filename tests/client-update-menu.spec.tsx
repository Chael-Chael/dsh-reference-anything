// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdateSource, UpdateDialog } from '../src/client/update-menu.tsx'
import { en } from '../src/client/locale.ts'
import type { PackageUpdateStatus } from '../src/client/remote.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof en, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key])) as never
const session = { sessionId: 'test' as never }
const request = { query: '', position: 'inline' as const, drilled: false, signal: new AbortController().signal }
let root: Root | undefined
let source: ReturnType<typeof createUpdateSource> | undefined
beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  })
})
afterEach(() => {
  act(() => { root?.unmount(); source?.dispose() })
  root = undefined; source = undefined
  document.body.innerHTML = ''; vi.unstubAllGlobals()
})
const available = (): PackageUpdateStatus => ({ currentVersion: '0.4.4', latestVersion: '0.4.5', updateAvailable: true, checkedAt: Date.now(), releaseNotes: '## Changes\nFixed search.' })

describe('update menu', () => {
  it('dismisses only this version across remounts without opening its row', async () => {
    let update = available()
    const publish = vi.fn(() => true)
    const install = vi.fn()
    source = createUpdateSource(async () => update, install, publish, t)
    expect(source.order).toBeLessThan(0)
    expect(await source.candidates(session, { ...request, query: 'files:' })).toEqual([])
    const rows = await source.candidates(session, request)
    expect(rows[0]?.name).toContain('0.4.5')
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const picked = vi.fn()
    const Icon = rows[0]!.icon as import('react').ComponentType
    act(() => { root!.render(<button role="option" onMouseDown={picked} onClick={picked}><span aria-hidden="true">{createElement(Icon)}</span></button>) })
    const close = host.querySelector('[role="button"]')!
    expect(close.parentElement?.parentElement?.getAttribute('aria-hidden')).toBeNull()
    act(() => {
      close.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      close.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(picked).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ candidates: [], reopen: false }))
    source.dispose()
    source = createUpdateSource(async () => update, install, publish, t)
    expect(await source.candidates(session, request)).toEqual([])
    update = { ...update, latestVersion: '0.4.6' }
    expect(await source.candidates(session, request)).toHaveLength(1)
    update = { ...update, updateAvailable: false }
    expect(await source.candidates(session, request)).toEqual([])
  })

  it('opens notes via the native pick path without installing or inserting a reference', async () => {
    const install = vi.fn()
    source = createUpdateSource(async () => available(), install, () => true, t)
    const [candidate] = await source.candidates(session, request)
    act(() => {
      expect(source!.onPick({ candidate: candidate!, session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })).toBe('handled')
    })
    expect(document.body.textContent).toContain('Fixed search.')
    expect(install).not.toHaveBeenCalled()
  })

  it('shows install errors, allows retry, then reports restart and disables further installs', async () => {
    const install = vi.fn().mockRejectedValueOnce(new Error('Install failed')).mockResolvedValueOnce({ version: '0.4.5', restartRequired: true })
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => { root!.render(<UpdateDialog update={available()} install={install} close={() => undefined} t={t} />) })
    const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent === 'Update to v0.4.5')!
    await act(async () => { button.click() })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Install failed')
    await act(async () => { button.click() })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Restart')
    expect(button.disabled).toBe(true)
    expect(install).toHaveBeenCalledTimes(2)
  })
})
