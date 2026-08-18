import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JS adapter modules, shipped to OpenCLI rather than compiled here.
import { timestampSource as chatgptTimestampSource } from '../opencli-plugin/chatgpt.js'
// @ts-expect-error -- plain JS adapter modules, shipped to OpenCLI rather than compiled here.
import { timestampSource as geminiTimestampSource } from '../opencli-plugin/gemini.js'

type NormalizeTimestamp = (value: unknown) => string
const compile = (source: string) => Function(`return (${source})`)() as NormalizeTimestamp

describe('provider timestamp normalization', () => {
  it('accepts ChatGPT ISO timestamps as well as its legacy Unix seconds', () => {
    const timestamp = compile(chatgptTimestampSource)
    expect(timestamp('2026-08-18T07:23:32.970018Z')).toBe('2026-08-18T07:23:32.970Z')
    expect(timestamp(1_776_153_600)).toBe('2026-04-14T08:00:00.000Z')
  })

  it('accepts Gemini second/nanosecond tuples and numeric timestamp units', () => {
    const timestamp = compile(geminiTimestampSource)
    expect(timestamp([1_776_153_600, 123_000_000])).toBe('2026-04-14T08:00:00.123Z')
    expect(timestamp(1_776_153_600_000_000)).toBe('2026-04-14T08:00:00.000Z')
  })

  it('rejects malformed timestamps instead of persisting invalid dates', () => {
    expect(compile(chatgptTimestampSource)('unknown')).toBe('')
    expect(compile(geminiTimestampSource)([])).toBe('')
  })
})
