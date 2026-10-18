import { localLocatorId } from '../src/local-locator.ts'
import { describe, expect, it } from 'vitest'
import {
  decodeReferenceUri,
  encodeReferenceUri,
  formatReferenceMention,
  mayContainReference,
  parseReferenceText,
} from '../src/uri.ts'
import { ReferenceAnythingError } from '../src/errors.ts'
import { encodeLegacyReferenceUri } from '../src/uri-codec.ts'

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
  it.each([
    ['web-chat', '', ['chatgpt', 'account-scope', 'conversation-123']],
    ['cloud-drive', 'openlist:', { v: 1, path: `/网盘/${'directory/'.repeat(12)}notes.md` }],
  ])('preserves the exact nested payload of %s', (source, prefix, data) => {
    const ref = { source: source as string, id: `${prefix}${Buffer.from(JSON.stringify(data, null, 2)).toString('base64url')}` }
    expect(decodeReferenceUri(encodeReferenceUri(ref))).toEqual(ref)
    expect(encodeReferenceUri(ref).length).toBeLessThan(encodeLegacyReferenceUri(ref).length)
  })
  it.each(['web-chat', 'cloud-drive', 'local-plugin'])('compresses %s references losslessly and accepts their legacy spelling', source => {
    const ref = { source, id: `${source}:${'项目/long-directory/'.repeat(30)}session-123` }
    const uri = encodeReferenceUri(ref)
    const legacy = encodeLegacyReferenceUri(ref)
    expect(uri).toMatch(/^dsh-ref:z1_/)
    expect(uri.length).toBeLessThan(legacy.length)
    expect(decodeReferenceUri(uri)).toEqual(ref)
    expect(decodeReferenceUri(legacy)).toEqual(ref)
    expect(parseReferenceText(`Read ${uri}`).references[0]?.ref).toEqual(ref)
    expect(parseReferenceText(formatReferenceMention(ref, '会话')).references[0]?.ref).toEqual(ref)
    expect(() => decodeReferenceUri(uri.slice(0, -2))).toThrow()
  })

  it('rejects compressed references with oversized output or trailing bytes', () => {
    const ref = { source: 'web-chat', id: 'repeat/'.repeat(100) }
    const uri = encodeReferenceUri(ref)
    const bytes = Buffer.from(uri.slice('dsh-ref:z1_'.length), 'base64url')
    bytes.writeUInt32BE(0xffffffff, 0)
    expect(() => decodeReferenceUri(`dsh-ref:z1_${bytes.toString('base64url')}`)).toThrow()
    expect(() => decodeReferenceUri(`${uri}AAAA`)).toThrow()
  })
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

it('uses readable local locators and rejects legacy local URIs',()=>{
 const ref={source:'local-agent',id:localLocatorId({source:'codex',path:'C:/用户/a (b).jsonl',sessionId:'s'})}
 expect(decodeReferenceUri(encodeReferenceUri(ref))).toEqual(ref)
 expect(parseReferenceText(formatReferenceMention(ref,'会话')).references[0]?.ref).toEqual(ref)
 expect(()=>decodeReferenceUri(encodeLegacyReferenceUri(ref))).toThrow()
})
