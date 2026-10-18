import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'

const cardsSchema = z.array(z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  media: z.string().min(1).optional(),
  alt: z.string().trim().min(1).optional(),
  en: z.object({ title: z.string().trim().min(1), description: z.string().trim().min(1), alt: z.string().trim().min(1).optional() }).strict().optional(),
}).strict().refine(card => !card.media || Boolean(card.alt), 'Media requires alt text')).min(1)
const mediaTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

export function loadReleaseFeatures(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const folder = realpathSync(resolve(directory, entry.name))
    const cards = cardsSchema.parse(JSON.parse(readFileSync(resolve(folder, 'features.json'), 'utf8')))
    return [entry.name, cards.map(card => {
      if (!card.media) return card
      const path = realpathSync(resolve(folder, card.media))
      const local = relative(folder, path)
      const mime = mediaTypes[extname(path).toLowerCase()]
      if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\') || !mime) {
        throw new Error(`Invalid release media: ${entry.name}/${card.media}`)
      }
      return { ...card, media: `data:${mime};base64,${readFileSync(path).toString('base64')}` }
    })]
  }))
}
