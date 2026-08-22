import path, { posix, win32 } from 'node:path'

type PathDialect = 'posix' | 'win32' | 'native'

function explicitDialect(value: string): PathDialect {
  if (value.startsWith('/')) return 'posix'
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.includes('\\')) return 'win32'
  return 'native'
}

function implementation(dialect: PathDialect): path.PlatformPath {
  if (dialect === 'posix') return posix
  if (dialect === 'win32') return win32
  return path
}

/** Join path segments without changing an explicitly supplied path dialect. */
export function joinLocalPath(base: string, ...segments: string[]): string {
  return implementation(explicitDialect(base)).join(base, ...segments)
}

/** Normalize a path without changing an explicitly supplied path dialect. */
export function normalizeLocalPath(value: string): string {
  return implementation(explicitDialect(value)).normalize(value)
}

/** Whether a path is absolute according to its explicit (or native) dialect. */
export function isAbsoluteLocalPath(value: string): boolean {
  return implementation(explicitDialect(value)).isAbsolute(value)
}

/** Whether a recorded working directory is the workspace or one of its descendants. */
export function inWorkspace(cwd: string, workspace: string): boolean {
  if (cwd === '' || workspace === '') return false

  const cwdDialect = explicitDialect(cwd)
  const workspaceDialect = explicitDialect(workspace)
  if (cwdDialect !== 'native' && workspaceDialect !== 'native' && cwdDialect !== workspaceDialect) return false

  const dialect = cwdDialect !== 'native' ? cwdDialect : workspaceDialect
  const paths = implementation(dialect)
  const normalizedCwd = paths.resolve(cwd)
  const normalizedWorkspace = paths.resolve(workspace)
  const relative = paths.relative(normalizedWorkspace, normalizedCwd)

  return relative === ''
    || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`))
}
