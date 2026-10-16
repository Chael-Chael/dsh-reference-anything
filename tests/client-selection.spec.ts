import { describe, expect, it } from 'vitest'
import { filterAgentCandidates, filterDriveCandidates } from '../src/client/selection.ts'

describe('picker source selection', () => {
  it('keeps scan diagnostics and new import-only formats without bypassing existing source switches', () => {
    const rows = [
      { id: 'scan:a', kind: 'trae', label: 'A', provider: 'Trae', importOnly: true },
      { id: 'scan:b', kind: 'codex', label: 'B', provider: 'Codex', importOnly: true },
      { id: 'warning:0', kind: 'scan-warning', label: 'C', provider: '', warning: 'failed' },
    ]
    expect(filterAgentCandidates(rows, []).map(row => row.id)).toEqual(['warning:0'])
    expect(filterAgentCandidates(rows, ['trae']).map(row => row.id)).toEqual(['scan:a', 'warning:0'])
  })
  it('keeps only explicitly selected local agent formats', () => {
    const rows = [
      { id: 'codex:a', kind: 'codex', label: 'A', provider: 'Codex' },
      { id: 'claude-code:b', kind: 'claude-code', label: 'B', provider: 'Claude Code' },
    ]
    expect(filterAgentCandidates(rows, ['codex']).map(row => row.id)).toEqual(['codex:a'])
    expect(filterAgentCandidates(rows, [])).toEqual([])
    expect(filterAgentCandidates(rows, undefined)).toEqual(rows)
  })

  it('matches OpenList mounts on path boundaries', () => {
    const rows = [
      { id: 'a', label: 'A', provider: 'OpenList', origin: '/work/a.md' },
      { id: 'b', label: 'B', provider: 'OpenList', origin: '/work-2/b.md' },
    ]
    expect(filterDriveCandidates(rows, ['/work']).map(row => row.id)).toEqual(['a'])
    expect(filterDriveCandidates(rows, [])).toEqual([])
    expect(filterDriveCandidates(rows, undefined)).toEqual(rows)
  })
})
