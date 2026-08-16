import { describe, expect, it } from 'vitest'
import {
  decodeReferenceUri,
  encodeReferenceUri,
  formatReferenceMention,
  mayContainReference,
  parseReferenceText,
} from '../src/uri.ts'
import { ReferenceAnythingError } from '../src/errors.ts'

const hostile = [
  'plain',
  'with "quotes"',
  'with/slashes\\and\\backslashes',
  'with\nnewline\tand\ttab',
  '中文与全角符号（）',
  'emoji 👩‍👩‍👧‍👦 and astral 𝄞',
  ']bracket[ and (parens)',
  '',
]

describe('reference URIs', () => {
  it.each(hostile)('round-trips source and id containing %j', (value) => {
    const ref = { source: `src ${value}`, id: value }
    expect(decodeReferenceUri(encodeReferenceUri(ref))).toEqual(ref)
  })

  it('rejects a URI whose payload is not canonical', () => {
    // Same bytes, different JSON spelling: without the canonicality check two
    // distinct strings would name one reference and dedup by URI would fail.
    const noncanonical = `dsh-ref:${Buffer.from('{"id":"b","source":"a"}', 'utf8').toString('base64url')}`
    expect(() => decodeReferenceUri(noncanonical)).toThrow(ReferenceAnythingError)
    expect(decodeReferenceUri(encodeReferenceUri({ source: 'a', id: 'b' }))).toEqual({ source: 'a', id: 'b' })
  })

  it.each([
    ['wrong scheme', 'dsh-session:AAAA'],
    ['empty payload', 'dsh-ref:'],
    ['non-base64url payload', 'dsh-ref:not/valid+chars='],
    ['payload that is not JSON', `dsh-ref:${Buffer.from('nope', 'utf8').toString('base64url')}`],
    ['payload that is not an object', `dsh-ref:${Buffer.from('"str"', 'utf8').toString('base64url')}`],
    ['object missing id', `dsh-ref:${Buffer.from('{"source":"a"}', 'utf8').toString('base64url')}`],
  ])('rejects %s', (_label, uri) => {
    expect(() => decodeReferenceUri(uri)).toThrow(ReferenceAnythingError)
  })
})

describe('mention text', () => {
  const ref = { source: 'file', id: 'chat.json' }

  it('replaces a Markdown mention with its readable label', () => {
    const text = `see ${formatReferenceMention(ref, 'Cache design')} for context`
    const parsed = parseReferenceText(text)
    expect(parsed.text).toBe('see @Cache design for context')
    expect(parsed.references).toEqual([{ ref, label: 'Cache design' }])
  })

  it('round-trips a label containing the characters the mention syntax uses', () => {
    const label = 'a ] and a \\ walk in'
    const parsed = parseReferenceText(formatReferenceMention(ref, label))
    expect(parsed.references[0]?.label).toBe(label)
  })

  it('falls back to the id when a mention carries no label', () => {
    expect(formatReferenceMention(ref)).toBe(`@[chat.json](${encodeReferenceUri(ref)})`)
  })

  it('treats a bare canonical URI as a reference', () => {
    const parsed = parseReferenceText(`look at ${encodeReferenceUri(ref)} please`)
    expect(parsed.references).toEqual([{ ref, label: 'chat.json' }])
    expect(parsed.text).toBe('look at @chat.json please')
  })

  it('leaves the bare scheme alone so writing about it references nothing', () => {
    for (const text of ['the dsh-ref: scheme', 'dsh-ref:', 'what is dsh-ref:?']) {
      expect(parseReferenceText(text)).toEqual({ text, references: [] })
    }
  })

  it('fails an explicit mention whose URI is malformed rather than passing it through', () => {
    expect(() => parseReferenceText('@[label](dsh-ref:!!!)')).toThrow(ReferenceAnythingError)
  })

  it('keeps first-appearance order across several mentions', () => {
    const other = { source: 'file', id: 'other.json' }
    const parsed = parseReferenceText(
      `${formatReferenceMention(other, 'B')} then ${formatReferenceMention(ref, 'A')}`,
    )
    expect(parsed.references.map(entry => entry.ref.id)).toEqual(['other.json', 'chat.json'])
  })

  it('screens text with a substring test before parsing', () => {
    expect(mayContainReference('nothing here')).toBe(false)
    expect(mayContainReference(`x ${encodeReferenceUri(ref)}`)).toBe(true)
  })
})
