import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { command, inspectLink, home } = vi.hoisted(() => ({ command: vi.fn(async () => ({ stdout: '2.0.0', stderr: '' })), inspectLink: vi.fn(), home: vi.fn(() => 'unused-home') }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: home }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), lstatSync: inspectLink }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const execFile = Object.assign(() => undefined, { [promisify.custom]: command })
  return { ...original, execFile }
})
import { installOpenCli, OpenCliRunner } from '../src/opencli.ts'

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!
const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
const roots: string[] = []
afterEach(async () => {
  Object.defineProperty(process, 'execPath', execPathDescriptor)
  if (electronDescriptor) Object.defineProperty(process.versions, 'electron', electronDescriptor)
  else delete process.versions.electron
  vi.unstubAllEnvs()
  command.mockClear()
  inspectLink.mockReset()
  home.mockReset().mockReturnValue('unused-home')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function desktop() {
  const root = await mkdtemp(join(tmpdir(), 'opencli-desktop-'))
  roots.push(root)
  Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: join(root, 'DeepSeek Harness.exe') })
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: '44.0.0' })
  const node = join(root, 'node-bin', process.platform === 'win32' ? 'node.exe' : 'node')
  await mkdir(join(root, 'node-bin'))
  await writeFile(node, '')
  vi.stubEnv('PATH', `${join(root, 'node-bin')}${delimiter}${process.env.PATH ?? ''}`)
  return { root, node }
}

describe('OpenCLI under an Electron desktop host', () => {
  it.skipIf(process.platform !== 'win32')('removes only a stale adapter junction, preserving its target', async () => {
    const { root } = await desktop()
    home.mockReturnValue(root)
    const target = join(root, 'old-opencli')
    const link = join(root, '.opencli', 'plugins', 'dsh-chat-history', 'node_modules', '@jackwener', 'opencli')
    await mkdir(target)
    await writeFile(join(target, 'keep'), 'original')
    await mkdir(join(link, '..'), { recursive: true })
    await symlink(target, link, 'junction')
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    inspectLink.mockImplementation(path => path === link ? fs.lstatSync(path, { throwIfNoEntry: false }) : undefined)
    await new OpenCliRunner().version()
    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(target, 'keep'))).toBe(true)
  })

  it('runs a Windows npm shim with standalone Node', async () => {
    const { root, node } = await desktop()
    const shim = join(root, 'opencli.cmd')
    const entry = join(root, 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(shim, '')
    await writeFile(entry, '')
    await new OpenCliRunner({ executable: shim }).version()
    expect(command.mock.calls.map(call => call.slice(0, 2))).toEqual([[node, [entry, '--version']]])
  })

  it('selects the bundled CLI with standalone Node without installing global packages', async () => {
    const { node } = await desktop()
    const entry = createRequire(import.meta.url).resolve('@jackwener/opencli')
    await expect(installOpenCli()).resolves.toMatchObject({ found: true, executable: 'opencli' })
    expect(command.mock.calls.map(call => call.slice(0, 2)))
      .toEqual([[node, [entry, '--version']], [node, [entry, 'plugin', 'list']]])
  })
})
