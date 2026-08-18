import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('OpenCLI sync browser lifecycle', () => {
  it('uses a background one-shot tab inside Browser Bridge reusable container', async () => {
    const source = await readFile(new URL('../opencli-plugin/common.js', import.meta.url), 'utf8')
    expect(source).toContain("siteSession: 'ephemeral'")
    expect(source).toContain("defaultWindowMode: 'background'")
    expect(source).toContain('await page.closeTab?.()')
    expect(source).not.toContain('destroyContainer')
  })
})
