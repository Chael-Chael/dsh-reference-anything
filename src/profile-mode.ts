import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { findOwningProfileDir } from './update.ts'
import type { ReferenceUiMode } from './wire.ts'

export const OFFICIAL_REFERENCE_PATCH_BEGIN = '# BEGIN dsh-reference-anything managed official-reference override'
export const OFFICIAL_REFERENCE_PATCH_END = '# END dsh-reference-anything managed official-reference override'

export interface ReferenceUiSwitchResult {
  mode: ReferenceUiMode
  restartRequired: false
}

interface SwitchReferenceUiModeOptions {
  mode: ReferenceUiMode
  packageRoot?: string
  dshHome?: string
  signal?: AbortSignal
}

/**
 * Switch only the visible @ implementation while keeping this package alive.
 *
 * The bundle patch remains untouched so updating or reinstalling the package
 * cannot erase the user's choice. The plugin Host and settings entry remain
 * active in both modes; the client separately registers or disposes its own
 * picker sources.
 */
export async function switchReferenceUiMode(options: SwitchReferenceUiModeOptions): Promise<ReferenceUiSwitchResult> {
  options.signal?.throwIfAborted()
  const profileDir = await findOwningProfileDir(options.packageRoot, options.dshHome)
  await writeReferenceUiModeOverride(join(profileDir, 'cordis.patch.yml'), options.mode, options.signal)
  return { mode: options.mode, restartRequired: false }
}

/** Write the managed override without exposing a partially-written YAML file. */
export async function writeReferenceUiModeOverride(path: string, mode: ReferenceUiMode, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  let source = ''
  try {
    source = await readFile(path, { encoding: 'utf8', signal })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
  const next = withReferenceUiModeOverride(source, mode)
  if (next === source) return

  const temporary = join(dirname(path), `.cordis.patch.yml.dsh-reference-anything-${String(process.pid)}-${String(Date.now())}.tmp`)
  try {
    await writeFile(temporary, next, { encoding: 'utf8', signal })
    signal?.throwIfAborted()
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Preserve every user-owned row and append one idempotent block at the end,
 * where Cordis' ordered patch semantics make it the effective override.
 */
export function withReferenceUiModeOverride(source: string, mode: ReferenceUiMode): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const beginRows = markerRows(lines, OFFICIAL_REFERENCE_PATCH_BEGIN)
  const endRows = markerRows(lines, OFFICIAL_REFERENCE_PATCH_END)
  if (beginRows.length > 1 || endRows.length > 1 || beginRows.length !== endRows.length) {
    throw new Error('the managed official-reference block in cordis.patch.yml is malformed')
  }
  if (beginRows.length === 1) {
    const begin = beginRows[0]!
    const end = endRows[0]!
    if (end < begin) throw new Error('the managed official-reference block in cordis.patch.yml is malformed')
    lines.splice(begin, end - begin + 1)
  }

  removeEmptyArrayDocument(lines)
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()

  const block = [
    OFFICIAL_REFERENCE_PATCH_BEGIN,
    '# Switch only the visible @ implementation; Reference Anything stays loaded.',
    '- id: ui-reference',
    `  disabled: ${mode === 'official' ? 'false' : 'true'}`,
    OFFICIAL_REFERENCE_PATCH_END,
  ]
  return [...lines, ...(lines.length > 0 ? [''] : []), ...block, ''].join(eol)
}

function markerRows(lines: readonly string[], marker: string): number[] {
  const rows: number[] = []
  lines.forEach((line, index) => { if (line.trim() === marker) rows.push(index) })
  return rows
}

/** `[]` is the valid empty profile document, but cannot precede list rows. */
function removeEmptyArrayDocument(lines: string[]): void {
  const meaningful = lines
    .map((line, index) => ({ index, text: line.trim() }))
    .filter(row => row.text !== '' && !row.text.startsWith('#'))
  if (meaningful.length === 1 && meaningful[0]?.text === '[]') lines.splice(meaningful[0].index, 1)
}
