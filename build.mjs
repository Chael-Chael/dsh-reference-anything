import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadReleaseFeatures } from './scripts/release-features.mjs'

const outputDirectory = resolve('lib')
rmSync(outputDirectory, { recursive: true, force: true })

// Only modules seeded by the DSH browser shell may survive as runtime
// require() calls. Pure wire/grammar packages such as dsh-file-reference must
// be bundled into this external plugin, matching DSH's client build policy.
const clientExternals = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-session-controller/client',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'scheduler',
]

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
  define: { __REFERENCE_RELEASE_FEATURES__: JSON.stringify(loadReleaseFeatures(resolve('release-notes'))) },
  loader: { '.svg': 'text' },
  external: clientExternals.filter(name => name !== 'react-dom'),
  // Bundle the small react-dom/client entry shim; the host seeds only react-dom.
  plugins: [{ name: 'host-react-dom', setup(build) {
    build.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom', external: true }))
  } }],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-reference-anything', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: { js: 'return module.exports; } });' },
})

const logoDataUri = `data:image/png;base64,${readFileSync(resolve('images/logo.png')).toString('base64')}`
const monoLogoDataUri = `data:image/png;base64,${readFileSync(resolve('images/logo-mono.png')).toString('base64')}`
const bundledClient = resolve('lib/client.js')
const clientSource = readFileSync(bundledClient, 'utf8')
  .replaceAll('__REFERENCE_ANYTHING_LOGO_DATA_URI__', logoDataUri)
  .replaceAll('__REFERENCE_ANYTHING_MONO_LOGO_DATA_URI__', monoLogoDataUri)
const runtimeRequires = [...clientSource.matchAll(/require\("([^"]+)"\)/gu)].map(match => match[1])
const unexpectedRequires = [...new Set(runtimeRequires.filter(specifier => !clientExternals.includes(specifier)))]
if (unexpectedRequires.length > 0) {
  throw new Error(`client bundle leaked unregistered runtime modules: ${unexpectedRequires.join(', ')}`)
}
writeFileSync(bundledClient, clientSource)
