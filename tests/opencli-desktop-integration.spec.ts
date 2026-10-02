import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// Build first, then point this at an extracted official Desktop executable.
const desktop = process.env.DSH_REFERENCE_DESKTOP_EXECUTABLE
describe.skipIf(!desktop)('official Desktop OpenCLI invocation', () => {
  it('reads an external conversation through a Commander CLI under the Electron host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencli-desktop-integration-'))
    try {
      const shim = join(root, 'opencli.cmd')
      const entry = join(root, 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js')
      const require = createRequire(new URL('../node_modules/@jackwener/opencli/package.json', import.meta.url))
      const commander = pathToFileURL(require.resolve('commander')).href
      await mkdir(join(entry, '..'), { recursive: true })
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      await writeFile(shim, '')
      await writeFile(entry, `
        import commander from ${JSON.stringify(commander)}
        const program = new commander.Command()
        program.command('dsh-chatgpt').command('detail')
          .argument('<id>').option('--site-session <mode>').option('--window <mode>').option('-f <format>')
          .action(id => process.stdout.write(JSON.stringify([{conversationId:id,ordinal:0,messageId:'m1',parentId:'',branchId:'',activeBranch:true,role:'user',text:'desktop-read-ok',createdAt:'',attachmentsJson:'[]',partial:false}])))
        program.parse(process.argv)
      `)
      const bootstrap = join(root, 'host.mjs')
      await writeFile(bootstrap, `
        import { OpenCliRunner } from ${JSON.stringify(new URL('../lib/opencli.js', import.meta.url).href)}
        if (!process.versions.electron) throw new Error('Expected an Electron host')
        const rows = await new OpenCliRunner({ executable: process.argv[2] }).detail('chatgpt', process.argv[3])
        process.stdout.write(JSON.stringify(rows))
      `)
      const id = 'conversation; echo PWNED'
      const { stdout } = await promisify(execFile)(desktop!, [bootstrap, shim, id], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 15_000,
      })
      expect(JSON.parse(stdout)).toMatchObject([{ conversationId: id, text: 'desktop-read-ok' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
