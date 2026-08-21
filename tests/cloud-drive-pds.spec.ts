import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PdsDriveProvider } from '../src/sources/cloud-drive/providers/pds.ts'
import { pdsTokenStatus, readPdsToken } from '../src/sources/cloud-drive/providers/pds-config.ts'

/** A credential that must never appear in any output this suite inspects. */
const SECRET = 'PDS-SECRET-ACCESS-TOKEN-do-not-log.abcdef'

/** Fixed clock, so expiry maths is arithmetic rather than a race. */
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0)

/** The tenant used throughout; also what the endpoint template is built from. */
const DOMAIN = 'bj1234'
const ENDPOINT = `https://${DOMAIN}.api.aliyunpds.com`
const DRIVE = '9999'

/** One recorded outbound request. */
interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

let home: string
let configPath: string
let calls: Call[]

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-pds-'))
  configPath = join(home, 'pds_config.json')
  calls = []
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Write an `aliyun pds` config holding one profile. */
async function writeConfig(profile: Record<string, unknown>, current = 'default'): Promise<void> {
  await writeFile(
    configPath,
    JSON.stringify({ current, profiles: [{ name: 'default', domain_id: DOMAIN, ...profile }] }),
    'utf8',
  )
}

/** A live credential, unless a test overrides part of it. */
async function writeLiveConfig(extra: Record<string, unknown> = {}): Promise<void> {
  await writeConfig({
    access_token: SECRET,
    user_id: 'user-1',
    nick_name: '测试',
    created_at: Math.floor(NOW / 1000),
    expires_in: 7200,
    ...extra,
  })
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

/** JSON response with an ok status. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The `/drive/get_default_drive` reply every networked test starts with. */
function defaultDrive(): Response {
  return json({ drive_id: DRIVE, drive_name: 'Default' })
}

/** A provider wired to the temp config and a scripted transport. */
function provider(
  responses: readonly (() => Response)[],
  root?: string,
): PdsDriveProvider {
  return new PdsDriveProvider({
    configPath,
    fetch: stubFetch(responses),
    now: () => NOW,
    ...(root === undefined ? {} : { root }),
  })
}

/** Parse the JSON body a recorded call sent. */
function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>
}

describe('pds credential', () => {
  it('reports missing when the user has not logged in', async () => {
    expect(await pdsTokenStatus(NOW, configPath)).toEqual({ ok: false, problem: 'missing' })
    expect(await readPdsToken(NOW, configPath)).toBeUndefined()
  })

  it('reports unreadable for a file that is not JSON', async () => {
    await writeFile(configPath, 'not json at all', 'utf8')
    expect(await pdsTokenStatus(NOW, configPath)).toEqual({ ok: false, problem: 'unreadable' })
  })

  it('reports no-profile for a config that has never been configured', async () => {
    await writeFile(configPath, JSON.stringify({ current: '', profiles: [] }), 'utf8')
    expect(await pdsTokenStatus(NOW, configPath)).toEqual({ ok: false, problem: 'no-profile' })
  })

  it('reports no-token for a profile that carries no credential', async () => {
    await writeConfig({ user_id: 'user-1' })
    expect(await pdsTokenStatus(NOW, configPath)).toEqual({ ok: false, problem: 'no-token' })
    expect(await readPdsToken(NOW, configPath)).toBeUndefined()
  })

  it('reports no-endpoint when neither an endpoint nor a domain is stated', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ current: 'default', profiles: [{ name: 'default', access_token: SECRET }] }),
      'utf8',
    )
    expect(await pdsTokenStatus(NOW, configPath)).toEqual({ ok: false, problem: 'no-endpoint' })
  })

  it('derives the public endpoint from the domain id', async () => {
    await writeLiveConfig()
    expect((await readPdsToken(NOW, configPath))?.endpoint).toBe(ENDPOINT)
  })

  it('prefers a stated endpoint, normalizing scheme and trailing slash', async () => {
    await writeLiveConfig({ endpoint: 'pds.internal.example.com/' })
    expect((await readPdsToken(NOW, configPath))?.endpoint).toBe('https://pds.internal.example.com')
  })

  it('computes expiry from created_at plus expires_in', async () => {
    // The shape actually on disk: PDS records a mint time and a lifetime, not
    // an instant, so a reader that looks only for `expires_at` finds nothing
    // and treats a dead credential as live.
    await writeLiveConfig({ created_at: Math.floor((NOW - 7200_000) / 1000), expires_in: 7200 })
    expect(await pdsTokenStatus(NOW, configPath)).toEqual({ ok: false, problem: 'expired' })
    expect(await readPdsToken(NOW, configPath)).toBeUndefined()
  })

  it('does not mistake a lifetime for a millisecond instant', async () => {
    // 7200 read as milliseconds would expire the token seven seconds after it
    // was minted, i.e. always.
    await writeLiveConfig()
    const status = await pdsTokenStatus(NOW, configPath)
    expect(status.ok).toBe(true)
    expect(status.ok && status.expiresAt).toBe(NOW + 7200_000)
  })

  it('selects the profile named by current, not merely the first', async () => {
    await writeFile(configPath, JSON.stringify({
      current: 'work',
      profiles: [
        { name: 'personal', domain_id: 'other', access_token: 'WRONG-TOKEN' },
        { name: 'work', domain_id: DOMAIN, access_token: SECRET, nick_name: '工作' },
      ],
    }), 'utf8')
    const token = await readPdsToken(NOW, configPath)
    expect(token?.accessToken).toBe(SECRET)
    expect(token?.nickName).toBe('工作')
  })

  it('falls back to the first profile when current names none', async () => {
    await writeFile(configPath, JSON.stringify({
      current: 'deleted',
      profiles: [{ name: 'personal', domain_id: DOMAIN, access_token: SECRET }],
    }), 'utf8')
    expect((await readPdsToken(NOW, configPath))?.accessToken).toBe(SECRET)
  })

  it('never returns the secret from the status call', async () => {
    await writeLiveConfig()
    expect(JSON.stringify(await pdsTokenStatus(NOW, configPath))).not.toContain(SECRET)
  })
})

describe('pds availability', () => {
  it('is uncredentialed without a config and makes no request', async () => {
    const drive = provider([])
    expect(await drive.credentialed()).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('is credentialed from disk alone, with no network call', async () => {
    await writeLiveConfig()
    const drive = provider([])
    expect(await drive.credentialed()).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('explains how to log in rather than failing opaquely', async () => {
    const drive = provider([defaultDrive])
    await expect(drive.list('', 10)).rejects.toThrow(
      expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }),
    )
  })
})

describe('pds listing', () => {
  it('resolves the default drive once and lists the drive root', async () => {
    await writeLiveConfig()
    const drive = provider([
      defaultDrive,
      () => json({
        items: [
          {
            drive_id: DRIVE,
            file_id: 'f1',
            parent_file_id: 'root',
            name: 'notes.md',
            size: 120,
            type: 'file',
            updated_at: '2026-08-19T10:00:00.000Z',
          },
        ],
      }),
      () => json({ items: [] }),
    ])

    const first = await drive.list('', 10)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      kind: 'pds',
      id: `${DRIVE}/f1`,
      name: 'notes.md',
      path: '/notes.md',
      size: 120,
      isDirectory: false,
      modifiedAt: Date.parse('2026-08-19T10:00:00.000Z'),
    })

    await drive.list('', 10)
    // Three calls, not four: the default drive is account state, resolved once.
    expect(calls).toHaveLength(3)
    expect(calls.filter(call => call.url.endsWith('/drive/get_default_drive'))).toHaveLength(1)
  })

  it('posts to the versioned data plane and authorizes with a bearer header', async () => {
    await writeLiveConfig()
    const drive = provider([defaultDrive, () => json({ items: [] })])
    await drive.list('', 10)

    const listing = calls[1]
    expect(listing?.url).toBe(`${ENDPOINT}/v2/file/list`)
    expect(listing?.init?.method).toBe('POST')
    const headers = listing?.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${SECRET}`)
    // The credential is a header on this API, so it must never reach the URL.
    expect(calls.every(call => !call.url.includes(SECRET))).toBe(true)
  })

  it('searches by name when the user has typed something', async () => {
    await writeLiveConfig()
    const drive = provider([defaultDrive, () => json({ items: [] })])
    await drive.list('  budget ', 5)

    const search = calls[1]
    expect(search?.url).toBe(`${ENDPOINT}/v2/file/search`)
    expect(bodyOf(search!)).toMatchObject({ drive_id: DRIVE, query: 'name match "budget"' })
  })

  it('strips quotes out of a search term rather than emitting a broken filter', async () => {
    await writeLiveConfig()
    const drive = provider([defaultDrive, () => json({ items: [] })])
    await drive.list('say "hi" \\ now', 5)
    expect(bodyOf(calls[1]!)['query']).toBe('name match "say hi  now"')
  })

  it('never lets a signed download_url escape onto an entry', async () => {
    await writeLiveConfig()
    const signed = 'https://cdn.example.com/f1?Signature=SECRET-SIGNATURE&Expires=1'
    const drive = provider([
      defaultDrive,
      () => json({
        items: [{ drive_id: DRIVE, file_id: 'f1', name: 'notes.md', size: 1, type: 'file', download_url: signed }],
      }),
    ])
    const entries = await drive.list('', 10)
    expect(entries).toHaveLength(1)
    // The whole hazard: PDS puts a live signed URL on every listing row, and an
    // entry becomes a ReferenceSummary that travels to the client.
    expect(JSON.stringify(entries)).not.toContain('Signature')
    expect(JSON.stringify(entries)).not.toContain('cdn.example.com')
  })

  it('resolves an absolute root through get_by_path, once', async () => {
    await writeLiveConfig()
    const drive = provider([
      defaultDrive,
      () => json({ file_id: 'folder-7', name: 'reports', type: 'folder' }),
      () => json({ items: [] }),
    ], '/work/reports')

    await drive.list('', 10)
    expect(calls[1]?.url).toBe(`${ENDPOINT}/v2/file/get_by_path`)
    expect(bodyOf(calls[1]!)).toMatchObject({ drive_id: DRIVE, file_path: '/work/reports' })
    expect(bodyOf(calls[2]!)).toMatchObject({ parent_file_id: 'folder-7' })
  })

  it('treats a non-path root as a folder id verbatim', async () => {
    await writeLiveConfig()
    const drive = provider([defaultDrive, () => json({ items: [] })], 'folder-42')
    await drive.list('', 10)
    expect(calls[1]?.url).toBe(`${ENDPOINT}/v2/file/list`)
    expect(bodyOf(calls[1]!)).toMatchObject({ parent_file_id: 'folder-42' })
  })

  it('composes a display path from folders it has already seen', async () => {
    await writeLiveConfig()
    const drive = provider([
      defaultDrive,
      () => json({
        items: [{ drive_id: DRIVE, file_id: 'dir1', parent_file_id: 'root', name: '报告', type: 'folder' }],
      }),
      () => json({
        items: [
          { drive_id: DRIVE, file_id: 'f2', parent_file_id: 'dir1', name: 'q3.md', size: 4, type: 'file' },
          { drive_id: DRIVE, file_id: 'f3', parent_file_id: 'unseen', name: 'q4.md', size: 4, type: 'file' },
        ],
      }),
    ])
    await drive.list('', 10)
    const hits = await drive.list('q', 10)
    expect(hits[0]?.path).toBe('/报告/q3.md')
    // An unknown ancestor is admitted as unknown rather than guessed at.
    expect(hits[1]?.path).toBe('…/q4.md')
  })

  it('maps an expired credential response back to a login instruction', async () => {
    await writeLiveConfig()
    const drive = provider([
      defaultDrive,
      () => json({ code: 'AccessTokenInvalid', message: 'AccessToken is invalid' }, 401),
    ])
    await expect(drive.list('', 10)).rejects.toThrow(
      expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }),
    )
  })
})

describe('pds reading', () => {
  /** A provider that has already listed one file, so reads start warm. */
  async function warm(rest: readonly (() => Response)[]): Promise<PdsDriveProvider> {
    await writeLiveConfig()
    return provider([
      defaultDrive,
      () => json({
        items: [{ drive_id: DRIVE, file_id: 'f1', parent_file_id: 'root', name: 'notes.md', size: 11, type: 'file' }],
      }),
      ...rest,
    ])
  }

  it('honours a 206 and reports the range as served', async () => {
    const drive = await warm([
      () => json({ url: 'https://cdn.example.com/f1?sig=1', size: 11, expiration: '2026-08-20T13:00:00.000Z' }),
      () => new Response('llo', {
        status: 206,
        headers: { 'Content-Range': 'bytes 2-4/11' },
      }),
    ])
    await drive.list('', 10)

    const result = await drive.read(`${DRIVE}/f1`, 2, 5)
    expect(new TextDecoder().decode(result.bytes)).toBe('llo')
    expect(result.ranged).toBe(true)
    expect(result.totalSize).toBe(11)
    expect(drive.supportsRange).toBe(true)

    const download = calls.at(-1)
    expect((download?.init?.headers as Record<string, string>)['Range']).toBe('bytes=2-4')
  })

  it('demotes permanently when the storage answers 200 to a range request', async () => {
    const drive = await warm([
      () => json({ url: 'https://cdn.example.com/f1?sig=1', size: 11 }),
      () => new Response('hello world', { status: 200, headers: { 'Content-Length': '11' } }),
      () => new Response('hello world', { status: 200, headers: { 'Content-Length': '11' } }),
    ])
    await drive.list('', 10)

    const first = await drive.read(`${DRIVE}/f1`, 2, 5)
    expect(first.ranged).toBe(false)
    // The window is still honoured: the caller asked for [2, 5) and gets it,
    // sliced out of a body that was capped at `end` rather than fully buffered.
    expect(new TextDecoder().decode(first.bytes)).toBe('llo')
    expect(drive.supportsRange).toBe(false)

    await drive.read(`${DRIVE}/f1`, 0, 5)
    // Once demoted, no later read wastes a Range header on a server that
    // ignores it.
    expect((calls.at(-1)?.init?.headers as Record<string, string> | undefined)?.['Range']).toBeUndefined()
  })

  it('reuses one download URL across reads and keeps it off every entry', async () => {
    const drive = await warm([
      () => json({ url: 'https://cdn.example.com/f1?sig=1', size: 11, expiration: '2026-08-20T13:00:00.000Z' }),
      () => new Response('he', { status: 206, headers: { 'Content-Range': 'bytes 0-1/11' } }),
      () => new Response('ll', { status: 206, headers: { 'Content-Range': 'bytes 2-3/11' } }),
    ])
    const entries = await drive.list('', 10)
    await drive.read(`${DRIVE}/f1`, 0, 2)
    await drive.read(`${DRIVE}/f1`, 2, 4)

    expect(calls.filter(call => call.url.endsWith('/v2/file/get_download_url'))).toHaveLength(1)
    expect(JSON.stringify(entries)).not.toContain('sig=1')
  })

  it('requests a short-lived URL rather than the maximum the API allows', async () => {
    const drive = await warm([
      () => json({ url: 'https://cdn.example.com/f1?sig=1', size: 11 }),
      () => new Response('h', { status: 206, headers: { 'Content-Range': 'bytes 0-0/11' } }),
    ])
    await drive.list('', 10)
    await drive.read(`${DRIVE}/f1`, 0, 1)
    const request = calls.find(call => call.url.endsWith('/v2/file/get_download_url'))
    expect(bodyOf(request!)['expire_sec']).toBe(900)
  })

  it('rejects an inverted range before reaching the network', async () => {
    await writeLiveConfig()
    const drive = provider([])
    await expect(drive.read(`${DRIVE}/f1`, 5, 5)).rejects.toThrow(
      expect.objectContaining({ code: 'REFERENCE_READ_FAILED' }),
    )
    expect(calls).toHaveLength(0)
  })

  it('falls back to the default drive for a reference that carries no drive id', async () => {
    const drive = await warm([
      () => json({ url: 'https://cdn.example.com/f1?sig=1', size: 4 }),
      () => new Response('abcd', { status: 206, headers: { 'Content-Range': 'bytes 0-3/4' } }),
    ])
    await drive.list('', 10)
    const result = await drive.read('f1', 0, 4)
    expect(result.ranged).toBe(true)
    expect(bodyOf(calls.find(call => call.url.endsWith('/v2/file/get_download_url'))!))
      .toMatchObject({ drive_id: DRIVE, file_id: 'f1' })
  })

  it('reports a missing file as not found rather than a read failure', async () => {
    await writeLiveConfig()
    const drive = provider([
      defaultDrive,
      () => json({ code: 'NotFound.File', message: 'The resource does not exist' }, 404),
    ])
    expect(await drive.describe(`${DRIVE}/gone`)).toBeUndefined()
  })

  it('has no server-extracted text tier', async () => {
    await writeLiveConfig()
    expect(await provider([]).extractedText()).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('keeps the credential and the signature out of a network failure message', async () => {
    await writeLiveConfig()
    const drive = new PdsDriveProvider({
      configPath,
      now: () => NOW,
      fetch: async (url: string) => {
        calls.push({ url, init: undefined })
        throw new Error(`connect ECONNREFUSED for ${url}?token=${SECRET}&Signature=abc`)
      },
    })
    const error = await drive.list('', 10).catch((cause: unknown) => cause)
    const text = String(error)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('Signature')
    expect(text).toContain('/drive/get_default_drive')
  })
})
