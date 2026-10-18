import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertRelease, digestFiles } from '../scripts/agent/workflow.mjs'

function fixture() {
  const current = { version: '1.0.0', head: 'head', sourceDigest: 'source', buildDigest: 'build', packageHash: 'package' }
  const checks = Object.fromEntries(['browser', 'desktop', 'packageContents', 'cleanInstall', 'upgrade', 'changeReview', 'readme', 'releaseNotes', 'demos', 'redGreen', 'breakCheck', 'ci'].map(name => [name,
    { status: 'PASS', summary: 'Observed expected result', evidence: ['evidence.md'] }]))
  const record = { ...current, schema: 1, package: { sha256: 'package' }, automatic: { check: 'check.log', sync: 'sync.log', pack: 'pack.log' }, checks }
  record.editorialApproval = { status: 'APPROVED', userMessage: 'Approved this final copy (test fixture)', evidence: ['review.md'], sourceDigest: 'source', packageSha256: 'package' }
  return { current, record }
}

describe('release evidence gate', () => {
  it('blocks missing or stale user approval and incomplete publication materials', () => {
    const { current, record } = fixture()
    for (const name of ['readme', 'releaseNotes', 'demos']) {
      const pending = structuredClone(record)
      pending.checks[name].status = 'NOT_RUN'
      expect(() => assertRelease(pending, current, () => true)).toThrow(name)
    }
    for (const change of [{ status: 'PENDING' }, { userMessage: '' }, { evidence: [] }, { sourceDigest: 'old' }, { packageSha256: 'old' }]) {
      const pending = structuredClone(record)
      Object.assign(pending.editorialApproval, change)
      expect(() => assertRelease(pending, current, () => true)).toThrow(/editorial|Editorial/)
    }
  })
  it('accepts completed checks but rejects changes to code, build, HEAD, version or package', () => {
    const { current, record } = fixture()
    expect(() => assertRelease(record, current, () => true)).not.toThrow()
    for (const key of Object.keys(current)) {
      expect(() => assertRelease(record, { ...current, [key]: 'changed' }, () => true)).toThrow()
    }
  })
  it('does not turn missing, skipped or merely written results into acceptance', () => {
    for (const status of ['NOT_RUN', 'BLOCKED', 'FAIL', 'N/A']) {
      const { current, record } = fixture()
      record.checks.browser.status = status
      expect(() => assertRelease(record, current, () => true)).toThrow(/browser/)
    }
    const { current, record } = fixture()
    expect(() => assertRelease(record, current, () => false)).toThrow(/evidence/)
    record.checks.browser.summary = ''
    expect(() => assertRelease(record, current, () => true)).toThrow(/summary/)
  })
  it('requires reasons for conditional checks and automatic results', () => {
    const { current, record } = fixture()
    record.checks.ci = { status: 'N/A', summary: 'No remote PR/CI for this local candidate' }
    expect(() => assertRelease(record, current, () => true)).not.toThrow()
    record.checks.ci.summary = ''
    expect(() => assertRelease(record, current, () => true)).toThrow(/ci/)
    record.automatic.check = ''
    expect(() => assertRelease(record, current, () => true)).toThrow(/Automatic/)
  })
  it('fingerprints content, paths and deletions independently of input ordering', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-workflow-'))
    try {
      writeFileSync(join(directory, 'a'), 'one'); writeFileSync(join(directory, 'b'), 'two')
      const initial = digestFiles(directory, ['a', 'b'])
      expect(digestFiles(directory, ['b', 'a', 'a'])).toBe(initial)
      writeFileSync(join(directory, 'a'), 'changed')
      expect(digestFiles(directory, ['a', 'b'])).not.toBe(initial)
      rmSync(join(directory, 'a'))
      expect(digestFiles(directory, ['a', 'b'])).not.toBe(initial)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
