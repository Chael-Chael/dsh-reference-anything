// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { apiPagesProviderGuide, CloudDrives } from '../src/client/components.tsx'
import type { SettingsSnapshot } from '../src/client/components.tsx'
import { en } from '../src/client/locale.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof en, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key])) as never
const settings = { opencliPath: 'opencli', profile: '', detailConcurrency: 8, autoSync: false, syncOnStartup: false, autoSyncMinutes: 60, historyMode: 'metadata-only' as const, enabledProviders: [], enabledAgents: [], maxReadTurns: 10, inputRenderMode: 'pill' as const, cloudDriveDownloadDirectory: '' }
let root: Root | undefined; let host: HTMLElement | undefined
function mount(state: SettingsSnapshot, overrides: Partial<React.ComponentProps<typeof CloudDrives>> = {}): HTMLElement {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  state = { ...state, openListDrivers: state.openListDrivers?.map(driver => ({ ...driver, fields: driver.fields.map(field => ({ ...field, secret: field.secret ?? field.type === 'password' })) })) }
  const noop = async () => {}
  act(() => { root!.render(<CloudDrives state={state} save={noop} refreshOpenList={noop} install={noop} upgrade={async () => {}} connect={noop} disconnect={noop} createMount={noop} disableMount={noop} removeMount={noop} reindexMount={async () => ({ supported: false })} t={t} {...overrides} />) })
  return host
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; vi.restoreAllMocks() })

describe('Cloud drives form', () => {
  it('separates curated quick login drivers from advanced-only drivers', async () => {
    const el = mount({ settings, openList: { state: 'running', installed: true, mode: 'external', supportsRollback: false, upgradeAvailable: false }, openListDrivers: [
      { name: 'OneDrive', quickAuth: true, fields: [{ name: 'refresh_token', label: 'Token', type: 'text', secret: true, required: true }] },
      { name: 'OAuth-looking experimental', quickAuth: false, fields: [{ name: 'oauth_token', label: 'Token', type: 'text', secret: true, required: true }] },
    ] })
    await revealAdd(el, true)
    const quickOptions = Array.from(el.querySelectorAll<HTMLSelectElement>('.dsh_ref_cloud_quick select option')).map(option => option.textContent)
    const advancedOptions = Array.from(el.querySelectorAll<HTMLSelectElement>('.dsh_ref_cloud_mount_form select option')).map(option => option.textContent)
    expect(quickOptions).toEqual(['OneDrive']); expect(advancedOptions).toContain('OAuth-looking experimental')
  })
  it('never labels an enabled mount without exact work status as Ready', () => {
    const el = mount({ settings, openList: { state: 'running', installed: true, mode: 'external', supportsRollback: false, upgradeAvailable: false }, openListMounts: [{ id: '1', name: '/unknown', driver: 'Demo', enabled: true, status: 'error' }] })
    expect(el.textContent).toContain('Error'); expect(el.textContent).not.toContain('/unknownDemo · Ready')
  })
  it('clears one-time token and password after failed submits', async () => {
    const connect = vi.fn(async () => { throw new Error('no') }); const createMount = vi.fn(async () => { throw new Error('no') })
    let el = mount({ settings, openList: { state: 'install', installed: false, supportsRollback: false, upgradeAvailable: false } }, { connect })
    await act(async () => { button(el, 'I already use OpenList').click() })
    const endpoint = el.querySelector('input[placeholder="https://openlist.example"]') as HTMLInputElement
    const passwords = el.querySelectorAll<HTMLInputElement>('input[type=password]')
    act(() => { setNativeValue(endpoint, 'https://drive.example'); endpoint.dispatchEvent(new Event('input', { bubbles: true })) })
    act(() => { setNativeValue(passwords[0]!, 'password'); passwords[0]!.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { Array.from(el.querySelectorAll('button')).find(button => button.textContent === 'Connect external OpenList')!.click() })
    expect(passwords[0]!.value).toBe('')
    act(() => { root!.unmount() }); host!.remove(); root = undefined; host = undefined
    el = mount({ settings, openList: { state: 'running', installed: true, mode: 'external', supportsRollback: false, upgradeAvailable: false }, openListDrivers: [{ name: 'Demo', quickAuth: true, fields: [{ name: 'token', label: 'Token', type: 'password', required: true }] }] }, { createMount })
    await revealAdd(el)
    const quick = el.querySelector<HTMLTextAreaElement>('textarea.dsh_ref_masked_secret')!
    act(() => { setNativeValue(quick, 'token'); quick.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { button(el, 'Add this cloud drive').click() })
    expect(quick.value).toBe('')
  })
  it('shows quick login as a complete three-step task with a visible result and mount summary', async () => {
    const el = mount({ settings, openList: { state: 'running', installed: true, mode: 'managed', supportsRollback: false, upgradeAvailable: false }, openListDrivers: [{ name: 'OneDrive', quickAuth: true, fields: [{ name: 'refresh_token', label: 'Token', type: 'password', required: true }] }] })
    await revealAdd(el)
    expect(el.textContent).toContain('Sign in and add a cloud drive')
    expect(el.textContent).toContain('Choose the cloud drive to add')
    expect(el.textContent).toContain('Sign in to OneDrive')
    expect(el.textContent).toContain('Paste the authorization result')
    expect(el.textContent).toContain('OneDrive (OAuth2) 个人账号')
    expect(el.textContent).toContain('Use OpenList parameters')
    expect(el.textContent).toContain('OneDrive · /onedrive')
    const authorization = el.querySelector<HTMLAnchorElement>('.dsh_ref_quick_tasks a')!
    expect(authorization.textContent).toContain('Open OneDrive authorization page')
    expect(authorization.target).toBe('_blank')
    await act(async () => { button(el, 'Add this cloud drive').click() })
    expect(el.querySelector('[role=alert]')?.textContent).toContain('First paste the complete result')
  })
  it('gives provider-specific instructions matching the official API Pages controls', () => {
    expect(apiPagesProviderGuide('AliyunDrive')).toMatchObject({ option: '阿里云盘 (Client) 直接登录', parameters: 'automatic' })
    expect(apiPagesProviderGuide('BaiduNetdisk')).toMatchObject({ option: '百度网盘 (OAuth2) 验证登录', parameters: 'official' })
    expect(apiPagesProviderGuide('115 Cloud')).toMatchObject({ option: '115 网盘 (QRCode) 扫码登录', parameters: 'automatic' })
    expect(apiPagesProviderGuide('Dropbox')).toMatchObject({ parameters: 'own' })
  })
  it('initializes dynamic defaults, validates required values, and coerces numbers', async () => {
    const createMount = vi.fn(async () => {})
    const state: SettingsSnapshot = { settings, openList: { state: 'running', installed: true, mode: 'external', supportsRollback: false, upgradeAvailable: false }, openListDrivers: [{ name: 'Demo', fields: [{ name: 'required', label: 'Required', type: 'text', required: true }, { name: 'count', label: 'Count', type: 'number', required: false }, { name: 'enabled', label: 'Enabled', type: 'boolean', required: false }, { name: 'choice', label: 'Choice', type: 'select', required: false, options: [{ label: 'First', value: 'one' }] }] }] }
    const el = mount(state, { createMount })
    await revealAdd(el)
    const create = Array.from(el.querySelectorAll('button')).find(button => button.textContent === 'Create mount')!
    await act(async () => { create.click() })
    expect(createMount).not.toHaveBeenCalled(); expect(el.textContent).toContain('Complete every required field.')
    const inputs = el.querySelectorAll<HTMLInputElement>('.dsh_ref_cloud_mount_form input')
    act(() => { setNativeValue(inputs[0]!, 'ok'); inputs[0]!.dispatchEvent(new Event('input', { bubbles: true })) })
    act(() => { setNativeValue(inputs[1]!, '4'); inputs[1]!.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { create.click() })
    expect(createMount).toHaveBeenCalledWith(expect.objectContaining({ addition: { required: 'ok', count: 4, enabled: false, choice: 'one' } }))
    expect(inputs[3]!.value).toBe('/demo-2')
  })
  it('confirms removal and exposes reauth/index metadata', async () => {
    const removeMount = vi.fn(async () => {}); const createMount = vi.fn(async () => {}); vi.spyOn(window, 'confirm').mockReturnValue(true)
    const state: SettingsSnapshot = { settings, openList: { state: 'running', installed: true, mode: 'external', supportsRollback: false, upgradeAvailable: false }, openListDrivers: [{ name: 'Demo', fields: [{ name: 'token', label: 'Token', type: 'password', required: true }, { name: 'region', label: 'Region', type: 'text', required: false, default: 'default-region' }, { name: 'root_folder_path', label: 'Root', type: 'text', required: false, default: '/default' }] }], openListMounts: [{ id: '1', name: '/demo', driver: 'Demo', enabled: true, status: 'error', capacityUsed: 4, capacityTotal: 10, indexStatus: 'running', indexProgress: .5 }] }
    const el = mount(state, { removeMount, createMount })
    expect(el.textContent).toContain('running'); expect(el.textContent).toContain('Error'); expect(el.textContent).toContain('≈ 4 B / ≈ 10 B')
    await act(async () => { Array.from(el.querySelectorAll('button')).find(button => button.textContent === 'Remove')!.click() })
    expect(removeMount).toHaveBeenCalledWith('1')
    await act(async () => { Array.from(el.querySelectorAll('button')).find(button => button.textContent === 'Reauthenticate')!.click() })
    expect(el.textContent).toContain('Reauthenticate /demo')
    const reauthInputs = el.querySelectorAll<HTMLInputElement>('.dsh_ref_cloud_mount_form input')
    expect(reauthInputs[0]!.value).toBe('')
    act(() => { setNativeValue(reauthInputs[0]!, 'fresh-token'); reauthInputs[0]!.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { (el.querySelector('.dsh_ref_cloud_mount_form button') as HTMLButtonElement).click() })
    expect(createMount).toHaveBeenCalledWith({ id: '1', mountPath: '/demo', driver: 'Demo', addition: { token: 'fresh-token' } })
  })
  it('renders downloading immediately while a repair is in flight', async () => {
    let release: (() => void) | undefined
    const upgrade = vi.fn(async () => await new Promise<void>(resolve => { release = resolve }))
    const el = mount({ settings, openList: { state: 'running', installed: true, mode: 'managed', supportsRollback: false, upgradeAvailable: false } }, { upgrade })
    await act(async () => { Array.from(el.querySelectorAll('button')).find(button => button.textContent === 'Repair install')!.click() })
    expect(el.textContent).toContain('Downloading')
    await act(async () => { release?.() })
  })
  it('shows Upgrade for an older managed version and no repair action for a newer version', async () => {
    const upgrade = vi.fn(async () => {})
    const old = mount({ settings, openList: { state: 'upgrade', installed: true, mode: 'managed', version: 'v4.1.0', supportsRollback: false, upgradeAvailable: true, newerVersion: false } }, { upgrade })
    const button = Array.from(old.querySelectorAll('button')).find(item => item.textContent === 'Upgrade')!
    expect(button).toBeDefined()
    await act(async () => { button.click() })
    expect(upgrade).toHaveBeenCalledWith(false)
    expect(old.textContent).not.toContain('Repair install')
    const newer = mount({ settings, openList: { state: 'failed', installed: true, mode: 'managed', version: 'v5.0.0', supportsRollback: true, upgradeAvailable: false, newerVersion: true, error: 'Managed OpenList version is newer than the supported version' } })
    expect(newer.textContent).toContain('newer than the supported version')
    expect(newer.textContent).not.toContain('Repair install')
    expect(newer.textContent).not.toContain('Upgrade')
  })
  it('hides managed repair while external and can re-enable a disabled mount', async () => {
    const disableMount = vi.fn(async () => {})
    const el = mount({ settings, openList: { state: 'running', installed: true, mode: 'external', supportsRollback: true, upgradeAvailable: false }, openListMounts: [{ id: '9', name: '/off', driver: 'Demo', enabled: false, status: 'disabled' }] }, { disableMount })
    expect(el.textContent).not.toContain('Repair install')
    expect(el.textContent).not.toContain('Rollback')
    await act(async () => { Array.from(el.querySelectorAll('button')).find(button => button.textContent === 'Enable')!.click() })
    expect(disableMount).toHaveBeenCalledWith('9', false)
  })
  it('masks secret fields even when the official driver declares them as strings', async () => {
    const el = mount({ settings, openList: { state: 'running', installed: true, mode: 'external', supportsRollback: false, upgradeAvailable: false }, openListDrivers: [{ name: '115', fields: [{ name: 'access_token', label: 'Access', type: 'text', secret: true, required: true }, { name: 'refresh_token', label: 'Refresh', type: 'text', secret: true, required: true }] }] })
    await revealAdd(el)
    expect(el.querySelectorAll('.dsh_ref_cloud_mount_form input[type=password]')).toHaveLength(2)
  })
  it('keeps nonsecret mount fields and path visible when create fails', async () => {
    const createMount = vi.fn(async () => { throw new Error('persisted but rejected') })
    const el = mount({ settings, openList: { state: 'running', installed: true, mode: 'external', supportsRollback: false, upgradeAvailable: false }, openListDrivers: [{ name: 'Demo', fields: [{ name: 'region', label: 'Region', type: 'text', required: true }] }], openListMounts: [{ id: '7', name: '/persisted', driver: 'Demo', enabled: true }] }, { createMount })
    await revealAdd(el)
    const inputs = el.querySelectorAll<HTMLInputElement>('.dsh_ref_cloud_mount_form input')
    act(() => { setNativeValue(inputs[0]!, 'cn'); inputs[0]!.dispatchEvent(new Event('input', { bubbles: true })); setNativeValue(inputs[1]!, '/chosen'); inputs[1]!.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { Array.from(el.querySelectorAll('button')).find(button => button.textContent === 'Create mount')!.click() })
    expect(inputs[0]!.value).toBe('cn'); expect(inputs[1]!.value).toBe('/chosen'); expect(el.textContent).toContain('Error'); expect(el.textContent).toContain('/persisted')
    expect(createMount).toHaveBeenCalledOnce()
  })
})

function button(element: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(element.querySelectorAll('button')).find(item => item.textContent === label)!
}

async function revealAdd(element: HTMLElement, advanced = false): Promise<void> {
  await act(async () => { button(element, 'Add drive').click() })
  if (advanced) await act(async () => { button(element, 'Other drives or advanced setup').click() })
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, value)
}
