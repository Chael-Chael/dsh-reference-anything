import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { command } = vi.hoisted(() => ({ command: vi.fn(async () => ({ stdout: '1.8.6', stderr: '' })) }))
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

  it('runs npm installation with standalone Node rather than the desktop application', async () => {
    const { root, node } = await desktop()
    const npm = join(root, 'npm-cli.js')
    await writeFile(npm, '')
    vi.stubEnv('npm_execpath', npm)
    await installOpenCli()
    expect(command.mock.calls.map(call => call.slice(0, 2)))
      .toContainEqual([node, [npm, 'install', '--global', '@jackwener/opencli@>=1.8.6']])
  })
})
