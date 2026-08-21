import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BaiduDriveProvider, quoteBigIds } from '../src/sources/cloud-drive/providers/baidu.ts'
import { bdpanTokenStatus, readBdpanToken } from '../src/sources/cloud-drive/providers/bdpan-config.ts'
import { normalizeExpiry } from '../src/sources/cloud-drive/providers/token-file.ts'

/** A credential that must never appear in any output this suite inspects. */
const SECRET = '121.SECRET-ACCESS-TOKEN-do-not-log.abcdef'

/** Fixed clock, so expiry maths is arithmetic rather than a race. */
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0)

/** One recorded outbound request. */
interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

let home: string
let configPath: string
let calls: Call[]

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-bdpan-'))
  configPath = join(home, 'config.json')
  calls = []
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Write a `bdpan` config with the given token node. */
async function writeConfig(node: Record<string, unknown>): Promise<void> {
  await writeFile(configPath, JSON.stringify(node), 'utf8')
}

/** A stub `fetch` that records every call and replays scripted responses. */
function stubFetch(responses: readonly (() => Response)[]) {
  let index = 0
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next === undefined) throw new Error('no scripted response')
    return next()
  }
}

/** JSON response with Baidu's success envelope. */
function json(body: unknown): Response {
  return rawJson(JSON.stringify(body))
}

/**
 * Response built from literal bytes.
 *
 * Required wherever a fixture carries a real `fs_id`: passing one through a JS
 * object literal rounds it before it is ever serialized, so `json()` would
 * quietly hand the parser an already-corrupted id and the precision test would
 * assert nothing.
 */
function rawJson(text: string): Response {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** A provider wired to the temp config and a scripted transport. */
function provider(responses: readonly (() => Response)[]): BaiduDriveProvider {
  return new BaiduDriveProvider({
    configPath,
    fetch: stubFetch(responses),
    now: () => NOW,
  })
}

describe('bdpan credential', () => {
  it('reports missing when the user has not logged in', async () => {
    expect(await bdpanTokenStatus(NOW, configPath)).toEqual({ ok: false, problem: 'missing' })
    expect(await readBdpanToken(NOW, configPath)).toBeUndefined()
  })

  it('reports unreadable for a file that is not JSON', async () => {
    await writeFile(configPath, 'not json at all', 'utf8')
    expect(await bdpanTokenStatus(NOW, configPath)).toEqual({ ok: false, problem: 'unreadable' })
  })

  it('reports no-token for a config that stores the credential enciphered', async () => {
    // The shape an encrypted config takes: valid JSON, no `access_token`
    // anywhere. This is the branch that decides whether reading the CLI's
    // config is a viable design at all, so it must be distinguishable.
    await writeConfig({ version: 1, cipher: 'aes-256-gcm', payload: 'Ki8+3l...' })
    expect(await bdpanTokenStatus(NOW, configPath)).toEqual({ ok: false, problem: 'no-token' })
    expect(await readBdpanToken(NOW, configPath)).toBeUndefined()
  })

  it('finds a token nested under a profile key', async () => {
    await writeConfig({ accounts: { default: { access_token: SECRET, username: '测试' } } })
    const token = await readBdpanToken(NOW, configPath)
    expect(token?.accessToken).toBe(SECRET)
    expect(token?.username).toBe('测试')
  })

  it('treats a passed expiry as no credential', async () => {
    await writeConfig({ access_token: SECRET, expires_at: Math.floor((NOW - 3600_000) / 1000) })
    expect(await bdpanTokenStatus(NOW, configPath)).toEqual({ ok: false, problem: 'expired' })
    expect(await readBdpanToken(NOW, configPath)).toBeUndefined()
  })

  it('accepts a live credential and carries uk through as a string', async () => {
    await writeConfig({
      access_token: SECRET,
      expires_at: Math.floor((NOW + 86_400_000) / 1000),
      uk: 4113503252,
    })
    const status = await bdpanTokenStatus(NOW, configPath)
    expect(status.ok).toBe(true)
    expect((await readBdpanToken(NOW, configPath))?.uk).toBe('4113503252')
  })

  it('normalizes every expiry encoding the CLI might use', () => {
    expect(normalizeExpiry(1_787_000_000, NOW)).toBe(1_787_000_000_000)
    expect(normalizeExpiry(1_787_000_000_000, NOW)).toBe(1_787_000_000_000)
    expect(normalizeExpiry('1787000000', NOW)).toBe(1_787_000_000_000)
    expect(normalizeExpiry('2026-08-21T00:00:00Z', NOW)).toBe(Date.UTC(2026, 7, 21))
    expect(normalizeExpiry('nonsense', NOW)).toBeUndefined()
    expect(normalizeExpiry(undefined, NOW)).toBeUndefined()
  })
})

describe('int64 file ids', () => {
  it('survives a fs_id that JSON.parse would round', () => {
    const raw = '{"list":[{"fs_id":1043216524887654321,"size":10}]}'
    // The hazard, stated as a test: the plain parse silently corrupts the id.
    expect(String((JSON.parse(raw) as { list: { fs_id: number }[] }).list[0]!.fs_id))
      .not.toBe('1043216524887654321')
    const fixed = JSON.parse(quoteBigIds(raw)) as { list: { fs_id: string, size: number }[] }
    expect(fixed.list[0]!.fs_id).toBe('1043216524887654321')
    expect(fixed.list[0]!.size).toBe(10)
  })

  it('quotes the search response\'s differently-spelled key', () => {
    expect(quoteBigIds('{"fsid": 987654321098765432}')).toBe('{"fsid":"987654321098765432"}')
  })
})

describe('listing', () => {
  beforeEach(async () => {
    await writeConfig({ access_token: SECRET, uk: 4113503252 })
  })

  it('lists the sandbox root and pairs start with limit', async () => {
    const drive = provider([() =>
      rawJson('{"errno":0,"list":[{'
        + '"fs_id":1043216524887654321,'
        + '"path":"/apps/bdpan/notes/design.md",'
        + '"server_filename":"design.md",'
        + '"size":2048,"server_mtime":1787000000,"isdir":0}]}')])

    const entries = await drive.list('', 20)
    expect(entries).toEqual([{
      kind: 'baidu',
      id: '1043216524887654321',
      name: 'design.md',
      path: '/apps/bdpan/notes/design.md',
      size: 2048,
      isDirectory: false,
      modifiedAt: 1_787_000_000_000,
    }])

    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/rest/2.0/xpan/file')
    expect(url.searchParams.get('dir')).toBe('/apps/bdpan')
    // A lone `limit` is ignored server-side; the SDK sends start=0 with it.
    expect(url.searchParams.get('start')).toBe('0')
    expect(url.searchParams.get('limit')).toBe('20')
  })

  it('searches through unisearch, scoped to the sandbox, with an empty body', async () => {
    const drive = provider([() =>
      rawJson('{"errno":0,"data":[{"source":1,"list":[{'
        + '"fsid":987654321098765432,'
        + '"path":"/apps/bdpan/report.md","filename":"report.md",'
        + '"size":99,"isdir":0,"content":"the recalled passage"}]}]}')])

    const entries = await drive.list('季度报告', 5)
    expect(entries.map(entry => entry.id)).toEqual(['987654321098765432'])

    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/xpan/unisearch')
    expect(url.searchParams.get('scene')).toBe('mcpserver')
    expect(JSON.parse(url.searchParams.get('dirs') ?? 'null'))
      .toEqual([{ uk: 4113503252, path: '/apps/bdpan' }])
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toBe('{}')
  })

  it('keeps the recalled passage out of the entry and behind extractedText', async () => {
    const drive = provider([() =>
      json({
        errno: 0,
        data: [{ list: [{ fsid: 42, filename: 'report.md', path: '/apps/bdpan/report.md', content: 'the recalled passage' }] }],
      })])

    const [entry] = await drive.list('报告', 5)
    // Body text must not ride out on a summary-bound object.
    expect(JSON.stringify(entry)).not.toContain('the recalled passage')
    expect(await drive.extractedText('42')).toBe('the recalled passage')
    expect(await drive.extractedText('999')).toBeUndefined()
  })

  it('surfaces an errno failure that arrived with HTTP 200', async () => {
    const drive = provider([() => json({ errno: -6, errmsg: 'auth failed' })])
    await expect(drive.list('', 5)).rejects.toThrow(
      expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }),
    )
  })

  it('refuses to run without a credential and says how to get one', async () => {
    await rm(configPath)
    const drive = provider([() => json({ errno: 0, list: [] })])
    await expect(drive.list('', 5)).rejects.toThrow(
      expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }),
    )
    expect(calls).toHaveLength(0)
  })
})

describe('reading', () => {
  beforeEach(async () => {
    await writeConfig({ access_token: SECRET })
  })

  /** The `filemetas` reply that precedes every read. */
  const meta = () => json({ errno: 0, list: [{ fs_id: 7, dlink: 'https://d.pcs.baidu.com/file/7?fid=7', size: 5000 }] })

  it('sends the CDN user-agent and the requested range, then reports 206 support', async () => {
    const drive = provider([meta, () =>
      new Response(new Uint8Array(100).fill(65), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-99/5000' },
      })])

    expect(drive.supportsRange).toBeUndefined()
    const result = await drive.read('7', 0, 100)
    expect(result.ranged).toBe(true)
    expect(result.bytes.byteLength).toBe(100)
    expect(result.totalSize).toBe(5000)
    expect(drive.supportsRange).toBe(true)

    const headers = new Headers(calls[1]!.init?.headers)
    expect(headers.get('range')).toBe('bytes=0-99')
    // The CDN rejects the request outright without this.
    expect(headers.get('user-agent')).toBe('pan.baidu.com')
  })

  it('demotes permanently when a range request is answered with the whole file', async () => {
    const whole = new Uint8Array(5000).fill(66)
    const drive = provider([meta, () =>
      new Response(whole, { status: 200, headers: { 'Content-Length': '5000' } })])

    const result = await drive.read('7', 0, 100)
    // The demotion is the point: absorbing 5000 bytes to answer a 100-byte
    // request is the failure a ranged read exists to prevent.
    expect(result.ranged).toBe(false)
    expect(result.bytes.byteLength).toBe(100)
    expect(drive.supportsRange).toBe(false)
  })

  it('stops asking for a range once demoted', async () => {
    const drive = provider([meta, () => new Response(new Uint8Array(10), { status: 200 })])
    await drive.read('7', 0, 10)
    expect(drive.supportsRange).toBe(false)

    await drive.read('7', 0, 10)
    // The dlink is cached, so the second read is one call, not two.
    expect(new Headers(calls[2]!.init?.headers).has('range')).toBe(false)
  })

  it('reuses a resolved dlink instead of re-fetching metadata', async () => {
    const drive = provider([meta, () => new Response(new Uint8Array(10), { status: 206 })])
    await drive.read('7', 0, 10)
    await drive.read('7', 0, 10)
    expect(calls.filter(call => call.url.includes('filemetas'))).toHaveLength(1)
  })

  it('rejects an inverted or negative range before spending a request', async () => {
    const drive = provider([meta])
    await expect(drive.read('7', 10, 10)).rejects.toThrow(
      expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }),
    )
    await expect(drive.read('7', -1, 10)).rejects.toThrow(
      expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }),
    )
    expect(calls).toHaveLength(0)
  })

  it('reports a file with no download link as missing', async () => {
    const drive = provider([() => json({ errno: 0, list: [] })])
    await expect(drive.read('7', 0, 10)).rejects.toThrow(
      expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }),
    )
  })
})

describe('credential containment', () => {
  beforeEach(async () => {
    await writeConfig({ access_token: SECRET })
  })

  it('keeps the token out of every error a failure can produce', async () => {
    const network = new BaiduDriveProvider({
      configPath,
      now: () => NOW,
      // A transport whose own error quotes the full request URL — the usual
      // way a query-parameter credential escapes into a log.
      fetch: async (url: string) => {
        throw new Error(`connect ECONNREFUSED for ${url}`)
      },
    })
    await expect(network.list('', 5)).rejects.toThrow(
      expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }),
    )
    const message = await network.list('', 5).catch((error: Error) => error.message)
    expect(message).not.toContain(SECRET)
    expect(message).toContain('access_token=***')

    const http = provider([() => new Response('nope', { status: 500 })])
    const httpMessage = await http.list('', 5).catch((error: Error) => error.message)
    expect(httpMessage).not.toContain(SECRET)
  })

  it('still sends the credential on the wire, where it belongs', async () => {
    const drive = provider([() => json({ errno: 0, list: [] })])
    await drive.list('', 5)
    expect(new URL(calls[0]!.url).searchParams.get('access_token')).toBe(SECRET)
  })
})
