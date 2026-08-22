import { describe, expect, it } from 'vitest'
import { REFERENCE_ANYTHING_INVOCATIONS, driveCandidateSchema, openListDisableMountSchema, openListExternalConnectSchema, openListStatusSchema } from '../src/contract.ts'
import { defaultOpenListMountPath, parseQuickProviderAddition } from '../src/client/components.tsx'
import { productionOpenListSeams, secureOpenListPermissions } from '../src/openlist/index.ts'

describe('OpenList Remote boundary', () => {
  it('declares every administration method and accepts credentials only as request input', () => {
    const names = REFERENCE_ANYTHING_INVOCATIONS.map(item => item.method).filter(name => name.startsWith('openList'))
    expect(names).toEqual(['openListStatus', 'openListInstall', 'openListUpgrade', 'openListConnectExternal', 'openListDisconnect', 'openListDrivers', 'openListMounts', 'openListCreateMount', 'openListDisableMount', 'openListRemoveMount', 'openListReindex'])
    expect(openListExternalConnectSchema.parse({ endpoint: 'https://drive.example', password: 'never-return-this', token: 'also-secret' })).toMatchObject({ endpoint: 'https://drive.example' })
    expect(openListStatusSchema.safeParse({ state: 'running', installed: true, supportsRollback: false, upgradeAvailable: false, token: 'nope' }).success).toBe(false)
    expect(openListDisableMountSchema.parse({ id: '7', disabled: false })).toEqual({ id: '7', disabled: false })
    expect(driveCandidateSchema.parse({ id: 'openlist:opaque', label: 'note.md', provider: 'OpenList', origin: '/note.md', searchIncomplete: true })).toEqual({ id: 'openlist:opaque', label: 'note.md', provider: 'OpenList', origin: '/note.md', searchIncomplete: true })
    expect(driveCandidateSchema.safeParse({ id: 'openlist:opaque', label: 'note.md', provider: 'OpenList', searchIncomplete: true, token: 'nope' }).success).toBe(false)
  })
})

describe('OpenList mount names', () => {
  it('generates an editable collision-free mount path', () => {
    expect(defaultOpenListMountPath('Google Drive', ['/google-drive', '/google-drive-2'])).toBe('/google-drive-3')
  })
})

describe('OpenList API Pages input', () => {
  const driver = { name: '115', fields: [
    { name: 'access_token', label: 'Access', type: 'password' as const, required: true },
    { name: 'refresh_token', label: 'Refresh', type: 'password' as const, required: true },
    { name: 'root_id', label: 'Root', type: 'text' as const, required: false, default: '0' },
  ] }
  it('requires all multi-field credentials and accepts JSON or key=value lines', () => {
    expect(parseQuickProviderAddition(driver, 'one-token')).toBeUndefined()
    expect(parseQuickProviderAddition(driver, '{"access_token":"a","refresh_token":"r"}')).toEqual({ access_token: 'a', refresh_token: 'r', root_id: '0' })
    expect(parseQuickProviderAddition(driver, 'access_token=a\nrefresh_token=r')).toEqual({ access_token: 'a', refresh_token: 'r', root_id: '0' })
    expect(parseQuickProviderAddition(driver, 'access_token=a')).toBeUndefined()
  })
  it('allows a scalar only for one authorization field', () => {
    expect(parseQuickProviderAddition({ name: 'Demo', fields: [{ name: 'token', label: 'Token', type: 'password', required: true }] }, 'secret')).toEqual({ token: 'secret' })
  })
})

describe('OpenList production persistence wiring', () => {
  it('always supplies the ACL seam used by credential and managed-config persistence', () => {
    expect(productionOpenListSeams().securePermissions).toBeTypeOf('function')
  })
  it('uses checked non-shell icacls reset, inheritance removal, and a single-user grant', async () => {
    const calls: unknown[][] = []
    await secureOpenListPermissions('C:\\safe path\\credentials.json', false, async (...args) => { calls.push(args); return undefined }, true, 'DOMAIN\\person')
    expect(calls).toEqual([
      ['icacls', ['C:\\safe path\\credentials.json', '/reset'], { windowsHide: true }],
      ['icacls', ['C:\\safe path\\credentials.json', '/inheritance:r'], { windowsHide: true }],
      ['icacls', ['C:\\safe path\\credentials.json', '/grant:r', 'DOMAIN\\person:F'], { windowsHide: true }],
    ])
    const failed: string[] = []
    await expect(secureOpenListPermissions('C:\\safe', true, async (_file, args) => { failed.push(args[1] ?? ''); if (args[1] === '/inheritance:r') throw new Error('denied') }, true, 'person')).rejects.toThrow('denied')
    expect(failed).toEqual(['/reset', '/inheritance:r'])
  })
})
