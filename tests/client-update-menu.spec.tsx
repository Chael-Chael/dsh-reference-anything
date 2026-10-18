// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdateSource, SettingsReleaseIntro, UpdateDialog } from '../src/client/update-menu.tsx'
import type { SettingsSnapshot } from '../src/client/components.tsx'
import { en } from '../src/client/locale.ts'
import type { PackageUpdateStatus } from '../src/client/remote.ts'
import type { PickerMenuUpdate } from '../src/client/menu-update.ts'

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
  it('switches card title, Markdown and alt live with the DSH locale', () => {
    vi.stubGlobal('__REFERENCE_RELEASE_FEATURES__', {
      '0.4.5': [{ title: '中文', description: '**中文说明**', media: 'demo.gif', alt: '中文图', en: { title: 'English', description: '**English copy**', alt: 'English image' } }],
    })
    let active = 'zh'
    const listeners = new Set<() => void>()
    const locale = {
      getSnapshot: () => ({ active, locales: [], revision: 0 }),
      subscribe: (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } },
    }
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => { root!.render(<UpdateDialog update={available()} install={vi.fn()} close={vi.fn()} t={t} locale={locale} />) })
    expect(document.querySelector('h2')?.textContent).toBe('中文')
    act(() => { active = 'en'; listeners.forEach(notify => notify()) })
    expect(document.querySelector('h2')?.textContent).toBe('English')
    expect(document.querySelector('.dsh_ref_release_description strong')?.textContent).toBe('English copy')
    expect(document.querySelector('.dsh_ref_release_media img')?.getAttribute('alt')).toBe('English image')
    act(() => { active = 'zh'; listeners.forEach(notify => notify()) })
    expect(document.querySelector('h2')?.textContent).toBe('中文')
    act(() => { root!.unmount() }); root = undefined
    expect(listeners.size).toBe(0)
  })
  it('renders a text-only preview without an empty media frame', () => {
    vi.stubGlobal('__REFERENCE_RELEASE_FEATURES__', {
      '0.4.5': [{ title: 'Next release', description: 'Coming soon [GitHub](https://github.com/Chael-Chael/dsh-reference-anything)' }],
    })
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => { root!.render(<UpdateDialog update={{ ...available(), currentVersion: '0.4.5', updateAvailable: false }} install={vi.fn()} close={vi.fn()} t={t} />) })
    expect(document.querySelector('h2')?.textContent).toBe('Next release')
    expect(document.querySelector('.dsh_ref_release_description')?.textContent).toBe('Coming soon GitHub')
    const link = document.querySelector('.dsh_ref_release_description a') as HTMLAnchorElement
    expect(link.href).toBe('https://github.com/Chael-Chael/dsh-reference-anything')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noreferrer')
    expect(document.querySelector('.dsh_ref_release_media')).toBeNull()
  })
  it('auto-opens the installed release once across settings remounts, then again for a new installed version', () => {
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    let update: PackageUpdateStatus | undefined
    let shown = new Set<string>()
    const install = vi.fn()
    const useScope = <S,>(selector: (state: SettingsSnapshot) => S) => selector({ update } as SettingsSnapshot)
    const render = () => act(() => { root!.render(<SettingsReleaseIntro useScope={useScope} shown={shown} install={install} t={t} />) })
    const unmount = () => act(() => { root!.render(null) })
    render()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    update = available()
    render()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('0.4.4')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('0.4.5')
    act(() => { (document.querySelector('button[aria-label="Close release notes"]') as HTMLButtonElement).click() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    unmount(); shown = new Set(); render()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    update = { ...available(), latestVersion: '0.4.6' }; render()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    unmount(); update = { ...available(), currentVersion: '0.4.5' }; render()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('0.4.5')
    expect(window.localStorage.getItem('dsh-reference-anything.dismissed-release')).toBeNull()
    expect(install).not.toHaveBeenCalled()
  })

  it('reopens the installed feature cards from settings even after dismissal', () => {
    vi.stubGlobal('__REFERENCE_RELEASE_FEATURES__', {
      '0.4.4': [{ title: 'Installed feature', description: 'Details' }],
      '0.4.5': [{ title: 'Future feature', description: 'Not installed' }],
    })
    window.localStorage.setItem('dsh-reference-anything.dismissed-release', '0.4.4')
    window.localStorage.setItem('dsh-reference-anything.auto-shown-release', '0.4.4')
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const install = vi.fn()
    const useScope = <S,>(selector: (state: SettingsSnapshot) => S) => selector({ update: available() } as SettingsSnapshot)
    act(() => { root!.render(<SettingsReleaseIntro useScope={useScope} shown={new Set()} install={install} t={t} />) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const button = document.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement
    for (let count = 0; count < 2; count++) {
      act(() => { button.click() })
      expect(document.querySelector('h2')?.textContent).toBe('Installed feature')
      act(() => { (document.querySelector('button[aria-label="Close release notes"]') as HTMLButtonElement).click() })
    }
    expect(window.localStorage.getItem('dsh-reference-anything.dismissed-release')).toBe('0.4.4')
    expect(install).not.toHaveBeenCalled()
  })

  it('remembers auto-display in the session when storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } })
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const shown = new Set<string>()
    const useScope = <S,>(selector: (state: SettingsSnapshot) => S) => selector({ update: available() } as SettingsSnapshot)
    const render = () => act(() => { root!.render(<SettingsReleaseIntro useScope={useScope} shown={shown} install={vi.fn()} t={t} />) })
    render()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    act(() => { root!.render(null) }); render()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it('paginates local feature cards without installing, and resets when reopened', async () => {
    vi.stubGlobal('__REFERENCE_RELEASE_FEATURES__', {
      '0.4.5': [
        { title: 'First feature', description: 'First explanation', media: 'data:image/png;base64,AA==', alt: 'Screenshot' },
        { title: 'Second feature', description: 'Second explanation', media: 'data:image/gif;base64,AA==', alt: 'Animation' },
      ],
    })
    const install = vi.fn()
    source = createUpdateSource(async () => ({ ...available(), currentVersion: '0.4.5', updateAvailable: false }), install, () => true, t)
    const [candidate] = await source.candidates(session, request)
    expect(candidate?.name).toMatch(/^🎉🎉 /)
    const open = () => { source!.onPick({ candidate: candidate!, session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } }) }
    act(open)
    const button = (label: string) => Array.from(document.querySelectorAll('button')).find(node => node.textContent === label)!
    expect(document.querySelector('h2')?.textContent).toBe('First feature')
    expect(button('Previous').disabled).toBe(true)
    expect(document.querySelector('img')?.alt).toBe('Screenshot')
    act(() => { button('Next').click() })
    expect(document.querySelector('h2')?.textContent).toBe('Second feature')
    expect(document.querySelector('img')?.src).toContain('data:image/gif;')
    expect(document.querySelector('.dsh_ref_release_description')?.textContent).toBe('Second explanation')
    expect(button('Next').disabled).toBe(true)
    act(() => { button('Previous').click() })
    expect(document.querySelector('h2')?.textContent).toBe('First feature')
    act(() => { button('Next').click() })
    act(() => { (document.querySelector('button[aria-label="Close release notes"]') as HTMLButtonElement).click() })
    act(open)
    expect(document.querySelector('h2')?.textContent).toBe('First feature')
    expect(install).not.toHaveBeenCalled()
    expect(await source.candidates(session, request)).toHaveLength(1)
  })
  it('dismisses only this version across remounts without opening its row', async () => {
    window.localStorage.setItem('dsh-reference-anything.dismissed-release', '0.4.4')
    let update = available()
    const publish = vi.fn((_update: PickerMenuUpdate) => true)
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

  it('keeps installed release notes until explicitly dismissed, then shows them after the next update', async () => {
    window.localStorage.setItem('dsh-reference-anything.dismissed-update', '0.4.5')
    let update = { ...available(), currentVersion: '0.4.5', updateAvailable: false }
    const install = vi.fn()
    const publish = vi.fn((_update: PickerMenuUpdate) => true)
    source = createUpdateSource(async () => update, install, publish, t)
    const [candidate] = await source.candidates(session, request)
    expect(candidate?.name).toContain("What's new")
    act(() => {
      source!.onPick({ candidate: candidate!, session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })
    })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Fixed search.')
    expect(document.body.textContent).not.toContain('Update to v0.4.5')
    act(() => { (document.querySelector('button[aria-label="Close release notes"]') as HTMLButtonElement).click() })
    expect(await source.candidates(session, request)).toHaveLength(1)
    act(() => { source!.dispose() })
    source = createUpdateSource(async () => update, install, publish, t)
    const [reopened] = await source.candidates(session, request)
    expect(reopened?.value).toBe('release:0.4.5')
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => { root!.render(createElement(reopened!.icon as import('react').ComponentType)) })
    act(() => { host.querySelector('[role="button"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ candidates: [] }))
    act(() => { source!.dispose() })
    source = createUpdateSource(async () => update, install, publish, t)
    expect(await source.candidates(session, request)).toEqual([])
    update = { ...update, currentVersion: '0.4.6', latestVersion: '0.4.6' }
    expect((await source.candidates(session, request))[0]?.value).toBe('release:0.4.6')
    expect(install).not.toHaveBeenCalled()
  })

  it('shows the installed version notes independently of a newer release', async () => {
    const update = { ...available(), currentReleaseNotes: 'Installed version changes', currentReleaseUrl: 'https://example.com/v0.4.4' }
    const publish = vi.fn((_update: PickerMenuUpdate) => true)
    source = createUpdateSource(async () => update, vi.fn(), publish, t)
    const rows = await source.candidates(session, request)
    expect(rows.map(row => row.value)).toEqual(['update:0.4.5', 'release:0.4.4'])
    act(() => {
      source!.onPick({ candidate: rows[1]!, session, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })
    })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Installed version changes')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Fixed search.')
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => { root!.render(createElement(rows[1]!.icon as import('react').ComponentType)) })
    act(() => { host.querySelector('[role="button"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(publish.mock.lastCall?.[0].candidates.map(row => row.value)).toEqual(['update:0.4.5'])
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
