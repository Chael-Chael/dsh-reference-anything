import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { OpenCliError, OpenCliRunner } from '../src/opencli.ts'

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
    expect(health).toMatchObject({ version: '1.8.6', daemon: '', pluginInstalled: true, daemonError: 'bridge offline' })
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
