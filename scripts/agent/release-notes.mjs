import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function releaseNotes(markdown, path, repository, sha) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid release source')
  const base = new URL(path, `https://raw.githubusercontent.com/${repository}/${sha}/`)
  return markdown.replace(/(!\[[^\]]*\]\()([^\s)]+)(\))/g, (match, before, target, after) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return match
    return before + new URL(target, base).href + after
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, repository, sha, output] = process.argv.slice(2)
  writeFileSync(output, releaseNotes(readFileSync(path, 'utf8'), path, repository, sha))
}
