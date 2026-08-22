import { describe, expect, it } from 'vitest'
import { inWorkspace, joinLocalPath } from '../src/sources/local-agent/path.ts'
import { AGENT_ADAPTERS, expandRoot } from '../src/sources/local-agent/registry.ts'

describe('local-agent path dialects', () => {
  it('preserves an explicitly POSIX home on every host platform', () => {
    expect(joinLocalPath('/home/u', '.codex', 'sessions')).toBe('/home/u/.codex/sessions')
    expect(expandRoot('~/.codex/sessions', '/home/u')).toBe('/home/u/.codex/sessions')
    for (const adapter of AGENT_ADAPTERS) {
      for (const root of adapter.defaultRoots('/home/u')) expect(root.startsWith('/home/u/')).toBe(true)
    }
  })

  it('preserves an explicitly Windows home on every host platform', () => {
    expect(joinLocalPath('C:\\Users\\u', '.codex', 'sessions')).toBe('C:\\Users\\u\\.codex\\sessions')
    expect(expandRoot('~/.codex/sessions', 'C:\\Users\\u')).toBe('C:\\Users\\u\\.codex\\sessions')
    for (const adapter of AGENT_ADAPTERS) {
      for (const root of adapter.defaultRoots('C:\\Users\\u')) expect(root.startsWith('C:\\Users\\u\\')).toBe(true)
    }
  })

  it('accepts the workspace itself and descendants in either explicit dialect', () => {
    expect(inWorkspace('/w/app', '/w/app')).toBe(true)
    expect(inWorkspace('/w/app/src/../test', '/w/app')).toBe(true)
    expect(inWorkspace('C:\\work\\app', 'C:\\work\\app')).toBe(true)
    expect(inWorkspace('C:\\work\\app\\src', 'C:\\work\\app\\.')).toBe(true)
  })

  it('rejects siblings, traversal, different dialects, and different Windows volumes', () => {
    expect(inWorkspace('/w/application', '/w/app')).toBe(false)
    expect(inWorkspace('/w/app/../secret', '/w/app')).toBe(false)
    expect(inWorkspace('C:\\work\\application', 'C:\\work\\app')).toBe(false)
    expect(inWorkspace('C:\\work\\app', '/work/app')).toBe(false)
    expect(inWorkspace('D:\\work\\app', 'C:\\work\\app')).toBe(false)
  })
})
