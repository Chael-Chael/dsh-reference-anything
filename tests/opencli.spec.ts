import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { OpenCliError, OpenCliRunner, parseDaemonStatus } from '../src/opencli.ts'

async function fake(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opencli-fake-'))
  const file = join(root, 'fake.mjs')
  await writeFile(file, source, 'utf8'); await chmod(file, 0o755)
  return file
}

describe('OpenCLI execFile boundary', () => {
  it('passes a malicious conversation id as data, without a shell', async () => {
    const script = await fake(`process.stdout.write(JSON.stringify([{conversationId:process.argv[4],ordinal:0,messageId:'1',parentId:'',branchId:'',activeBranch:true,role:'user',text:'ok',createdAt:'',attachmentsJson:'[]',partial:false}]))`)
    const runner = new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] })
    const id = 'x; Write-Output PWNED'
    const rows = await runner.detail('chatgpt', id)
    expect(rows[0]?.conversationId).toBe(id)
  })

  it('parses account identity and history from one sync-index command', async () => {
    const script = await fake(`process.stdout.write(JSON.stringify([
      {kind:'identity',identity:'account-1',sinceApplied:'2026-08-18T00:00:00.000Z'},
      {kind:'conversation',id:'c1',title:'One',url:'https://example.test/c1',createdAt:'',updatedAt:'2026-08-18T01:02:03.004Z',messageCount:2,cursor:'',partial:false}
    ]))`)
    const runner = new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] })
    const index = await runner.syncIndex('chatgpt', undefined, '2026-08-18T00:00:00.000Z', 'old-scope')
    expect(index.accountScope).toMatch(/^[a-f0-9]{64}$/)
    expect(index.sinceApplied).toBe('2026-08-18T00:00:00.000Z')
    expect(index.rows).toEqual([expect.objectContaining({ provider: 'chatgpt', id: 'c1', title: 'One' })])
  })

  it('pins browser commands to background even when the environment requests foreground', async () => {
    const script = await fake(`
      const args=process.argv.slice(2)
      if(args[0]!=='dsh-chatgpt'||args[1]!=='history-all'||args[2]!=='--window'||args[3]!=='background') process.exit(78)
      process.stdout.write('[]')
    `)
    const previous = process.env.OPENCLI_WINDOW
    process.env.OPENCLI_WINDOW = 'foreground'
    try {
      await expect(new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] }).history('chatgpt')).resolves.toEqual([])
    } finally {
      if (previous === undefined) delete process.env.OPENCLI_WINDOW
      else process.env.OPENCLI_WINDOW = previous
    }
  })

  it('enforces the stdout cap', async () => {
    const script = await fake(`process.stdout.write('['+' '.repeat(10000)+']')`)
    const runner = new OpenCliRunner({ executable: process.execPath, prefixArgs: [script], maxStdoutBytes: 1000 })
    await expect(runner.history('chatgpt')).rejects.toMatchObject({ code: 'OPENCLI_OUTPUT_TOO_LARGE' } satisfies Partial<OpenCliError>)
  })

  it('enforces the provider timeout', async () => {
    const script = await fake(`setTimeout(()=>process.stdout.write('[]'), 5000)`)
    const runner = new OpenCliRunner({ executable: process.execPath, prefixArgs: [script], timeoutMs: 50 })
    await expect(runner.history('chatgpt')).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' } satisfies Partial<OpenCliError>)
  })

  it('reports health probes independently', async () => {
    const script = await fake(`
      const args=process.argv.slice(2).join(' ')
      if(args==='--version') process.stdout.write('1.8.6')
      else if(args==='daemon status'){process.stderr.write('bridge offline');process.exitCode=1}
      else if(args==='plugin list') process.stdout.write('opencli-plugin-dsh-chat-history')
    `)
    const health = await new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] }).health()
    expect(health).toMatchObject({
      version: '1.8.6', daemon: '', pluginInstalled: true, daemonError: 'bridge offline',
      daemonRunning: false, extensionConnected: false, extensionState: 'daemon-offline',
    })
  })

  it('discovers connected and saved Browser Bridge profiles', async () => {
    const script = await fake(`process.stdout.write('Connected Browser Bridge profiles\\n\\n  abc work default — connected v1.0.22\\n\\nDisconnected saved profiles:\\n  xyz personal — not connected\\n')`)
    const profiles = await new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] }).profiles()
    expect(profiles).toEqual([
      { id: 'abc', alias: 'work', connected: true, isDefault: true },
      { id: 'xyz', alias: 'personal', connected: false, isDefault: false },
    ])
  })
})

describe('parseDaemonStatus', () => {
  it('parses a connected extension with a version', () => {
    expect(parseDaemonStatus([
      'Daemon: running (PID 1234)',
      'Version: 1.8.6',
      'Extension: connected (v1.0.22)',
      'Port: 19825',
    ].join('\n'))).toEqual({
      daemonRunning: true, extensionState: 'connected', extensionConnected: true, extensionVersion: '1.0.22',
    })
  })

  it('treats a stale daemon as running', () => {
    expect(parseDaemonStatus('Daemon: stale (PID 9)\nExtension: connected (version unknown)')).toEqual({
      daemonRunning: true, extensionState: 'connected', extensionConnected: true,
    })
  })

  it('parses a connected extension without a version', () => {
    expect(parseDaemonStatus('Daemon: running (PID 1)\nExtension: connected (version unknown)')).toMatchObject({
      daemonRunning: true, extensionConnected: true, extensionState: 'connected',
    })
    expect(parseDaemonStatus('Daemon: running (PID 1)\nExtension: connected (version unknown)').extensionVersion).toBeUndefined()
  })

  it('parses multiple profiles with none selected', () => {
    expect(parseDaemonStatus('Daemon: running (PID 1)\nExtension: 2 profiles connected, none selected — run `opencli profile use <name>`')).toEqual({
      daemonRunning: true, extensionState: 'profile-required', extensionConnected: false, profileCount: 2,
    })
  })

  it('parses a disconnected requested profile', () => {
    expect(parseDaemonStatus('Daemon: running (PID 1)\nExtension: requested profile not connected — run `opencli profile use <name>`')).toMatchObject({
      daemonRunning: true, extensionState: 'profile-disconnected', extensionConnected: false,
    })
  })

  it('parses a plain disconnected extension', () => {
    expect(parseDaemonStatus('Daemon: running (PID 1)\nExtension: disconnected')).toMatchObject({
      daemonRunning: true, extensionState: 'disconnected', extensionConnected: false,
    })
  })

  it('parses a not-running daemon, including its single-line output', () => {
    expect(parseDaemonStatus('Daemon: not running')).toEqual({
      daemonRunning: false, extensionState: 'daemon-offline', extensionConnected: false,
    })
  })

  it('degrades empty output to daemon-offline', () => {
    expect(parseDaemonStatus('')).toEqual({
      daemonRunning: false, extensionState: 'daemon-offline', extensionConnected: false,
    })
  })
})
