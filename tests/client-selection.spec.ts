import { describe, expect, it } from 'vitest'
import { filterAgentCandidates, filterDriveCandidates } from '../src/client/selection.ts'

describe('picker source selection', () => {
  it('keeps only explicitly selected local agent formats', () => {
    const rows = [
      { id: 'codex:a', label: 'A', provider: 'Codex' },
      { id: 'claude-code:b', label: 'B', provider: 'Claude Code' },
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
