// Regenerate explicitly from a built upstream package directory.
// Normal builds use the checked-in snapshot and never inspect another plugin.
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, relative, dirname } from 'node:path'
import { createHash } from 'node:crypto'

if (!process.argv[2]) throw new Error('Usage: npm run vendor:sync -- <built-dsh-chat-import-directory>')
const root = resolve(process.argv[2])
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (pkg.name !== 'dsh-chat-import' || !pkg.version) throw new Error('Expected a built dsh-chat-import package')
const snapshot = resolve('vendor/chat-import-reader')
const upstreamLicense = await readFile(resolve(root, 'LICENSE'), 'utf8')
if (!upstreamLicense.includes('MIT License')) throw new Error('Review upstream license before vendoring')
const decoderLicense = await readFile(resolve(root, 'node_modules/fzstd/LICENSE'), 'utf8')
if (!decoderLicense.includes('MIT License')) throw new Error('Review decoder license before vendoring')
const inputs = {}
const outputs = new Map()
function replace(source, from, to) {
  if (!source.includes(from)) throw new Error('Upstream patch no longer applies: ' + from)
  return source.replaceAll(from, to)
}
for (const entry of ['entry', 'scan-entry']) {
const outputName = entry === 'entry' ? 'parsers.mjs' : 'scanners.mjs'
const result = await build({
  write: false,
  entryPoints: [resolve(snapshot, entry + '.mjs')], outfile: resolve(snapshot, outputName),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  plugins: [{ name: 'readonly-parser-snapshot', setup(build) {
    build.onResolve({ filter: /^chat-import-source\// }, args => ({ path: resolve(root, args.path.slice('chat-import-source/'.length)) }))
    build.onLoad({ filter: /\.mjs$/ }, async args => {
      if (!args.path.startsWith(root + '\\') && !args.path.startsWith(root + '/')) return
      let source = await readFile(args.path, 'utf8')
      const file = relative(root, args.path).replaceAll('\\', '/')
      inputs[file] = createHash('sha256').update(source).digest('hex')
      if (entry === 'entry' && file.startsWith('lib/discovery/')) source = source.replace(/^\s+scan: .*\r?\n/gm, '\n')
      if (file === 'lib/discovery/sqlite.mjs') {
        source = replace(source, "const { listTraeDatabases } = await import('../sources/trae.mjs')", '')
        source = "import { listTraeDatabases } from '../sources/trae.mjs'\n" + source
      }
      if (file === 'lib/discovery-host.mjs') source = replace(source, 'const DB_SUMMARY_READERS =', 'export const DB_SUMMARY_READERS =')
      if (file === 'lib/tools/import-sources.mjs') {
        // Remove mutation callbacks before bundling so their imports disappear.
        source = source.replace(/^\s+(?:file|dir): .*\r?\n/gm, '\n')
        source = source.replace(/io: sourceIo\(\[import\w+, import\w+, /g, 'io: sourceIo([undefined, undefined, ')
      }
      if (file === 'lib/import-core.mjs') {
        source = `import { READ_CONTENT, conversationContent } from ${JSON.stringify(resolve(snapshot, 'conversation-content.mjs').replaceAll('\\', '/'))}\n` + source
        source = replace(source, 'function previewEntry(out)', 'function previewEntry(out, args = {})')
        source = replace(source, '  return entry\n', '  if (args[READ_CONTENT]) entry.conversation = conversationContent(out, args[READ_CONTENT])\n  return entry\n')
        source = replace(source, 'previewEntry(applyCwdRemap(markTrimmedSource(out, args), args))', 'previewEntry(applyCwdRemap(markTrimmedSource(out, args), args), args)')
        source = replace(source, '...previewEntry(out)', '...previewEntry(out, args)')
      }
      if (file === 'lib/sources/codex.mjs') source = replace(source, 'previewEntry(out)', 'previewEntry(out, args)')
      if (file === 'lib/convert/codex.mjs') {
        source = replace(source, 'const text = stripCodexPageContext(block.text).trim()', "const stripped = stripCodexPageContext(block.text).trim()\n      const text = stripped.startsWith('# Files mentioned by the user:') && stripped.includes('## My request:') ? stripped.slice(stripped.indexOf('## My request:') + '## My request:'.length).trim() : stripped")
        source = replace(source, 'if (prompt) {', "if (prompt || codexUserImageBlocks(payload.content).length) {")
        source = replace(source, 'shadowedTurns = shadowTurns(turns, shadowedTurns)', 'if (!args.referenceProjection) shadowedTurns = shadowTurns(turns, shadowedTurns)')
        source = replace(source, 'args.fullHistory === true || !payload', '(args.fullHistory === true && !args.referenceProjection) || !payload')
      }
      if (file === 'lib/convert/claude.mjs') {
        source = replace(source, 'args.fullHistory !== true', '(args.fullHistory !== true || args.referenceProjection)')
        source = replace(source, 'shadowedTurns = shadowTurns(turns, shadowedTurns)', 'if (!args.referenceProjection) shadowedTurns = shadowTurns(turns, shadowedTurns)')
      }
      if (file === 'lib/convert/antigravity.mjs') {
        // IDE transcripts use typed result records; match names before consuming parallel calls.
        source = `const RESULT_TOOL_NAMES = {
  LIST_DIRECTORY: ['list_dir'], VIEW_FILE: ['view_file'],
  CODE_ACTION: ['write_to_file', 'replace_file_content', 'multi_replace_file_content'],
  INVOKE_SUBAGENT: ['invoke_subagent'], RUN_COMMAND: ['run_command'], GREP_SEARCH: ['grep_search'],
}\n` + source
        source = replace(source, 'const takePending = (resultStep) => {', 'const takePending = (resultStep, toolNames) => {')
        source = replace(source, 'if (entry.resultText !== null) continue', "if (entry.resultText !== null || (toolNames && !toolNames.includes(entry.call.name.split('.').at(-1)))) continue")
        source = replace(source, "if (type === 'GENERIC') {", "if (type === 'GENERIC' || Object.hasOwn(RESULT_TOOL_NAMES, type)) {")
        source = replace(source, 'takePending(stepIndex)', 'takePending(stepIndex, RESULT_TOOL_NAMES[type])')
        source = replace(source, 'takePending(null)', 'takePending(null, RESULT_TOOL_NAMES[type])')
        source = replace(source, 'stepIndex !== null ? taskMessages.get(stepIndex) : null', "type === 'GENERIC' && stepIndex !== null ? taskMessages.get(stepIndex) : null")
      }
      if (file === 'lib/convert/trae.mjs') {
        // The DB reader already normalizes messages to parts before conversion.
        source = replace(source, '|| textFromValue(message && message.body)', '|| textFromValue(message && message.parts)\n    || textFromValue(message && message.body)')
      }
      return { contents: source, loader: 'js', resolveDir: dirname(args.path) }
    })
  } }],
})
const outputPath = resolve(snapshot, outputName)
let output = result.outputFiles[0].text
output = output.replaceAll(root.replaceAll('\\', '/'), 'dsh-chat-import@' + pkg.version)
if (/\b(?:writeFile|writeFileSync|mkdir|unlink|rename|createSession|rememberImport)\b/.test(output)) throw new Error('Mutation code leaked into the read-only bundle')
outputs.set(outputPath, '// Generated by scripts/vendor-chat-import-reader.mjs; see adjacent licenses.\n' + output)
}
outputs.set(resolve(snapshot, 'upstream-sha256.json'), JSON.stringify({ package: 'dsh-chat-import', version: pkg.version, files: Object.fromEntries(Object.entries(inputs).sort()) }, null, 2) + '\n')

outputs.set(resolve(snapshot, 'LICENSE'), upstreamLicense)
outputs.set(resolve(snapshot, 'LICENSE.fzstd'), decoderLicense)
// Validate both bundles before replacing the checked-in snapshot.
for (const [path, content] of outputs) await writeFile(path, content)
console.log(`Updated scanner and reader snapshot from ${pkg.name}@${pkg.version}`)
