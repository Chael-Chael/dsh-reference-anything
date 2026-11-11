import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertRelease, copyFiles, digestFiles, reusableCheck } from '../scripts/agent/workflow.mjs'

const REQUIRED = ['browser', 'desktop', 'packageContents', 'cleanInstall', 'changeReview', 'readme', 'releaseNotes', 'demos']
const CONDITIONAL = ['upgrade', 'redGreen', 'breakCheck', 'ci']
const REPORT = ['A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06', 'A-07', 'A-08', 'A-09', 'A-10', 'A-11', 'A-12', 'E-01'].map(id => `| ${id} | PASS |`).join('\n')

function fixture() {
  const current = { version: '1.0.0', head: 'head', sourceDigest: 'source', buildDigest: 'build', packageHash: 'package', copyDigest: 'copy' }
  const checks = Object.fromEntries([...REQUIRED, ...CONDITIONAL].map((name, index) => [name, { status: 'PASS', ref: `A-${String(index + 1).padStart(2, '0')}` }]))
  const record = {
    schema: 2, version: '1.0.0', head: 'head', sourceDigest: 'source', buildDigest: 'build', copyDigest: 'copy',
    package: { sha256: 'package' }, automatic: { check: 'check.log', sync: 'sync.log', pack: 'pack.log' },
    report: 'docs/testing/releases/1.0.0-acceptance-report.md', checks,
    editorialApproval: { status: 'APPROVED', userMessage: 'Approved this final copy (test fixture)', ref: 'E-01', copyDigest: 'copy' },
  }
  return { current, record }
}

describe('release evidence gate', () => {
  it('accepts completed checks but rejects changes to code, build, HEAD, version or package', () => {
    const { current, record } = fixture()
    expect(() => assertRelease(record, current, REPORT)).not.toThrow()
    for (const key of ['version', 'head', 'sourceDigest', 'buildDigest', 'packageHash']) {
      expect(() => assertRelease(record, { ...current, [key]: 'changed' }, REPORT)).toThrow()
    }
  })
  it('keeps an approval while the reviewed copy is unchanged, and drops it when the copy changes', () => {
    const { current, record } = fixture()
    // Code changed after approval: the record is re-prepared, the approval of the same copy still holds.
    const code = { ...current, sourceDigest: 'source-2', buildDigest: 'build-2' }
    expect(() => assertRelease({ ...record, sourceDigest: 'source-2', buildDigest: 'build-2' }, code, REPORT)).not.toThrow()
    expect(() => assertRelease(record, { ...current, copyDigest: 'copy-2' }, REPORT)).toThrow(/review again/)
    for (const change of [{ status: 'PENDING' }, { userMessage: '' }, { ref: '' }, { ref: 'E-99' }]) {
      const pending = structuredClone(record)
      Object.assign(pending.editorialApproval, change)
      expect(() => assertRelease(pending, current, REPORT)).toThrow(/editorial/)
    }
  })
  it('does not turn missing, skipped or unreported results into acceptance', () => {
    for (const status of ['NOT_RUN', 'BLOCKED', 'FAIL', 'N/A']) {
      const { current, record } = fixture()
      record.checks.browser.status = status
      expect(() => assertRelease(record, current, REPORT)).toThrow(/browser/)
    }
    const { current, record } = fixture()
    expect(() => assertRelease(record, current, undefined)).toThrow(/report missing/)
    record.checks.desktop.ref = 'A-99'
    expect(() => assertRelease(record, current, REPORT)).toThrow(/desktop: report has no item A-99/)
    record.checks.desktop.ref = ''
    expect(() => assertRelease(record, current, REPORT)).toThrow(/desktop: report item reference required/)
  })
  it('accepts conditional checks as N/A only with a reason', () => {
    for (const name of CONDITIONAL) {
      const { current, record } = fixture()
      record.checks[name] = { status: 'N/A', reason: 'Settings and storage formats did not change' }
      expect(() => assertRelease(record, current, REPORT)).not.toThrow()
      record.checks[name].reason = ''
      expect(() => assertRelease(record, current, REPORT)).toThrow(new RegExp(name))
    }
    const { current, record } = fixture()
    record.automatic.check = ''
    expect(() => assertRelease(record, current, REPORT)).toThrow(/Automatic/)
  })
  it('reuses a passing check only for the exact same candidate and build', () => {
    const last = { head: 'h', sourceDigest: 's', buildDigest: 'b', check: 'check.log' }
    expect(reusableCheck(last, { head: 'h', sourceDigest: 's', buildDigest: 'b' })).toBe(last)
    for (const key of ['head', 'sourceDigest', 'buildDigest']) {
      expect(reusableCheck(last, { head: 'h', sourceDigest: 's', buildDigest: 'b', [key]: 'other' })).toBeUndefined()
    }
    expect(reusableCheck(undefined, { head: 'h', sourceDigest: 's', buildDigest: 'b' })).toBeUndefined()
  })
  it('binds the editorial review to README, release folder and README images only', () => {
    expect(copyFiles(['README.md', 'README_zh-CN.md', 'docs/release/1.0.0/README.md', 'docs/release/1.0.0/demos/a.gif',
      'docs/release/0.9.0/README.md', 'images/hero.png', 'src/index.ts', 'docs/development/workflow.md'], '1.0.0'))
      .toEqual(['README.md', 'README_zh-CN.md', 'docs/release/1.0.0/README.md', 'docs/release/1.0.0/demos/a.gif', 'images/hero.png'])
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
