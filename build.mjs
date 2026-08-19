import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const outputDirectory = resolve('lib')
rmSync(outputDirectory, { recursive: true, force: true })

const tsc = resolve('node_modules/typescript/bin/tsc')
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { stdio: 'inherit' })

const clientOutputDirectory = resolve(outputDirectory, 'client')
for (const name of readdirSync(clientOutputDirectory)) {
  if (name !== 'index.d.ts') rmSync(resolve(clientOutputDirectory, name), { force: true })
}

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  jsx: 'automatic',
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-*',
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'scheduler',
  ],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-reference-anything', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: { js: 'return module.exports; } });' },
})

const logoDataUri = `data:image/png;base64,${readFileSync(resolve('logo.png')).toString('base64')}`
const bundledClient = resolve('lib/client.js')
writeFileSync(bundledClient, readFileSync(bundledClient, 'utf8').replaceAll('__REFERENCE_ANYTHING_LOGO_DATA_URI__', logoDataUri))
