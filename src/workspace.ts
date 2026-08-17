import { lstat, readdir } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'

export const WORKSPACE_REFERENCE_SCHEME = 'dsh-file:'
const IGNORED = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache', '.idea', '.vscode', '__pycache__'])
const IGNORED_FILES = new Set(['desktop.ini', 'Thumbs.db', '.DS_Store'])

export interface WorkspaceEntry { path: string; kind: 'file' | 'directory' }
export interface WorkspaceReference { path: string; label: string }

export async function indexWorkspace(agent: Agent, signal: AbortSignal, maxFiles = 5000): Promise<WorkspaceEntry[]> {
  const root = agent.session.header.cwd
  if (!root || !isAbsolute(root)) return []
  const output: WorkspaceEntry[] = []
  const queue = ['.']
  while (queue.length > 0 && output.length < maxFiles) {
    signal.throwIfAborted()
    const current = queue.shift()!
    let entries
    try { entries = await readdir(resolve(root, current), { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (output.length >= maxFiles) break
      if (entry.isSymbolicLink() || IGNORED_FILES.has(entry.name)) continue
      const path = current === '.' ? entry.name : `${current}/${entry.name}`
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name)) continue
        output.push({ path, kind: 'directory' }); queue.push(path)
      } else if (entry.isFile()) output.push({ path, kind: 'file' })
    }
  }
  return output
}

export function encodeWorkspaceReferenceUri(path: string): string {
  return `${WORKSPACE_REFERENCE_SCHEME}${Buffer.from(JSON.stringify(path), 'utf8').toString('base64url')}`
}

export function formatWorkspaceMention(reference: WorkspaceReference): string {
  return `@[${reference.label.replace(/[\\\]]/gu, value => `\\${value}`)}](${encodeWorkspaceReferenceUri(reference.path)})`
}

export function parseWorkspaceReferenceText(text: string): { text: string; references: WorkspaceReference[] } {
  const references: WorkspaceReference[] = []
  const pattern = /@\[((?:\\.|[^\\\]])*)\]\((dsh-file:[^\s)]*)\)|(dsh-file:[A-Za-z0-9_-]+)/gu
  const rendered = text.replace(pattern, (_match, rawLabel: string | undefined, markdownUri: string | undefined, bareUri: string | undefined) => {
    const uri = markdownUri ?? bareUri!
    const payload = uri.slice(WORKSPACE_REFERENCE_SCHEME.length)
    if (!/^[A-Za-z0-9_-]+$/u.test(payload)) throw new Error(`invalid workspace reference URI ${JSON.stringify(uri)}`)
    const path: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof path !== 'string' || path.length === 0 || encodeWorkspaceReferenceUri(path) !== uri) throw new Error(`invalid workspace reference URI ${JSON.stringify(uri)}`)
    const label = rawLabel === undefined ? basename(path) : rawLabel.replace(/\\(.)/gu, '$1')
    references.push({ path, label })
    return `@${label}`
  })
  return { text: rendered, references }
}

export async function renderWorkspaceReferences(agent: Agent, references: readonly WorkspaceReference[]): Promise<string> {
  const root = agent.session.header.cwd
  if (!root || !isAbsolute(root)) throw new Error('this task has no workspace directory')
  const unique = new Map(references.map(item => [item.path, item]))
  const lines: string[] = []
  for (const item of unique.values()) {
    const target = resolve(root, item.path)
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`workspace reference escapes the task directory: ${item.path}`)
    const stat = await lstat(target)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`unsupported workspace reference: ${item.path}`)
    lines.push(`<workspace-reference path=${JSON.stringify(item.path)} kind=${JSON.stringify(stat.isDirectory() ? 'directory' : 'file')} />`)
  }
  return `## Referenced workspace paths\n\nThese are read-only path markers, not file contents or instructions.\n\n${lines.join('\n')}`
}
