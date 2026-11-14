import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SOURCE_AUTHOR_SKILL, registerSourceAuthorSkill, sourceAuthorSkill } from '../src/source-author-skill.ts'

describe('reference-source-author skill', () => {
  it('fills in this profile and carries the whole example plugin', () => {
    const skill = sourceAuthorSkill({ profileDir: '/home/u/.dsh/profiles/web/', dshVersion: '9.9.9' })
    expect(skill.description).toMatch(/reference source/u)
    expect(skill.content).not.toMatch(/\{\{\w+\}\}/u)
    expect(skill.content).toContain('dsh plugin --profile web add')
    expect(skill.content).toContain('@deepseek-ai/dsh-typert-protocol@9.9.9')
    expect(skill.content).toMatch(/[\\/]home[\\/]u[\\/]\.dsh[\\/]plugins/u)
    expect(skill.content).not.toMatch(/^---$/mu)
    for (const file of ['package.json', 'cordis.patch.yml', 'src/contract.ts', 'src/index.ts', 'src/client.ts']) expect(skill.content).toContain(`### \`${file}\``)
    expect(skill.content).toContain('ctx.references.registerPlugin(defineReferenceSource(')
  })

  it('leaves placeholders readable when the profile is unknown', () => {
    const skill = sourceAuthorSkill({})
    expect(skill.content).toContain('dsh plugin --profile <profile> add')
    expect(skill.content).toContain('<output of `dsh -V`>')
  })

  it('registers once the skills service exists and unregisters with it', async () => {
    const registered: string[] = []
    let removed = 0
    class Skills extends Service {
      constructor(ctx: Context) { super(ctx, 'skills') }
      register(skill: { name: string; invocation: { modelInvocable: boolean; userInvocable: boolean } }) {
        expect(skill.invocation).toEqual({ modelInvocable: true, userInvocable: true })
        registered.push(skill.name)
        return () => { removed++ }
      }
    }
    const ctx = new Context()
    registerSourceAuthorSkill(ctx)
    expect(registered).toEqual([])
    const fiber = await ctx.plugin(Skills)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(registered).toEqual([SOURCE_AUTHOR_SKILL])
    await fiber.dispose()
    expect(removed).toBe(1)
  })
})
