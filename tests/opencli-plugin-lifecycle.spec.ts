import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('OpenCLI sync browser lifecycle', () => {
  it('uses background one-shot tabs and closes every command-owned tab', async () => {
    const source = await readFile(new URL('../opencli-plugin/common.js', import.meta.url), 'utf8')
    expect(source).toContain("siteSession: 'ephemeral'")
    expect(source).toContain("defaultWindowMode: 'background'")
    expect(source).not.toContain("siteSession: 'persistent'")
    expect(source).not.toContain("name: 'close-sync-tab'")
    expect(source).toContain('await page.closeTab?.()')
    expect(source.match(/await page\.closeTab\?\.\(\)/g)).toHaveLength(1)
    expect(source).not.toContain('closeWindow')
    expect(source).not.toContain('destroyContainer')
  })

  it('uses a distinct site key for every supported provider', async () => {
    const providers = ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'kimi']
    const sources = await Promise.all(providers.map(provider => (
      readFile(new URL(`../opencli-plugin/${provider}.js`, import.meta.url), 'utf8')
    )))
    const sites = sources.map((source, index) => {
      const match = source.match(/site:\s*'(dsh-[^']+)'/)
      expect(match, `${providers[index]} must declare a DSH-specific OpenCLI site`).not.toBeNull()
      return match![1]
    })

    expect(new Set(sites).size).toBe(providers.length)
  })
})
