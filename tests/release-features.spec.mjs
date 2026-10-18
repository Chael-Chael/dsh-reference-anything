import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadReleaseFeatures } from '../scripts/release-features.mjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(media = 'demo.gif') {
  const root = mkdtempSync(join(tmpdir(), 'release-features-')); roots.push(root)
  mkdirSync(join(root, '1.2.3'))
  writeFileSync(join(root, '1.2.3', 'features.json'), JSON.stringify([{ title: 'Feature', description: 'How to use it', media, alt: 'Demo' }]))
  return root
}

describe('release feature assets', () => {
  it('loads version folders and embeds GIF bytes unchanged', () => {
    const root = fixture()
    const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    writeFileSync(join(root, '1.2.3', 'demo.gif'), bytes)
    const cards = loadReleaseFeatures(root)['1.2.3']
    expect(cards[0]).toEqual({ title: 'Feature', description: 'How to use it', alt: 'Demo', media: `data:image/gif;base64,${bytes.toString('base64')}` })
  })

  it('rejects media outside its release folder and invalid content', () => {
    const root = fixture('../outside.png')
    writeFileSync(join(root, 'outside.png'), 'outside')
    expect(() => loadReleaseFeatures(root)).toThrow('Invalid release media')
    writeFileSync(join(root, '1.2.3', 'features.json'), '[{"title":"Incomplete"}]')
    expect(() => loadReleaseFeatures(root)).toThrow()
  })

  it('supports text-only previews and requires alt text for media', () => {
    const root = fixture()
    const path = join(root, '1.2.3', 'features.json')
    const preview = { title: 'Next release', description: 'Coming soon' }
    writeFileSync(path, JSON.stringify([preview]))
    expect(loadReleaseFeatures(root)['1.2.3']).toEqual([preview])
    writeFileSync(path, JSON.stringify([{ ...preview, media: 'demo.gif' }]))
    expect(() => loadReleaseFeatures(root)).toThrow('Media requires alt text')
  })

  it('validates and packages the checked-in release content', () => {
    const bilingual = loadReleaseFeatures(resolve('release-notes'))['0.5.0']
    expect(bilingual).toHaveLength(6)
    expect(bilingual.every(card => card.en.title && card.en.description)).toBe(true)
    expect(bilingual.slice(0, 5).every(card => card.en.alt && card.media.startsWith('data:image/gif;base64,'))).toBe(true)
    const cards = loadReleaseFeatures(resolve('release-notes'))['0.4.4']
    expect(cards).toHaveLength(6)
    expect(cards.slice(0, 5).every(card => card.media.startsWith('data:image/gif;base64,'))).toBe(true)
    expect(cards.at(-1)).toMatchObject({ title: '未来更新预告' })
    expect(cards.at(-1).media).toBeUndefined()
    expect(cards.at(-1).description.trim()).not.toBe('')
  })
})
