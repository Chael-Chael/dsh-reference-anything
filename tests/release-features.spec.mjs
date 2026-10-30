import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadReleaseFeatures } from '../scripts/release-features.mjs'

const roots = []
const mediaBase = 'https://raw.githubusercontent.com/Chael-Chael/dsh-reference-anything/4fbaf7af069cd10658b6aadb019505127ecb420f/docs/release/'
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(media = 'demo.gif') {
  const root = mkdtempSync(join(tmpdir(), 'release-features-')); roots.push(root)
  mkdirSync(join(root, '1.2.3'))
  writeFileSync(join(root, '1.2.3', 'features.json'), JSON.stringify([{ title: 'Feature', description: 'How to use it', media, alt: 'Demo' }]))
  return root
}

describe('release feature assets', () => {
  it('loads version folders as pinned URLs with encoded paths, without embedding GIF bytes', () => {
    const root = fixture('demo #1.gif')
    const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    writeFileSync(join(root, '1.2.3', 'demo #1.gif'), bytes)
    const cards = loadReleaseFeatures(root)['1.2.3']
    expect(cards[0]).toEqual({ title: 'Feature', description: 'How to use it', alt: 'Demo', media: `${mediaBase}1.2.3/demo%20%231.gif` })
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
    const current = loadReleaseFeatures(resolve('docs/release'))['0.5.2']
    expect(current).toHaveLength(3)
    expect(current.every(card => card.en.title && card.en.description)).toBe(true)
    expect(loadReleaseFeatures(resolve('docs/release'))['0.5.1']).toBeUndefined()
    const bilingual = loadReleaseFeatures(resolve('docs/release'))['0.5.0']
    expect(bilingual).toHaveLength(6)
    expect(bilingual.every(card => card.en.title && card.en.description)).toBe(true)
    expect(bilingual.slice(0, 5).every(card => card.en.alt && card.media.startsWith(mediaBase))).toBe(true)
    const cards = loadReleaseFeatures(resolve('docs/release'))['0.4.4']
    expect(cards).toHaveLength(6)
    expect(cards.slice(0, 5).every(card => card.media.startsWith(mediaBase))).toBe(true)
    expect(cards.at(-1)).toMatchObject({ title: '未来更新预告' })
    expect(cards.at(-1).media).toBeUndefined()
    expect(cards.at(-1).description.trim()).not.toBe('')
  })
})
