import { expect, it } from 'vitest'
import { releaseNotes } from '../scripts/agent/release-notes.mjs'

it('resolves release images against the original source commit and preserves copy', () => {
  const sha = 'a'.repeat(40)
  const input = '中文 ![Demo](demos/test.gif)\n![Remote](https://example.com/a.gif)\n[Section](#section)'
  expect(releaseNotes(input, 'docs/release/0.5.2/README.md', 'owner/repo', sha)).toBe(
    `中文 ![Demo](https://raw.githubusercontent.com/owner/repo/${sha}/docs/release/0.5.2/demos/test.gif)\n![Remote](https://example.com/a.gif)\n[Section](#section)`)
  expect(() => releaseNotes(input, 'README.md', 'owner/repo', 'main')).toThrow('Invalid')
})
