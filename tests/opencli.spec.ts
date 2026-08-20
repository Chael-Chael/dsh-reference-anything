import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { OpenCliError, OpenCliRunner, parseDaemonStatus, versionAtLeast } from '../src/opencli.ts'

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

  it('passes the expected account scope to detail reads', async () => {
    const script = await fake(`
      const args=process.argv.slice(2)
      const at=args.indexOf('--accountScope')
      if(args[0]!=='dsh-chatgpt'||args[1]!=='detail'||args[2]!=='c1'||at<0||args[at+1]!=='scope') process.exit(78)
      process.stdout.write(JSON.stringify([{conversationId:'c1',ordinal:0,messageId:'1',parentId:'',branchId:'',activeBranch:true,role:'user',text:'ok',createdAt:'',attachmentsJson:'[]',partial:false}]))
    `)
    const rows = await new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] }).detail('chatgpt', 'c1', undefined, 'scope')
    expect(rows[0]?.conversationId).toBe('c1')
  })

  it('classifies an adapter account-scope refusal', async () => {
    const script = await fake(`process.stderr.write('DSH_ACCOUNT_SCOPE_MISMATCH: wrong account');process.exit(1)`)
    const runner = new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] })

    await expect(runner.detail('chatgpt', 'c1', undefined, 'scope')).rejects.toMatchObject({
      code: 'PROVIDER_ACCOUNT_MISMATCH',
    } satisfies Partial<OpenCliError>)
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

  it('accepts a valid empty full listing so deleted remote rows can be retired', async () => {
    const script = await fake(`process.stdout.write(JSON.stringify([{kind:'identity',identity:'account-1',sinceApplied:''}]))`)
    const index = await new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] }).syncIndex('chatgpt')
    expect(index.rows).toEqual([])
    expect(index.sinceApplied).toBe('')
  })

  it('pins OpenCLI subprocesses and browser commands to background even when the environment requests foreground', async () => {
    const script = await fake(`
      const args=process.argv.slice(2)
      if(process.env.OPENCLI_WINDOW!=='background'||args[0]!=='dsh-chatgpt'||args[1]!=='history-all'||args[2]!=='--site-session'||args[3]!=='ephemeral'||args[4]!=='--window'||args[5]!=='background') process.exit(78)
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

  it('allows commands for the same provider to run concurrently in isolated ephemeral sessions', async () => {
    const script = await fake(`
      const { access, writeFile } = await import('node:fs/promises')
      const worker = process.argv[2]
      const own = new URL('./' + worker + '.ready', import.meta.url)
      const peer = new URL('./' + (worker === 'first' ? 'second' : 'first') + '.ready', import.meta.url)
      await writeFile(own, '')
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        try { await access(peer); process.stdout.write('[]'); process.exit(0) } catch {}
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      process.stderr.write('same site was serialized'); process.exit(78)
    `)
    const first = new OpenCliRunner({ executable: process.execPath, prefixArgs: [script, 'first'] })
    const second = new OpenCliRunner({ executable: process.execPath, prefixArgs: [script, 'second'] })

    await expect(Promise.all([first.history('chatgpt'), second.history('chatgpt')])).resolves.toEqual([[], []])
  })

  it('allows ephemeral sessions belonging to different providers to run concurrently', async () => {
    const script = await fake(`
      const { access, writeFile } = await import('node:fs/promises')
      const site = process.argv[2]
      const own = new URL('./' + site + '.ready', import.meta.url)
      const peer = new URL('./' + (site === 'dsh-chatgpt' ? 'dsh-claude' : 'dsh-chatgpt') + '.ready', import.meta.url)
      await writeFile(own, '')
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        try { await access(peer); process.stdout.write('[]'); process.exit(0) } catch {}
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      process.stderr.write('different sites were serialized'); process.exit(78)
    `)
    const runner = new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] })

    await expect(Promise.all([runner.history('chatgpt'), runner.history('claude')])).resolves.toEqual([[], []])
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
      else if(args==='doctor'){process.stderr.write('connectivity failed');process.exitCode=1}
    `)
    const health = await new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] }).health()
    expect(health).toMatchObject({
      version: '1.8.6', daemon: '', pluginInstalled: true, daemonError: 'bridge offline',
      daemonRunning: false, extensionConnected: false, extensionState: 'daemon-offline', connectivityOk: false,
      opencliCompatible: true, adapterCompatible: false, doctorError: 'connectivity failed',
    })
  })

  it('checks OpenCLI viability without launching a provider site command', async () => {
    const script = await fake(`
      const args=process.argv.slice(2).join(' ')
      if(args.startsWith('dsh-')) { process.stderr.write('health opened a provider'); process.exit(78) }
      if(args==='--version') process.stdout.write('1.8.6')
      else if(args==='daemon status') process.stdout.write('Daemon: running (PID 1)\\nVersion: v1.8.6\\nExtension: connected')
      else if(args==='plugin list') process.stdout.write('dsh-chat-history @0.2.2 (chatgpt, claude, deepseek, gemini, grok, kimi)')
      else if(args==='doctor') process.stdout.write('[OK] Connectivity: connected in 0.2s')
      else process.exit(78)
    `)

    await expect(new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] }).health()).resolves.toMatchObject({
      connectivityOk: true, pluginInstalled: true, adapterCompatible: true,
    })
  })

  it('checks local bridge and adapter state without running doctor', async () => {
    const script = await fake(`
      const args=process.argv.slice(2).join(' ')
      if(args==='--version') process.stdout.write('1.8.6')
      else if(args==='daemon status') process.stdout.write('Daemon: running (PID 1)\\nVersion: v1.8.6\\nExtension: connected')
      else if(args==='plugin list') process.stdout.write('dsh-chat-history @0.2.2 (chatgpt, claude, deepseek, gemini, grok, kimi)')
      else if(args==='doctor') { process.stderr.write('doctor must not run'); process.exit(78) }
      else process.exit(78)
    `)

    await expect(new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] }).quickHealth()).resolves.toMatchObject({
      extensionConnected: true, connectivityChecked: false, connectivityOk: false,
      pluginInstalled: true, adapterCompatible: true,
    })
  })

  it('treats a successful plugin listing with adapter import warnings as broken', async () => {
    const script = await fake(`
      const args=process.argv.slice(2).join(' ')
      if(args==='--version') process.stdout.write('1.8.6')
      else if(args==='daemon status') process.stdout.write('Daemon: running (PID 1)\\nVersion: v1.8.6\\nExtension: connected')
      else if(args==='plugin list') {
        process.stdout.write('dsh-chat-history @0.2.2 (chatgpt, claude, deepseek, gemini, grok, kimi)')
        process.stderr.write("⚠ Plugin dsh-chat-history/chatgpt.js: Cannot find package '@jackwener/opencli'")
      } else if(args==='doctor') process.stdout.write('[OK] Connectivity: connected in 0.2s')
    `)

    await expect(new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] }).health()).resolves.toMatchObject({
      pluginInstalled: true, adapterCommandsReady: false, adapterCompatible: false,
      pluginError: expect.stringContaining("Cannot find package '@jackwener/opencli'"),
    })
  })

  it('repairs an already registered adapter and verifies that it loads', async () => {
    const script = await fake(`
      const { existsSync, writeFileSync } = await import('node:fs')
      const marker = new URL('./repaired', import.meta.url)
      const args=process.argv.slice(2).join(' ')
      if(args==='plugin list') {
        process.stdout.write('dsh-chat-history @0.2.2 (chatgpt, claude, deepseek, gemini, grok, kimi)')
        if(!existsSync(marker)) process.stderr.write("⚠ Plugin dsh-chat-history/chatgpt.js: Cannot find package '@jackwener/opencli'")
      } else if(args==='plugin update dsh-chat-history') writeFileSync(marker, '')
      else process.exit(78)
    `)

    await expect(new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] })
      .installPlugin('file:///adapter')).resolves.toBeUndefined()
  })

  it('installs a missing adapter and verifies that it loads', async () => {
    const script = await fake(`
      const { existsSync, writeFileSync } = await import('node:fs')
      const marker = new URL('./installed', import.meta.url)
      const args=process.argv.slice(2).join(' ')
      if(args==='plugin list') {
        if(existsSync(marker)) process.stdout.write('dsh-chat-history @0.2.2 (chatgpt, claude, deepseek, gemini, grok, kimi)')
      } else if(args==='plugin install file:///adapter') writeFileSync(marker, '')
      else process.exit(78)
    `)

    await expect(new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] })
      .installPlugin('file:///adapter')).resolves.toBeUndefined()
  })

  it('detects stale daemon, live connectivity, and adapter compatibility independently', async () => {
    const script = await fake(`
      const args=process.argv.slice(2).join(' ')
      if(args==='--version') process.stdout.write('1.8.6')
      else if(args==='daemon status') process.stdout.write('Daemon: running (PID 1)\\nVersion: v1.8.5\\nExtension: connected (v1.0.22)')
      else if(args==='plugin list') process.stdout.write('dsh-chat-history @0.2.0 (chatgpt, claude, deepseek, gemini, grok, kimi)')
      else if(args==='doctor'&&process.env.OPENCLI_WINDOW==='background') process.stdout.write('[OK] Connectivity: connected in 0.2s')
    `)
    const health = await new OpenCliRunner({ executable: process.execPath, prefixArgs: [script] }).health()
    expect(health).toMatchObject({
      opencliCompatible: true, daemonVersion: '1.8.5', daemonStale: true,
      connectivityOk: true, pluginVersion: '0.2.0', pluginInstalled: true, adapterCommandsReady: true, adapterCompatible: false,
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

describe('version compatibility', () => {
  it('compares stable semantic versions numerically', () => {
    expect(versionAtLeast('v1.8.6', '1.8.6')).toBe(true)
    expect(versionAtLeast('1.10.0', '1.8.6')).toBe(true)
    expect(versionAtLeast('1.8.5', '1.8.6')).toBe(false)
    expect(versionAtLeast('', '1.8.6')).toBe(false)
  })
})
