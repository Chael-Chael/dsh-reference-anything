import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OFFICIAL_REFERENCE_PATCH_BEGIN,
  OFFICIAL_REFERENCE_PATCH_END,
  withReferenceUiModeOverride,
  writeReferenceUiModeOverride,
} from '../src/profile-mode.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('@ reference UI profile override', () => {
  it('preserves user rows and appends the complete override last', () => {
    const source = '# user setting\n- id: another-plugin\n  disabled: false\n'
    const result = withReferenceUiModeOverride(source, 'official')

    expect(result).toContain(source.trim())
    expect(result).toContain('- id: ui-reference\n  disabled: false')
    expect(result).not.toContain('- id: reference-anything-web')
    expect(result.indexOf(OFFICIAL_REFERENCE_PATCH_BEGIN)).toBeGreaterThan(result.indexOf('another-plugin'))
    expect(result.trimEnd().endsWith(OFFICIAL_REFERENCE_PATCH_END)).toBe(true)
  })

  it('is idempotent and moves an existing managed block behind later user rows', () => {
    const first = withReferenceUiModeOverride('- id: before\n  disabled: false\n', 'official')
    const withLaterRow = `${first}- id: later\n  disabled: false\n`
    const second = withReferenceUiModeOverride(withLaterRow, 'official')

    expect(withReferenceUiModeOverride(second, 'official')).toBe(second)
    expect(second.match(new RegExp(OFFICIAL_REFERENCE_PATCH_BEGIN, 'g'))).toHaveLength(1)
    expect(second.indexOf(OFFICIAL_REFERENCE_PATCH_BEGIN)).toBeGreaterThan(second.indexOf('- id: later'))
  })

  it('switches back to plugin UI without disabling any Reference Anything service', () => {
    const legacy = [
      OFFICIAL_REFERENCE_PATCH_BEGIN,
      '- id: ui-reference',
      '  disabled: false',
      '- id: reference-anything-web',
      '  disabled: true',
      '- id: reference-web-chat',
      '  disabled: true',
      OFFICIAL_REFERENCE_PATCH_END,
      '',
    ].join('\n')
    const plugin = withReferenceUiModeOverride(legacy, 'plugin')

    expect(plugin).toContain('- id: ui-reference\n  disabled: true')
    expect(plugin).not.toContain('- id: reference-anything-web')
    expect(plugin).not.toContain('- id: reference-web-chat')
    expect(plugin.match(new RegExp(OFFICIAL_REFERENCE_PATCH_BEGIN, 'g'))).toHaveLength(1)
  })

  it('turns an empty CRLF YAML document into a valid list document', () => {
    const result = withReferenceUiModeOverride('# empty profile\r\n[]\r\n', 'official')

    expect(result).not.toMatch(/^\[\]$/m)
    expect(result).toContain('\r\n- id: ui-reference\r\n  disabled: false\r\n')
  })

  it('refuses to overwrite a malformed managed block', () => {
    expect(() => withReferenceUiModeOverride(`${OFFICIAL_REFERENCE_PATCH_BEGIN}\n- id: ui-reference\n`, 'official')).toThrow(/malformed/)
  })

  it('writes the patch atomically without leaving a sibling temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-reference-mode-'))
    temporaryDirectories.push(directory)
    const patchPath = join(directory, 'cordis.patch.yml')
    await writeFile(patchPath, '- id: custom\n  disabled: false\n', 'utf8')

    await writeReferenceUiModeOverride(patchPath, 'official')

    expect(await readFile(patchPath, 'utf8')).toContain('- id: custom\n  disabled: false')
    expect(await readdir(directory)).toEqual(['cordis.patch.yml'])
  })
})
