/**
 * The `reference-source-author` skill: teaches the agent to write a new
 * reference source as its own DSH plugin.
 *
 * A skill loads only when it is invoked, so registering it costs the model
 * nothing in ordinary turns. Settings' "Try now" opens a chat that starts
 * with `/reference-source-author`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOURCE_AUTHOR_SKILL = 'reference-source-author'

const PACKAGE_ROOT = new URL('../', import.meta.url)
const EXAMPLE_FILES = ['package.json', 'cordis.patch.yml', 'src/contract.ts', 'src/index.ts', 'src/client.ts'] as const

interface SkillRegistrationLike {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly source: string
  readonly provider: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
}
interface SkillRegistryLike { register(skill: SkillRegistrationLike): () => void }

/** Where this DSH profile lives, from the loader's base URL. */
function profileDirectory(ctx: Context): string | undefined {
  const loader = ctx.get('loader') as { root?: { ctx?: { baseUrl?: string } } } | undefined
  const baseUrl = loader?.root?.ctx?.baseUrl
  return baseUrl?.startsWith('file:') ? fileURLToPath(new URL('.', baseUrl)) : undefined
}

function readPackageFile(path: string): string {
  return readFileSync(new URL(path, PACKAGE_ROOT), 'utf8')
}

/** The skill body: the guide with this profile's facts, then the example plugin in full. */
export function sourceAuthorSkill(facts: { profileDir?: string; dshVersion?: string }): { description: string; content: string } {
  const raw = readPackageFile(`skills/${SOURCE_AUTHOR_SKILL}/SKILL.md`).replace(/\r\n/gu, '\n')
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(raw)
  const description = /^description:\s*(.+)$/mu.exec(match?.[1] ?? '')?.[1]?.trim() ?? ''
  const profileDir = facts.profileDir?.replace(/[\\/]+$/u, '')
  const raVersion = (JSON.parse(readPackageFile('package.json')) as { version?: string }).version ?? 'unknown'
  const values: Record<string, string> = {
    profileName: profileDir ? basename(profileDir) : '<profile>',
    profileDir: profileDir ?? '<profile directory>',
    pluginRoot: profileDir ? join(dirname(dirname(profileDir)), 'plugins') : '<DSH home>/plugins',
    dshVersion: facts.dshVersion ?? '<output of `dsh -V`>',
    raVersion,
    raDir: fileURLToPath(PACKAGE_ROOT).replace(/[\\/]+$/u, ''),
  }
  const guide = raw.slice(match?.[0].length ?? 0).replace(/\{\{(\w+)\}\}/gu, (whole, key: string) => values[key] ?? whole)
  const example = EXAMPLE_FILES.map(file => {
    const language = file.endsWith('.json') ? 'json' : file.endsWith('.yml') ? 'yaml' : 'ts'
    return `### \`${file}\`\n\n\`\`\`${language}\n${readPackageFile(`examples/reference-source-notes/${file}`).replace(/\r\n/gu, '\n').trimEnd()}\n\`\`\``
  }).join('\n\n')
  return { description, content: `${guide.trimEnd()}\n\n${example}\n` }
}

/** The running DSH launcher's version, which every `@deepseek-ai/*` package shares. */
function dshVersion(): string | undefined {
  let directory = process.argv[1] ? dirname(process.argv[1]) : undefined
  while (directory) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (manifest.name === '@deepseek-ai/dsh') return manifest.version
    } catch { /* keep walking up */ }
    const parent = dirname(directory)
    directory = parent === directory ? undefined : parent
  }
  return undefined
}

/** Register the skill while the `skills` service exists. */
export function registerSourceAuthorSkill(ctx: Context): void {
  ctx.inject(['skills'], scope => {
    const skills = scope.get('skills') as SkillRegistryLike | undefined
    if (!skills) return
    let skill: { description: string; content: string }
    try {
      skill = sourceAuthorSkill({ profileDir: profileDirectory(scope), dshVersion: dshVersion() })
    } catch (error) {
      scope.logger.warn('source-author skill unavailable: %s', error instanceof Error ? error.message : String(error))
      return
    }
    scope.effect(() => skills.register({
      name: SOURCE_AUTHOR_SKILL,
      description: skill.description,
      content: skill.content,
      source: 'bundled',
      provider: 'dsh-reference-anything',
      invocation: { modelInvocable: true, userInvocable: true },
    }), 'references.source-author-skill')
  })
}
