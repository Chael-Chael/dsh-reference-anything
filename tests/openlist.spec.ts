import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { PathLike } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ReferenceAnythingError } from '../src/errors.ts'
import { totalFromResponse } from '../src/sources/cloud-drive/providers/http.ts'
import { isGlobalUnicastIPv6, OpenListDriveProvider, pinnedRawRequest, validateRawDownloadUrl } from '../src/sources/cloud-drive/providers/openlist.ts'
import { decodeDriveId, encodeDriveId, normalizeOpenListPath } from '../src/sources/cloud-drive/registry.ts'
import { authenticateOpenList, installOpenList, ManagedOpenListRuntime, OpenListHostClient, OPENLIST_FIXED_VERSION, OPENLIST_RELEASE, parseRandomAdminPassword, recoverInterruptedReplacement, selectOpenListAsset, validateOpenListEndpoint, verifyOpenListAsset, writeManagedOpenListConfig, writeOpenListCredentials } from '../src/openlist/host.ts'
import { OpenListService, repairRecoveryCredentials } from '../src/openlist/index.ts'

describe('OpenList drive reference ids', () => {
  it('uses a versioned base64url JSON payload and normalizes absolute paths', () => {
    const id = encodeDriveId('openlist', '//notes/./plan.md')
    expect(id).toMatch(/^openlist:[A-Za-z0-9_-]+$/)
    expect(decodeDriveId(id)).toEqual({ kind: 'openlist', fileId: '/notes/plan.md' })
  })
  it('rejects traversal, malformed IDs, and gives a migration error for legacy IDs', () => {
    expect(() => normalizeOpenListPath('/safe/../secret')).toThrow(/traversal/)
    expect(() => decodeDriveId('openlist:bad+payload')).toThrow(expect.objectContaining({ code: 'REFERENCE_INVALID_URI' }))
    expect(() => decodeDriveId('baidu:123')).toThrow(/旧版百度网盘/)
    expect(() => decodeDriveId('pds:x/y')).toThrow(/OpenList/)
  })
})

describe('OpenList provider', () => {
  it('does not mistake a 206 Content-Length for the complete file size', () => {
    expect(totalFromResponse(new Response('ab', { status: 206, headers: { 'content-length': '2' } }))).toBeUndefined()
    expect(totalFromResponse(new Response('ab', { status: 206, headers: { 'content-range': 'bytes 0-1/4' } }))).toBe(4)
    expect(totalFromResponse(new Response('ab', { status: 206, headers: { 'content-range': 'garbage/2' } }))).toBeUndefined()
    expect(totalFromResponse(new Response('ab', { status: 206, headers: { 'content-range': 'bytes 0-2/2' } }))).toBeUndefined()
    expect(totalFromResponse(new Response('ab', { status: 200, headers: { 'content-length': '2' } }))).toBe(2)
  })
  it('blocks raw-download SSRF targets and DNS rebinding while allowing public provider hosts', async () => {
    const publicDns = async () => [{ address: '93.184.216.34' }]
    await expect(validateRawDownloadUrl('https://provider.example/file', publicDns)).resolves.toMatchObject({ hostname: 'provider.example' })
    for (const target of ['http://localhost/file', 'http://10.0.0.1/file', 'http://192.168.1.1/file', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/file', 'http://[fd00::1]/file', 'http://[::ffff:7f00:1]/file', 'file:///etc/passwd']) {
      const failure = await validateRawDownloadUrl(target, publicDns).catch(error => error)
      expect(failure).toBeInstanceOf(ReferenceAnythingError)
      expect(String(failure)).not.toContain(target)
    }
    await expect(validateRawDownloadUrl('https://public.example/file', async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }])).rejects.toThrow(/rejected/)
  })
  it('uses a conservative global-unicast IPv6 policy', () => {
    for (const address of ['::', '::1', '::7f00:1', '::a00:1', '::a9fe:a9fe', '100::1', '0100:0000:0000:0000::1', '5f00::1', '3fff::1', '2001:2::1', '2001:0002:0000::1', '2001:4:112::1', '2001:db8::1', '2001:0db8::1', '2001:10::1', 'fc00::1', 'fec0::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '64:ff9b::127.0.0.1', '2002:7f00:1::1']) expect(isGlobalUnicastIPv6(address)).toBe(false)
    expect(isGlobalUnicastIPv6('2001:4860:4860::8888')).toBe(true)
    expect(isGlobalUnicastIPv6('2606:4700:4700::1111')).toBe(true)
  })
  it('allows HTTP raw only on the exact trusted loopback origin', async () => {
    const loopbackDns = async () => [{ address: '127.0.0.1' }]
    await expect(validateRawDownloadUrl('http://127.0.0.1:5244/p/file', loopbackDns, 'http://127.0.0.1:5244')).resolves.toMatchObject({ pathname: '/p/file' })
    await expect(validateRawDownloadUrl('http://127.0.0.1:5245/p/file', loopbackDns, 'http://127.0.0.1:5244')).rejects.toThrow(/rejected/)
    await expect(validateRawDownloadUrl('http://127.0.0.1:5244/p/file', loopbackDns, 'https://openlist.example')).rejects.toThrow(/rejected/)
  })
  it('revalidates every raw redirect before following it', async () => {
    const calls: string[] = []
    const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'x', resolveHost: async () => [{ address: '93.184.216.34' }], fetch: async url => {
      calls.push(String(url))
      if (String(url).endsWith('/api/fs/get')) return json({ code: 200, data: { name: 'x.md', raw_url: 'https://public.example/file' } })
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
    } })
    await expect(provider.read('/x.md', 0, 8)).rejects.toThrow(/raw download failed/)
    expect(calls).not.toContain('http://169.254.169.254/latest')
  })
  it('rejects an HTTPS redirect downgrade even when it targets the trusted loopback origin', async () => {
    let raw = 0
    const provider = new OpenListDriveProvider({ endpoint: 'http://127.0.0.1:5244', token: 'x', resolveHost: async hostname => [{ address: hostname === '127.0.0.1' ? '127.0.0.1' : '93.184.216.34' }], rawRequest: async () => { raw += 1; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:5244/p/file' } }) }, fetch: async () => json({ code: 200, data: { name: 'x.md', raw_url: 'https://public.example/file' } }) })
    await expect(provider.read('/x.md', 0, 2)).rejects.toThrow(/raw download failed/)
    expect(raw).toBe(1)
  })
  it('pins the validated DNS address while preserving the original Host and TLS name', async () => {
    const pinned: { host: string, address: string }[] = []
    const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'x', resolveHost: async () => [{ address: '93.184.216.34' }], rawRequest: async (url, address) => { pinned.push({ host: url.hostname, address }); return new Response('ok', { status: 206 }) }, fetch: async url => {
      if (String(url).endsWith('/api/fs/get')) return json({ code: 200, data: { name: 'x.md', raw_url: 'https://provider.example/file' } })
      throw new Error('ordinary raw fetch (and its potentially rebound DNS) must not run')
    } })
    await expect(provider.read('/x.md', 0, 2)).resolves.toMatchObject({ ranged: true })
    expect(pinned).toEqual([{ host: 'provider.example', address: '93.184.216.34' }])
  })
  it('fails over validated DNS answers without re-resolving', async () => {
    const resolutions = vi.fn(async () => [{ address: '93.184.216.1' }, { address: '93.184.216.2' }]); const attempts: string[] = []
    const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'x', resolveHost: resolutions, rawRequest: async (_url, address) => { attempts.push(address); if (attempts.length === 1) throw new Error('connect failed'); return new Response('ok', { status: 206 }) }, fetch: async url => json({ code: 200, data: { name: 'x.md', raw_url: 'https://provider.example/file' } }) })
    await expect(provider.read('/x.md', 0, 2)).resolves.toMatchObject({ ranged: true })
    expect(resolutions).toHaveBeenCalledOnce(); expect(attempts).toEqual(['93.184.216.1', '93.184.216.2'])
  })
  it('rejects malicious upstream statuses without an uncaught callback exception', async () => {
    const sockets = new Set<import('node:net').Socket>()
    const server = createTcpServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.end('HTTP/1.1 700 Evil\r\nContent-Length: 0\r\n\r\n') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing test address')
    const uncaught: unknown[] = []; const onUncaught = (error: unknown) => { uncaught.push(error) }; process.once('uncaughtException', onUncaught)
    try {
      await expect(pinnedRawRequest(new URL(`http://provider.example:${address.port}/file`), '127.0.0.1', {})).rejects.toThrow(/invalid upstream status/)
      await new Promise(resolve => setImmediate(resolve)); expect(uncaught).toEqual([])
    } finally {
      process.removeListener('uncaughtException', onUncaught)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('surfaces an upstream body abort after accepting valid response headers', async () => {
    const sockets = new Set<import('node:net').Socket>()
    const server = createTcpServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nok') })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing test address')
      const response = await pinnedRawRequest(new URL(`http://provider.example:${address.port}/file`), '127.0.0.1', {})
      await expect(response.arrayBuffer()).rejects.toThrow()
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('keeps raw URLs inside the provider, follows them only to read, and sends Range', async () => {
    const calls: { url: string, init?: RequestInit }[] = []
    const provider = new OpenListDriveProvider({ endpoint: 'http://127.0.0.1:5244', token: 'raw-token', fetch: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/api/fs/list')) return json({ code: 200, data: { content: [{ name: 'plan.md', size: 9, is_dir: false }] } })
      if (url.endsWith('/api/fs/get')) return json({ code: 200, data: { name: 'plan.md', size: 9, raw_url: 'https://download.example.test/secret?token=never-leak' } })
      return new Response('contents', { status: 206, headers: { 'content-range': 'bytes 0-7/9' } })
    } })
    const [entry] = await provider.list('', 10)
    expect(entry?.id).toBe('/plan.md')
    expect(JSON.stringify(entry)).not.toContain('download.example')
    const result = await provider.read('/plan.md', 0, 8)
    expect(new TextDecoder().decode(result.bytes)).toBe('contents')
    expect(calls.at(-1)?.url).toContain('token=never-leak')
    expect(new Headers(calls.at(-1)?.init?.headers).get('range')).toBe('bytes=0-7')
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('raw-token')
  })

  it('falls back to a bounded directory walk when search backend fails', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/fs/search')) return new Response('{"code":500,"message":"search not available: index none"}', { status: 500 })
      const body = JSON.parse(String(init?.body)) as { path: string }
      const content = body.path === '/'
        ? [{ name: 'docs', is_dir: true }, { name: 'other.md', is_dir: false }]
        : [{ name: 'needle.md', is_dir: false }]
      return json({ code: 200, data: { content } })
    })
    const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'private', fetch, walkDirectories: 2 })
    const results = await provider.list('needle', 10)
    expect(results.map(row => row.name)).toEqual(['needle.md'])
    expect(results).toMatchObject([{ searchIncomplete: true }])
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('does not mark indexed search or ordinary directory listings incomplete', async () => {
    const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'private', fetch: async () => json({ code: 200, data: { content: [{ name: 'needle.md', is_dir: false }] } }) })
    expect((await provider.list('needle', 10))[0]).not.toHaveProperty('searchIncomplete')
    expect((await provider.list('', 10))[0]).not.toHaveProperty('searchIncomplete')
  })
  it('treats an empty HTTP 500 search response as an unavailable index', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/api/fs/search') ? new Response('', { status: 500 }) : json({ code: 200, data: { content: [{ name: 'needle.md', is_dir: false }] } }))
    const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'private', fetch, walkDirectories: 1 })
    expect((await provider.list('needle', 1))[0]?.name).toBe('needle.md')
  })
  it('does not turn search authentication or network failures into partial walk results', async () => {
    for (const response of [new Response('expired', { status: 401 }), new Response('server failure', { status: 500 })]) {
      const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'private', fetch: async () => response.clone() })
      await expect(provider.list('needle', 10)).rejects.toThrow(/API (?:request )?failed/)
    }
  })
  it('rejects remote HTTP endpoints before any provider request', () => {
    expect(() => new OpenListDriveProvider({ endpoint: 'http://openlist.example.test', token: 'x' })).toThrow(/require HTTPS/)
  })
  it('uses a search hit parent to make a nested absolute path', async () => {
    const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'x', fetch: async () => json({ code: 200, data: { content: [{ parent: '/nested', name: 'file.md', is_dir: false }] } }) })
    expect((await provider.list('file', 1))[0]?.id).toBe('/nested/file.md')
  })
  it('redacts a failed refreshed raw download', async () => {
    let call = 0
    const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'x', fetch: async (url) => {
      call += 1
      if (String(url).endsWith('/api/fs/get')) return json({ code: 200, data: { name: 'x.md', raw_url: `https://secret.example/${call}` } })
      if (call === 2) return new Response('', { status: 403 })
      throw new Error('https://secret.example/leaked')
    } })
    const error = await provider.read('/x.md', 0, 2).then(() => undefined, reason => reason as Error)
    expect(error?.message).toContain('raw download failed'); expect(error?.message).not.toContain('secret.example')
  })
  it('cancels raw error bodies before refreshing or throwing', async () => {
    const cancelled = vi.fn(); let rawAttempt = 0
    const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'x', resolveHost: async () => [{ address: '93.184.216.34' }], rawRequest: async () => {
      rawAttempt += 1
      if (rawAttempt === 1) return new Response(new ReadableStream({ cancel: cancelled }), { status: 401 })
      return new Response(new ReadableStream({ cancel: cancelled }), { status: 500 })
    }, fetch: async () => json({ code: 200, data: { name: 'x.md', raw_url: `https://provider.example/${rawAttempt}` } }) })
    await expect(provider.read('/x.md', 0, 2)).rejects.toThrow(/HTTP 500/)
    expect(cancelled).toHaveBeenCalledTimes(2)
  })
  it('records when a raw endpoint ignores Range without buffering beyond the request', async () => {
    const provider = new OpenListDriveProvider({ endpoint: 'http://localhost:5244', token: 'x', fetch: async url => String(url).endsWith('/api/fs/get') ? json({ code: 200, data: { name: 'x.md', raw_url: 'https://download.test/x' } }) : new Response('much-more-than-requested', { status: 200 }) })
    const result = await provider.read('/x.md', 0, 4)
    expect(result.ranged).toBe(false); expect(result.bytes.byteLength).toBe(4); expect(provider.supportsRange).toBe(false)
  })
  it('exchanges external credentials for a raw token before filesystem calls', async () => {
    const calls: { url: string, init?: RequestInit }[] = []
    const token = await authenticateOpenList('https://openlist.example.test', 'admin', 'password', async (url, init) => {
      calls.push({ url: String(url), init }); return json({ code: 200, data: { token: 'opaque-token' } })
    })
    expect(token).toBe('opaque-token')
    expect(calls[0]?.url).toBe('https://openlist.example.test/api/auth/login')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ username: 'admin', password: 'password' }))
  })
  it('refreshes manager credentials on every operation and forgets stale tokens after disconnect', async () => {
    let credentials: { endpoint: string, token: string } | undefined = { endpoint: 'http://localhost:5244', token: 'first' }
    const calls: string[] = []
    const provider = new OpenListDriveProvider({ credentials: async () => credentials, fetch: async (_url, init) => {
      calls.push(String(new Headers(init?.headers).get('authorization')))
      return json({ code: 200, data: { content: [] } })
    } })
    expect(await provider.credentialed()).toBe(true)
    await provider.list('', 1)
    credentials = undefined
    expect(await provider.credentialed()).toBe(false)
    await expect(provider.list('', 1)).rejects.toThrow(/not connected/)
    credentials = { endpoint: 'http://localhost:5244', token: 'rotated' }
    await provider.list('', 1)
    expect(calls).toEqual(['first', 'rotated'])
  })
  it('refreshes a managed JWT after a filesystem 401 and retries once', async () => {
    const authorization: string[] = []; const refreshes: boolean[] = []
    const provider = new OpenListDriveProvider({ credentials: async refresh => { refreshes.push(refresh === true); return { endpoint: 'http://localhost:5244', token: refresh ? 'fresh' : 'expired', mode: 'managed' } }, fetch: async (_url, init) => {
      const token = new Headers(init?.headers).get('authorization') ?? ''; authorization.push(token)
      return token === 'expired' ? new Response('', { status: 401 }) : json({ code: 200, data: { content: [] } })
    } })
    await expect(provider.list('', 10)).resolves.toEqual([])
    expect(authorization).toEqual(['expired', 'fresh'])
    expect(refreshes).toEqual([false, true])
  })
  it('refreshes a managed JWT for an official HTTP-200 code-401 filesystem envelope', async () => {
    const authorization: string[] = []
    const provider = new OpenListDriveProvider({ credentials: async refresh => ({ endpoint: 'http://localhost:5244', token: refresh ? 'fresh' : 'expired', mode: 'managed' }), fetch: async (_url, init) => {
      const token = new Headers(init?.headers).get('authorization') ?? ''; authorization.push(token)
      return token === 'expired' ? json({ code: 401, message: 'token expired' }) : json({ code: 200, data: { content: [] } })
    } })
    await expect(provider.list('', 10)).resolves.toEqual([])
    expect(authorization).toEqual(['expired', 'fresh'])
  })
  it('classifies post-refresh search and not-found responses exactly like primary responses', async () => {
    let calls = 0
    const search = new OpenListDriveProvider({ credentials: async refresh => ({ endpoint: 'http://localhost:5244', token: refresh ? 'fresh' : 'expired' }), fetch: async (_url, init) => {
      calls += 1
      if (calls === 1) return json({ code: 401, message: 'expired' })
      if (calls === 2) return new Response('', { status: 500 })
      return json({ code: 200, data: { content: [{ name: 'needle.md', is_dir: false }] } })
    }, walkDirectories: 1 })
    expect((await search.list('needle', 1))[0]?.name).toBe('needle.md')
    let describeCalls = 0
    const missing = new OpenListDriveProvider({ credentials: async refresh => ({ endpoint: 'http://localhost:5244', token: refresh ? 'fresh' : 'expired' }), fetch: async () => ++describeCalls === 1 ? json({ code: 401 }) : new Response('', { status: 404 }) })
    await expect(missing.describe('/missing.md')).resolves.toBeUndefined()
  })
})

describe('OpenList host controls', () => {
  it('requires HTTPS for remote endpoints but permits loopback HTTP', () => {
    expect(validateOpenListEndpoint('http://localhost:5244')).toBe('http://localhost:5244')
    expect(() => validateOpenListEndpoint('http://openlist.example.test')).toThrow(/require HTTPS/)
    expect(() => validateOpenListEndpoint('https://a:b@openlist.example.test')).toThrow(/credentials/)
  })
  it('uses only SHA-256 assets and intentionally fails closed without a hash', () => {
    const bytes = new TextEncoder().encode('verified binary')
    const hash = createHash('sha256').update(bytes).digest('hex')
    expect(verifyOpenListAsset(bytes, hash)).toBe(true)
    expect(selectOpenListAsset({ version: OPENLIST_FIXED_VERSION, assets: [{ platform: 'win32', arch: 'x64', url: 'https://example.test/openlist', sha256: hash, archive: 'zip', binary: 'openlist.exe' }] }, 'win32', 'x64').sha256).toBe(hash)
    expect(() => selectOpenListAsset({ version: OPENLIST_FIXED_VERSION, assets: [{ platform: 'win32', arch: 'x64', url: 'https://example.test/openlist', sha256: 'md5', archive: 'zip', binary: 'openlist.exe' }] }, 'win32', 'x64')).toThrow(/SHA-256/)
  })
  it('ships six pinned official v4.2.2 assets without a latest URL', () => {
    expect(OPENLIST_RELEASE.assets).toHaveLength(6)
    expect(OPENLIST_RELEASE.assets.map(asset => `${asset.platform}/${asset.arch}`)).toEqual(['win32/x64', 'win32/arm64', 'linux/x64', 'linux/arm64', 'darwin/x64', 'darwin/arm64'])
    for (const asset of OPENLIST_RELEASE.assets) { expect(asset.url).toContain('/v4.2.2/'); expect(asset.url).not.toContain('latest'); expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/) }
  })
  it('installs only bytes that match an injected SHA-256 manifest', async () => {
    const executable = new TextEncoder().encode('verified binary'); const bytes = zip('openlist.exe', executable)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const writeFile = vi.fn(async () => undefined)
    await expect(installOpenList('/tmp/openlist', { version: OPENLIST_FIXED_VERSION, assets: [{ platform: 'win32', arch: 'x64', url: 'https://example.test/openlist', sha256: hash, archive: 'zip', binary: 'openlist.exe' }] }, {
      fetch: async () => new Response(bytes as unknown as BodyInit), mkdir: async () => undefined, writeFile, chmod: async () => undefined, securePermissions: async () => undefined,
    }, 'win32', 'x64')).resolves.toMatchObject({ version: OPENLIST_FIXED_VERSION })
    expect(writeFile).toHaveBeenCalledTimes(2) // executable plus durable recovery marker
  })
  it('restores the previous executable when the atomic replacement rename fails', async () => {
    const executable = new TextEncoder().encode('verified binary'); const bytes = zip('openlist.exe', executable); const hash = createHash('sha256').update(bytes).digest('hex'); const moves: string[][] = []
    await expect(installOpenList('/tmp/openlist', { version: OPENLIST_FIXED_VERSION, assets: [{ platform: 'win32', arch: 'x64', url: 'https://example.test/openlist', sha256: hash, archive: 'zip', binary: 'openlist.exe' }] }, {
      fetch: async () => new Response(bytes as unknown as BodyInit), mkdir: async () => undefined, writeFile: async () => undefined, fsyncFile: async () => undefined, chmod: async () => undefined, securePermissions: async () => undefined, unlink: async () => undefined,
      rename: async (from, to) => { moves.push([String(from), String(to)]); if (moves.length === 2) throw new Error('interrupted') },
    }, 'win32', 'x64')).rejects.toThrow(/atomically install/)
    expect(moves).toHaveLength(3); expect(moves[2]![0]).toContain('replacement-backup'); expect(moves[2]![1]).toMatch(/openlist\.exe$/)
  })
  it('installs a POSIX executable as owner-only executable mode 0700', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlist-mode-'))
    try {
      const executable = new TextEncoder().encode('verified binary'); const bytes = zip('openlist', executable); const hash = createHash('sha256').update(bytes).digest('hex')
      const modes: Array<[string, number]> = []
      const installed = await installOpenList(root, { version: OPENLIST_FIXED_VERSION, assets: [{ platform: 'linux', arch: 'x64', url: 'https://example.test/openlist', sha256: hash, archive: 'zip', binary: 'openlist' }] }, { fetch: async () => new Response(bytes as unknown as BodyInit), chmod: async (path, mode) => { modes.push([String(path), Number(mode)]); await import('node:fs/promises').then(fs => fs.chmod(path, mode)) } }, 'linux', 'x64')
      expect(modes.some(([path, mode]) => path.includes('.openlist-') && mode === 0o700)).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('recovers a Windows executable missing after an interrupted two-move replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlist-recover-')); const target = join(root, 'openlist.exe'); const backup = join(root, '.openlist.exe.replacement-backup'); const marker = join(root, '.openlist.exe.replacement-pending')
    try {
      await writeFile(backup, 'known-good'); await writeFile(marker, 'pending')
      await recoverInterruptedReplacement(target, backup, marker, {}, true)
      expect(await readFile(target, 'utf8')).toBe('known-good')
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('does not recover marker and backup owned by a live Windows replacement transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlist-live-replace-'))
    try {
      const directory = join(root, 'bin', OPENLIST_FIXED_VERSION); const target = join(directory, 'openlist.exe')
      const backup = join(directory, '.openlist.exe.replacement-backup'); const marker = join(directory, '.openlist.exe.replacement-pending')
      await mkdir(directory, { recursive: true }); await writeFile(target, 'old-binary')
      const executable = new TextEncoder().encode('new-binary'); const archive = zip('openlist.exe', executable); const hash = createHash('sha256').update(archive).digest('hex')
      const transaction = await installOpenList(root, { version: OPENLIST_FIXED_VERSION, assets: [{ platform: 'win32', arch: 'x64', url: 'https://example.test/openlist', sha256: hash, archive: 'zip', binary: 'openlist.exe' }] }, { fetch: async () => new Response(archive as unknown as BodyInit), securePermissions: async () => undefined }, 'win32', 'x64', undefined, true)
      expect(await readFile(target, 'utf8')).toBe('new-binary')
      expect(await readFile(backup, 'utf8')).toBe('old-binary')
      expect(await readFile(marker, 'utf8')).toBe('pending')

      await recoverInterruptedReplacement(target, backup, marker, {}, true)
      expect(await readFile(target, 'utf8')).toBe('new-binary')
      expect(await readFile(backup, 'utf8')).toBe('old-binary')
      expect(await readFile(marker, 'utf8')).toBe('pending')

      await transaction.finish(true)
      await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(target, 'utf8')).toBe('new-binary')

      const rollback = await installOpenList(root, { version: OPENLIST_FIXED_VERSION, assets: [{ platform: 'win32', arch: 'x64', url: 'https://example.test/openlist', sha256: hash, archive: 'zip', binary: 'openlist.exe' }] }, { fetch: async () => new Response(archive as unknown as BodyInit), securePermissions: async () => undefined }, 'win32', 'x64', undefined, true)
      await recoverInterruptedReplacement(target, backup, marker, {}, true)
      await rollback.finish(false)
      expect(await readFile(target, 'utf8')).toBe('new-binary')
      await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('keeps the rollback backup when Windows commit-marker cleanup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlist-marker-failure-'))
    try {
      const directory = join(root, 'bin', OPENLIST_FIXED_VERSION); const target = join(directory, 'openlist.exe')
      const marker = join(directory, '.openlist.exe.replacement-pending')
      await mkdir(directory, { recursive: true }); await writeFile(target, 'old-binary')
      const archive = zip('openlist.exe', new TextEncoder().encode('new-binary')); const hash = createHash('sha256').update(archive).digest('hex')
      let failMarkerOnce = true
      const transaction = await installOpenList(root, { version: OPENLIST_FIXED_VERSION, assets: [{ platform: 'win32', arch: 'x64', url: 'https://example.test/openlist', sha256: hash, archive: 'zip', binary: 'openlist.exe' }] }, {
        fetch: async () => new Response(archive as unknown as BodyInit), securePermissions: async () => undefined,
        unlink: async path => {
          if (String(path) === marker && failMarkerOnce) { failMarkerOnce = false; throw new Error('marker is locked') }
          await unlink(path)
        },
      }, 'win32', 'x64', undefined, true)

      await expect(transaction.finish(true)).rejects.toThrow(/finalize/)
      // A recovery probe in the same process must not steal this still-live
      // transaction after its commit point failed.
      await recoverInterruptedReplacement(target, join(directory, '.openlist.exe.replacement-backup'), marker, {}, true)
      await expect(transaction.finish(false)).resolves.toBeUndefined()
      expect(await readFile(target, 'utf8')).toBe('old-binary')
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('commits durably before best-effort Windows backup cleanup and removes the stale backup later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlist-backup-cleanup-'))
    try {
      const directory = join(root, 'bin', OPENLIST_FIXED_VERSION); const target = join(directory, 'openlist.exe')
      const backup = join(directory, '.openlist.exe.replacement-backup'); const marker = join(directory, '.openlist.exe.replacement-pending')
      await mkdir(directory, { recursive: true }); await writeFile(target, 'old-binary')
      const archive = zip('openlist.exe', new TextEncoder().encode('new-binary')); const hash = createHash('sha256').update(archive).digest('hex')
      let markerRemoved = false; let failBackupOnce = true
      const transaction = await installOpenList(root, { version: OPENLIST_FIXED_VERSION, assets: [{ platform: 'win32', arch: 'x64', url: 'https://example.test/openlist', sha256: hash, archive: 'zip', binary: 'openlist.exe' }] }, {
        fetch: async () => new Response(archive as unknown as BodyInit), securePermissions: async () => undefined,
        unlink: async path => {
          if (String(path) === backup && markerRemoved && failBackupOnce) { failBackupOnce = false; throw new Error('backup is locked') }
          await unlink(path)
          if (String(path) === marker) markerRemoved = true
        },
      }, 'win32', 'x64', undefined, true)

      await expect(transaction.finish(true)).resolves.toBeUndefined()
      expect(await readFile(target, 'utf8')).toBe('new-binary')
      expect(await readFile(backup, 'utf8')).toBe('old-binary')
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      await transaction.finish(false)
      expect(await readFile(target, 'utf8')).toBe('new-binary')

      await recoverInterruptedReplacement(target, backup, marker, {}, true)
      await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(target, 'utf8')).toBe('new-binary')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('returns sanitized mount shapes and never exposes authorization', async () => {
    const client = new OpenListHostClient({ endpoint: 'http://127.0.0.1:5244', token: 'do-not-leak' }, { fetch: async () => json({ code: 200, data: { content: [{ id: 4, name: 'disk', driver: 'S3', disabled: false, password: 'secret' }] } }) })
    const rows = await client.mounts()
    expect(rows).toEqual([{ id: '4', name: 'disk', driver: 'S3', enabled: true, status: 'error', error: 'OpenList storage needs attention' }])
    expect(JSON.stringify(rows)).not.toContain('secret')
  })
  it('rejects an authenticated non-admin identity without exposing it', async () => {
    const client = new OpenListHostClient({ endpoint: 'https://openlist.example', token: 'private-token' }, { fetch: async () => json({ code: 200, data: { id: 9, username: 'private-user', role: 'user' } }) })
    await expect(client.connect()).rejects.toThrow(/administrator access/)
  })
  it('reports external credentials as failed when authenticated health is offline', async () => {
    const service = new OpenListService(new Context(), { fetch: async () => { throw new Error('offline private-token') } })
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'https://openlist.example', token: 'private-token', mode: 'external' }
    const status = await service.status()
    expect(status).toMatchObject({ state: 'failed', mode: 'external', error: 'External OpenList connection failed' })
    expect(JSON.stringify(status)).not.toContain('private-token')
  })
  it('semantically distinguishes older, current, and newer managed versions', async () => {
    const statusFor = async (version: string) => {
      const service = new OpenListService(new Context())
      ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'http://127.0.0.1:5244', token: 'private', mode: 'managed', version }
      ;(service as unknown as { runtime: unknown }).runtime = { running: true }
      ;(service as unknown as { installedVersions(): Promise<string[]> }).installedVersions = async () => ['v4.1.0', version]
      return service.status()
    }
    await expect(statusFor('v4.1.0')).resolves.toMatchObject({ state: 'upgrade', upgradeAvailable: true, newerVersion: false })
    await expect(statusFor(OPENLIST_FIXED_VERSION)).resolves.toMatchObject({ state: 'running', upgradeAvailable: false, newerVersion: false })
    await expect(statusFor('v5.0.0')).resolves.toMatchObject({ state: 'failed', upgradeAvailable: false, newerVersion: true, error: 'Managed OpenList version is newer than the supported version' })
  })
  it('keeps an admin endpoint failure coherent in status until both admin views recover', async () => {
    let driversFail = true
    const service = new OpenListService(new Context(), { fetch: async url => {
      if (String(url).endsWith('/api/me')) return json({ code: 200, data: { id: 1, role: 2 } })
      if (String(url).endsWith('/driver/list') && driversFail) throw new Error('offline')
      return json({ code: 200, data: { content: [] } })
    } })
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'https://openlist.example', token: 'private-token', mode: 'external' }
    await expect(service.drivers()).rejects.toThrow(/driver\/list failed/)
    await service.mounts()
    expect(await service.status()).toMatchObject({ state: 'failed', error: 'OpenList connection failed' })
    driversFail = false; await service.drivers(); await service.mounts()
    expect(await service.status()).toMatchObject({ state: 'running' })
  })
  it('treats only the exact OpenList status work as ready', async () => {
    const client = new OpenListHostClient({ endpoint: 'http://127.0.0.1:5244', token: 'secret' }, { fetch: async () => json({ code: 200, data: { content: [{ id: 1, mount_path: '/ok', driver: 'Demo', status: 'work' }, { id: 2, mount_path: '/not-ok', driver: 'Demo', status: 'WORK' }, { id: 3, mount_path: '/blank', driver: 'Demo', status: '' }, { id: 4, mount_path: '/missing', driver: 'Demo' }] } }) })
    expect(await client.mounts()).toEqual([
      { id: '1', name: '/ok', driver: 'Demo', enabled: true, status: 'ready' },
      { id: '2', name: '/not-ok', driver: 'Demo', enabled: true, status: 'error', error: 'OpenList storage needs attention' },
      { id: '3', name: '/blank', driver: 'Demo', enabled: true, status: 'error', error: 'OpenList storage needs attention' },
      { id: '4', name: '/missing', driver: 'Demo', enabled: true, status: 'error', error: 'OpenList storage needs attention' },
    ])
  })
  it('parses the official v4 object-keyed driver and storage shapes without exposing additions', async () => {
    const client = new OpenListHostClient({ endpoint: 'http://127.0.0.1:5244', token: 'secret' }, { fetch: async url => String(url).endsWith('/driver/list')
      ? json({ code: 200, data: { Demo: { common: [{ name: 'mount_path', type: 'string', required: true }], config: { name: 'Demo', local_sort: true }, additional: [{ name: 'token', type: 'password', required: true }, { name: 'region', type: 'select', options: 'cn,us', default: 'cn' }, { name: 'use_proxy', type: 'bool', default: 'false' }, { name: 'limit', type: 'number', default: '25' }] } } })
      : json({ code: 200, data: { content: [{ id: 3, mount_path: '/demo', driver: 'Demo', status: 'token expired: secret must not escape', mount_details: { used_space: 4, total_space: 10 }, addition: '{"token":"secret"}' }] } }) })
    expect(await client.driverInfo()).toEqual([{ name: 'Demo', quickAuth: false, fields: [{ name: 'token', label: 'token', type: 'password', secret: true, required: true }, { name: 'region', label: 'region', type: 'select', secret: false, required: false, default: 'cn', options: [{ label: 'cn', value: 'cn' }, { label: 'us', value: 'us' }] }, { name: 'use_proxy', label: 'use_proxy', type: 'boolean', secret: false, required: false, default: false }, { name: 'limit', label: 'limit', type: 'number', secret: false, required: false, default: 25 }] }])
    const mounts = await client.mounts()
    expect(mounts).toEqual([{ id: '3', name: '/demo', driver: 'Demo', enabled: true, status: 'error', error: 'OpenList storage needs attention', capacityUsed: 4, capacityTotal: 10 }])
    expect(JSON.stringify(mounts)).not.toContain('token expired')
  })
  it('uses the v4.2.2 admin methods, raw token, and documented storage fields', async () => {
    const calls: { url: string, init?: RequestInit }[] = []
    const client = new OpenListHostClient({ endpoint: 'http://127.0.0.1:5244', token: 'token' }, { fetch: async (url, init) => { calls.push({ url: String(url), init }); return json({ code: 200, data: { id: 1 } }) } })
    await client.connect(); await client.drivers(); await client.mounts(); await client.createMount({ mountPath: '/disk', driver: 'Local', addition: { root_folder_path: '/' } }); await client.removeMount('1'); await client.disableMount('1'); await client.disableMount('1', false)
    expect(calls.map(call => [call.url, call.init?.method])).toEqual([
      ['http://127.0.0.1:5244/api/me', 'GET'], ['http://127.0.0.1:5244/api/admin/driver/list', 'GET'], ['http://127.0.0.1:5244/api/admin/storage/list', 'GET'], ['http://127.0.0.1:5244/api/admin/index/progress', 'GET'], ['http://127.0.0.1:5244/api/admin/storage/create', 'POST'], ['http://127.0.0.1:5244/api/admin/storage/delete?id=1', 'POST'], ['http://127.0.0.1:5244/api/admin/storage/disable?id=1', 'POST'], ['http://127.0.0.1:5244/api/admin/storage/enable?id=1', 'POST'],
    ])
    expect(new Headers(calls[4]?.init?.headers).get('authorization')).toBe('token')
    expect(JSON.parse(String(calls[4]?.init?.body))).toMatchObject({ mount_path: '/disk', driver: 'Local', addition: JSON.stringify({ root_folder_path: '/' }) })
    await client.updateMount('7', { mountPath: '/changed', driver: 'Local', addition: {} }); expect(JSON.parse(String(calls[8]?.init?.body))).toMatchObject({ id: 7, mount_path: '/changed', addition: '{}' })
    await expect(client.updateMount('not-a-number', { mountPath: '/changed', driver: 'Local', addition: {} })).rejects.toThrow(/storage id/)
    await expect(client.reindexMount()).resolves.toEqual({ supported: true })
    expect(calls.at(-1)).toMatchObject({ url: 'http://127.0.0.1:5244/api/admin/index/build', init: { method: 'POST' } })
    expect(calls.at(-1)?.init?.body).toBeUndefined()
  })
  it('marks only the curated API Pages providers as quick-auth capable', async () => {
    const names = ['OneDrive', 'AliyundriveOpen', 'BaiduNetdisk', 'Quark', '115 Cloud', '123Pan', 'Dropbox', 'GoogleDrive', 'Google Photo', 'YandexDisk', 'OAuth-looking experimental']
    const client = new OpenListHostClient({ endpoint: 'http://localhost:5244', token: 'admin' }, { fetch: async () => json({ code: 200, data: Object.fromEntries(names.map(name => [name, { additional: [{ name: 'refresh_token', type: 'string' }] }])) }) })
    const drivers = await client.driverInfo()
    expect(drivers.filter(driver => driver.quickAuth).map(driver => driver.name)).toEqual(names.slice(0, -1))
    expect(drivers.at(-1)).toMatchObject({ name: 'OAuth-looking experimental', quickAuth: false })
  })
  it('uses local web proxy only for new managed mounts and preserves it on reauth', async () => {
    const managedCalls: Record<string, unknown>[] = []; const externalCalls: Record<string, unknown>[] = []
    const responder = (calls: Record<string, unknown>[]) => async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/driver/list')) return json({ code: 200, data: { Demo: { additional: [{ name: 'token', type: 'string', required: true }] } } })
      if (String(url).endsWith('/storage/list')) return json({ code: 200, data: { content: [{ id: 7, mount_path: '/keep', driver: 'Demo', addition: '{"token":"old"}', web_proxy: true }] } })
      if (init?.body) calls.push(JSON.parse(String(init.body))); return json({ code: 200, data: { id: 1 } })
    }
    const managed = new OpenListService(new Context(), { fetch: responder(managedCalls) as typeof fetch }); (managed as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'http://localhost:5244', token: 'admin', mode: 'managed', version: OPENLIST_FIXED_VERSION }
    const external = new OpenListService(new Context(), { fetch: responder(externalCalls) as typeof fetch }); (external as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'https://openlist.example', token: 'admin', mode: 'external' }
    await managed.createMount({ mountPath: '/new', driver: 'Demo', addition: { token: 'x' } }); await external.createMount({ mountPath: '/new', driver: 'Demo', addition: { token: 'x' } }); await managed.createMount({ id: '7', mountPath: '/ignored', driver: 'Demo', addition: { token: 'new' } })
    expect(managedCalls.find(call => call.mount_path === '/new')).toMatchObject({ web_proxy: true }); expect(externalCalls.find(call => call.mount_path === '/new')).not.toHaveProperty('web_proxy'); expect(managedCalls.find(call => call.id === 7)).toMatchObject({ web_proxy: true })
  })
  it('uses official index settings, update, build and progress APIs without leaking server errors', async () => {
    const calls: { url: string, body?: unknown }[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
      if (String(url).includes('/setting/get')) return json({ code: 200, data: [{ key: 'search_index', value: 'none', type: 'select' }, { key: 'auto_update_index', value: 'false', type: 'bool' }] })
      if (String(url).endsWith('/index/progress')) return json({ code: 200, data: { obj_count: 42, is_done: false, error: '' } })
      if (String(url).endsWith('/storage/list')) return json({ code: 200, data: { content: [{ id: 1, mount_path: '/disk', driver: 'Demo', status: 'work' }] } })
      return json({ code: 200, data: {} })
    })
    const client = new OpenListHostClient({ endpoint: 'http://localhost:5244', token: 'admin' }, { fetch: fetch as typeof globalThis.fetch })
    await client.configureManagedIndex(); await client.updateIndex('/disk'); await client.reindexMount(); const mounts = await client.mounts()
    expect(calls.find(call => call.url.endsWith('/setting/save'))?.body).toEqual([{ key: 'search_index', value: 'database', type: 'select' }, { key: 'auto_update_index', value: 'true', type: 'bool' }])
    expect(calls.find(call => call.url.endsWith('/index/update'))?.body).toEqual({ paths: ['/disk'], max_depth: 20 })
    expect(calls.find(call => call.url.endsWith('/index/build'))?.body).toBeUndefined()
    expect(mounts).toEqual([{ id: '1', name: '/disk', driver: 'Demo', enabled: true, status: 'ready', indexStatus: 'running', indexCount: 42, indexProgress: 0 }])
  })
  it('treats the official index-already-running response as supported and redacts its message', async () => {
    const client = new OpenListHostClient({ endpoint: 'http://localhost:5244', token: 'private-token' }, { fetch: async () => new Response(JSON.stringify({ code: 400, message: 'index is running private-token' }), { status: 400, headers: { 'content-type': 'application/json' } }) })
    const result = await client.reindexMount('1')
    expect(result).toEqual({ supported: true }); expect(JSON.stringify(result)).not.toContain('private-token')
  })
  it('infers official string credential fields as secret and recognizes all numeric type families', async () => {
    const client = new OpenListHostClient({ endpoint: 'http://localhost:5244', token: 'admin' }, { fetch: async () => json({ code: 200, data: { '115': { additional: [{ name: 'access_token', type: 'string', required: true }, { name: 'refresh_token', type: 'string', required: true }, { name: 'private_key', type: 'string', default: 'must-not-cross' }, { name: 'accessKey', type: 'string', default: 'must-not-cross' }, { name: 'key_file', type: 'string', default: 'must-not-cross' }, { name: 'passphrase', type: 'string', default: 'must-not-cross' }, { name: 'salt', type: 'string', default: 'must-not-cross' }, ...['repoPwd', 'share_pwd', 'sign_key', 'credit_key', 'captcha_sign', 'receive_code'].map(name => ({ name, type: 'string', default: 'must-not-cross' })), { name: 'part_size', type: 'int64', default: '64' }, { name: 'ratio', type: 'float32', default: '1.5' }] } } }) })
    expect(await client.driverInfo()).toEqual([{ name: '115', quickAuth: true, fields: [
      { name: 'access_token', label: 'access_token', type: 'text', secret: true, required: true },
      { name: 'refresh_token', label: 'refresh_token', type: 'text', secret: true, required: true },
      { name: 'private_key', label: 'private_key', type: 'text', secret: true, required: false, hasDefault: true },
      { name: 'accessKey', label: 'accessKey', type: 'text', secret: true, required: false, hasDefault: true },
      { name: 'key_file', label: 'key_file', type: 'text', secret: true, required: false, hasDefault: true },
      { name: 'passphrase', label: 'passphrase', type: 'text', secret: true, required: false, hasDefault: true },
      { name: 'salt', label: 'salt', type: 'text', secret: true, required: false, hasDefault: true },
      ...['repoPwd', 'share_pwd', 'sign_key', 'credit_key', 'captcha_sign', 'receive_code'].map(name => ({ name, label: name, type: 'text' as const, secret: true, required: false, hasDefault: true })),
      { name: 'part_size', label: 'part_size', type: 'number', secret: false, required: false, default: 64 },
      { name: 'ratio', label: 'ratio', type: 'number', secret: false, required: false, default: 1.5 },
    ] }])
  })
  it('keeps required secret defaults Host-only for official Google Photo, Halal, and Thunder fixtures', async () => {
    const fixtures = {
      'Google Photo': { additional: [{ name: 'refresh_token', type: 'string', required: true, default: 'google-private' }] },
      Halal: { additional: [{ name: 'authorization', type: 'string', required: true, default: 'halal-private' }] },
      Thunder: { additional: [{ name: 'captcha_token', type: 'string', required: true, default: 'thunder-private' }] },
    }
    let created: Record<string, unknown> | undefined
    const service = new OpenListService(new Context(), { fetch: async (url, init) => {
      if (String(url).endsWith('/api/admin/driver/list')) return json({ code: 200, data: fixtures })
      if (String(url).endsWith('/api/admin/storage/create')) { created = JSON.parse(String(init?.body)); return json({ code: 200, data: { id: 1 } }) }
      return json({ code: 200, data: {} })
    } })
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'http://localhost:5244', token: 'admin', mode: 'external' }
    const drivers = await service.drivers()
    expect(drivers.map(driver => driver.fields[0])).toEqual([
      expect.objectContaining({ name: 'refresh_token', secret: true, required: true, hasDefault: true }),
      expect.objectContaining({ name: 'authorization', secret: true, required: true, hasDefault: true }),
      expect.objectContaining({ name: 'captcha_token', secret: true, required: true, hasDefault: true }),
    ])
    expect(JSON.stringify(drivers)).not.toMatch(/(?:google|halal|thunder)-private/)
    await service.createMount({ mountPath: '/photos', driver: 'Google Photo', addition: {} })
    expect(JSON.parse(String(created?.addition))).toEqual({ refresh_token: 'google-private' })
  })
  it('bumps the Host cache generation after every successful mount mutation', async () => {
    const service = new OpenListService(new Context(), { fetch: async url => String(url).endsWith('/api/admin/driver/list') ? json({ code: 200, data: { Demo: { additional: [] } } }) : json({ code: 200, data: { id: 1 } }) })
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'http://localhost:5244', token: 'admin', mode: 'external' }
    const initial = service.credentialGeneration()
    await service.createMount({ mountPath: '/demo', driver: 'Demo', addition: {} }); expect(service.credentialGeneration()).toBe(initial + 1)
    await service.disableMount('1'); expect(service.credentialGeneration()).toBe(initial + 2)
    await service.removeMount('1'); expect(service.credentialGeneration()).toBe(initial + 3)
    expect((await service.credentials())?.generation).toBe(initial + 3)
  })
  it('retries an admin request once with refreshed managed credentials', async () => {
    const headers: string[] = []
    const client = new OpenListHostClient({ endpoint: 'http://localhost:5244', token: 'expired' }, { fetch: async (_url, init) => { headers.push(new Headers(init?.headers).get('authorization') ?? ''); return headers.length === 1 ? new Response('', { status: 401 }) : json({ code: 200, data: {} }) } }, async () => ({ endpoint: 'http://localhost:5244', token: 'fresh', mode: 'managed' }))
    await client.connect()
    expect(headers).toEqual(['expired', 'fresh'])
  })
  it('retries an official HTTP-200 code-401 admin envelope once', async () => {
    const headers: string[] = []
    const client = new OpenListHostClient({ endpoint: 'http://localhost:5244', token: 'expired' }, { fetch: async (_url, init) => { headers.push(new Headers(init?.headers).get('authorization') ?? ''); return headers.length === 1 ? json({ code: 401, message: 'expired' }) : json({ code: 200, data: {} }) } }, async () => ({ endpoint: 'http://localhost:5244', token: 'fresh', mode: 'managed' }))
    await client.connect()
    expect(headers).toEqual(['expired', 'fresh'])
  })
  it('atomically persists a refreshed managed JWT before exposing it', async () => {
    const writes: string[] = []; const renames: unknown[][] = []
    const service = new OpenListService(new Context(), { fetch: async () => json({ code: 200, data: { token: 'fresh' } }), mkdir: async () => undefined, writeFile: async (path, body) => { writes.push(`${String(path)}\n${String(body)}`) }, rename: async (...args) => { renames.push(args) }, chmod: async () => undefined, securePermissions: async () => undefined })
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'http://localhost:5244', token: 'expired', password: 'admin-password', mode: 'managed', version: OPENLIST_FIXED_VERSION }
    await expect(service.credentials(true)).resolves.toMatchObject({ token: 'fresh' })
    expect(writes).toHaveLength(1); expect(writes[0]).toContain('"token":"fresh"'); expect(writes[0]).toContain('.credentials-')
    expect(renames).toHaveLength(1); expect(String(renames[0]?.[1])).toMatch(/credentials\.json$/)
  })
  it('validates dynamic addition fields and applies typed defaults again on the Host boundary', async () => {
    const bodies: Record<string, unknown>[] = []
    const service = new OpenListService(new Context(), { fetch: async (url, init) => {
      if (String(url).endsWith('/driver/list')) return json({ code: 200, data: { Demo: { additional: [{ name: 'access_token', type: 'password', required: true }, { name: 'refresh_token', type: 'password', required: true }, { name: 'limit', type: 'number', default: '5' }] } } })
      bodies.push(JSON.parse(String(init?.body))); return json({ code: 200, data: { id: 8 } })
    } })
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'http://localhost:5244', token: 'admin', mode: 'external' }
    await expect(service.createMount({ mountPath: '/demo', driver: 'Demo', addition: { access_token: 'a' } })).rejects.toThrow(/incomplete/)
    await expect(service.createMount({ mountPath: '/demo', driver: 'Demo', addition: { access_token: 'a', refresh_token: 'r', surprise: 'x' } })).rejects.toThrow(/invalid/)
    await service.createMount({ mountPath: '/demo', driver: 'Demo', addition: { access_token: 'a', refresh_token: 'r' } })
    expect(JSON.parse(String(bodies[0]?.addition))).toEqual({ access_token: 'a', refresh_token: 'r', limit: 5 })
  })
  it('reauthenticates by merging only the supplied addition fields into the full host-side storage row', async () => {
    const calls: { url: string, init?: RequestInit }[] = []
    const client = new OpenListHostClient({ endpoint: 'http://127.0.0.1:5244', token: 'token' }, { fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/storage/list')) return json({ code: 200, data: { content: [{ id: 7, mount_path: '/keep', driver: 'Demo', addition: JSON.stringify({ token: 'old', region: 'keep', root_folder_path: '/keep-root' }), order: 9, remark: 'keep this', cache_expiration: 60, web_proxy: true, disabled: true, custom_cache_policies: [{ key: 'x' }], disable_index: true, proxy_range: true, disable_proxy_sign: true }] } })
      return json({ code: 200, data: {} })
    } })
    await client.updateMountPatch('7', { token: 'new' })
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ id: 7, mount_path: '/keep', driver: 'Demo', addition: JSON.stringify({ token: 'new', region: 'keep', root_folder_path: '/keep-root' }), order: 9, remark: 'keep this', cache_expiration: 60, web_proxy: true })
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ disabled: true, custom_cache_policies: [{ key: 'x' }], disable_index: true, proxy_range: true, disable_proxy_sign: true })
  })
  it('writes a loopback-only v4 config', async () => {
    const writes: unknown[][] = []
    await writeManagedOpenListConfig('/tmp/openlist-data', 5245, { mkdir: async () => undefined, writeFile: async (...args) => { writes.push(args); return undefined }, chmod: async () => undefined, securePermissions: async () => undefined, rename: async () => undefined })
    expect(JSON.parse(String(writes[0]?.[1]))).toMatchObject({ scheme: { address: '127.0.0.1', http_port: 5245, https_port: -1 } })
  })
  it('preserves existing config and jwt secret while securing it', async () => {
    const writes: unknown[][] = []; const secured: string[] = []
    await writeManagedOpenListConfig('/data', 6000, { readFile: (async () => JSON.stringify({ jwt_secret: 'keep-me', arbitrary: 'preserved', scheme: { http_port: 1 } })) as never, mkdir: async () => undefined, writeFile: async (...args) => { writes.push(args); return undefined }, chmod: async () => undefined, securePermissions: async path => { secured.push(path) }, rename: async () => undefined })
    expect(JSON.parse(String(writes[0]?.[1]))).toMatchObject({ jwt_secret: 'keep-me', arbitrary: 'preserved', scheme: { address: '127.0.0.1', http_port: 6000 } })
    expect(secured).toHaveLength(2)
  })
  it('fails closed if the credential ACL seam fails', async () => {
    await expect(writeOpenListCredentials({ endpoint: 'http://localhost:5244', token: 'secret' }, '/data/credentials.json', { mkdir: async () => undefined, writeFile: async () => undefined, chmod: async () => undefined, securePermissions: async () => { throw new Error('acl') } })).rejects.toThrow(/Could not secure/)
  })
  it('rejects malformed existing config and leaves it unreplaced', async () => {
    const writes = vi.fn(async () => undefined)
    await expect(writeManagedOpenListConfig('/data', 6000, { readFile: (async () => '{nope') as never, mkdir: async () => undefined, writeFile: writes, chmod: async () => undefined, securePermissions: async () => undefined, rename: async () => undefined })).rejects.toThrow(/config/)
    expect(writes).not.toHaveBeenCalled()
  })
  it('waits for loopback readiness and only stops the child it owns', async () => {
    class Child extends EventEmitter { exitCode: number | null = null; kill = vi.fn(() => { this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0)); return true }) }
    const child = new Child(); const spawn = vi.fn(() => child)
    const runtime = new ManagedOpenListRuntime({ spawn: spawn as never, fetch: async url => new Response(String(url).endsWith('/ping') ? 'pong' : '', { status: 200 }), mkdir: async () => undefined, readFile: (async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }) as never, writeFile: async () => undefined, chmod: async () => undefined, securePermissions: async () => undefined, rename: async () => undefined })
    await expect(runtime.start('openlist', '/data', 5244)).resolves.toBe('http://127.0.0.1:5244')
    expect(spawn).toHaveBeenCalledWith('openlist', ['server', '--data', '/data'], expect.anything())
    await runtime.stop(); expect(child.kill).toHaveBeenCalledOnce()
  })
  it('retains ownership and fails closed when a managed child ignores graceful and forced termination', async () => {
    class Child extends EventEmitter { exitCode: number | null = null; kill = vi.fn(() => true) }
    const child = new Child()
    const runtime = new ManagedOpenListRuntime({ spawn: (() => child) as never, fetch: async () => new Response('pong'), mkdir: async () => undefined, readFile: (async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }) as never, writeFile: async () => undefined, chmod: async () => undefined, securePermissions: async () => undefined, rename: async () => undefined })
    await runtime.start('openlist', '/data', 5244)
    await expect(runtime.stop()).rejects.toThrow(/did not exit/)
    expect(child.kill).toHaveBeenNthCalledWith(1)
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(runtime.running).toBe(true)
  })
  it('does not spawn a repair or rollback replacement until the old process exit is proven', async () => {
    const service = new OpenListService(new Context(), { fetch: vi.fn(async () => json({ code: 200, data: {} })) })
    const stop = vi.fn(async () => { throw new ReferenceAnythingError('Managed OpenList did not exit', 'REFERENCE_READ_FAILED') })
    const start = vi.fn(async () => 'http://localhost:5244')
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'http://localhost:5244', token: 'old', password: 'password1', mode: 'managed', version: OPENLIST_FIXED_VERSION }
    ;(service as unknown as { runtime: unknown }).runtime = { stop, start, running: true }
    await expect(service.install()).rejects.toThrow(/operation failed/)
    expect(start).not.toHaveBeenCalled()
    ;(service as unknown as { installedVersions(): Promise<string[]> }).installedVersions = async () => ['v4.1.0', OPENLIST_FIXED_VERSION]
    await expect(service.upgrade({ rollback: true })).rejects.toThrow(/operation failed/)
    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(2)
  })
  it('rolls back a retained install handle when cancellation lands immediately after acquisition', async () => {
    const controller = new AbortController(); const finishes: boolean[] = []; let active = false; let installs = 0
    const install = vi.fn(async () => {
      if (active) throw new Error('replacement owner leaked')
      active = true; installs += 1
      if (installs === 1) controller.abort()
      return { version: OPENLIST_FIXED_VERSION, path: '/bin/openlist', finish: async (success: boolean) => { finishes.push(success); active = false } }
    })
    const service = new OpenListService(new Context(), {
      install,
      fetch: async url => String(url).endsWith('/api/auth/login') ? json({ code: 200, data: { token: 'managed-token' } }) : json({ code: 200, data: {} }),
      mkdir: async () => undefined, writeFile: async () => undefined, rename: async () => undefined, chmod: async () => undefined, securePermissions: async () => undefined,
    })
    ;(service as unknown as { runtime: unknown }).runtime = { running: false, stop: async () => undefined, setAdminPassword: async () => 'managed-password', start: async () => 'http://127.0.0.1:5244' }
    await expect(service.install(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(finishes).toEqual([false]); expect(active).toBe(false)
    await expect(service.install()).resolves.toBeDefined()
    expect(install).toHaveBeenCalledTimes(2); expect(finishes).toEqual([false, true]); expect(active).toBe(false)
  })
  it('preserves working credentials and restarts the old version when aborted before admin spawn', async () => {
    const controller = new AbortController(); const finishes: boolean[] = []; const credentialWrites: unknown[] = []
    let active = false; let installs = 0; let running = true
    const install = vi.fn(async () => {
      if (active) throw new Error('replacement owner leaked')
      active = true; installs += 1
      if (installs === 1) controller.abort()
      return { version: OPENLIST_FIXED_VERSION, path: '/new/openlist', finish: async (success: boolean) => { finishes.push(success); active = false } }
    })
    const setAdminPassword = vi.fn(async () => 'new-password')
    const starts: string[] = []
    const previous = { endpoint: 'http://127.0.0.1:5244', token: 'old-token', password: 'working-password', mode: 'managed' as const, version: 'v4.1.0' }
    const service = new OpenListService(new Context(), {
      install,
      fetch: async url => String(url).endsWith('/api/auth/login') ? json({ code: 200, data: { token: 'old-token' } }) : json({ code: 200, data: {} }),
      mkdir: async () => undefined,
      writeFile: async (_path, data) => { try { const value = JSON.parse(String(data)); if (value.mode === 'managed') credentialWrites.push(value) } catch {} },
      rename: async () => undefined, chmod: async () => undefined, securePermissions: async () => undefined,
    })
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = previous
    ;(service as unknown as { runtime: unknown }).runtime = {
      get running() { return running },
      stop: async () => { running = false },
      setAdminPassword,
      start: async (binary: string) => { starts.push(binary); running = true; return previous.endpoint },
    }
    ;(service as unknown as { binaryExists(version: string): Promise<boolean> }).binaryExists = async () => true

    await expect(service.install(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(setAdminPassword).not.toHaveBeenCalled()
    expect(finishes).toEqual([false]); expect(active).toBe(false)
    expect(starts).toHaveLength(1); expect(starts[0]).toContain('v4.1.0')
    expect(credentialWrites).not.toContainEqual(expect.objectContaining({ token: 'unknown-after-admin-random' }))
    expect(credentialWrites.at(-1)).toEqual(previous)
    await expect(service.credentials()).resolves.toMatchObject(previous)

    await expect(service.install()).resolves.toBeDefined()
    expect(setAdminPassword).toHaveBeenCalledOnce()
    expect(finishes).toEqual([false, true]); expect(active).toBe(false)
  })
  it('rolls a failed repair back to the previous binary while retaining the new database password', () => {
    const previous = { endpoint: 'http://localhost:5001', token: 'old-token', password: 'stale-password', mode: 'managed' as const, version: 'v4.1.0' }
    const mutated = { endpoint: 'http://localhost:5002', token: 'pending', password: 'new-random-password', mode: 'managed' as const, version: OPENLIST_FIXED_VERSION }
    expect(repairRecoveryCredentials(previous, mutated)).toEqual({ endpoint: previous.endpoint, token: previous.token, password: 'new-random-password', mode: 'managed', version: 'v4.1.0' })
  })
  it('requires explicit disconnect before replacing an external connection with managed mode', async () => {
    const fetch = vi.fn(async () => new Response())
    const service = new OpenListService(new Context(), { fetch })
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'https://openlist.example', token: 'external', mode: 'external' }
    await expect(service.install()).rejects.toThrow(/Disconnect external/)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects a stalled or wrong service readiness response', async () => {
    class Child extends EventEmitter { exitCode: number | null = null; kill = vi.fn(() => { this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0)); return true }) }
    const child = new Child()
    const runtime = new ManagedOpenListRuntime({ spawn: (() => child) as never, fetch: async () => new Response('not-openlist', { status: 200 }), sleep: async () => undefined, mkdir: async () => undefined, readFile: (async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }) as never, writeFile: async () => undefined, chmod: async () => undefined, securePermissions: async () => undefined, rename: async () => undefined })
    await expect(runtime.start('openlist', '/data', 5244)).rejects.toThrow(/did not become ready/)
    expect(child.kill).toHaveBeenCalledOnce()
  })
  it('allows a slow first start to finish after the former two-second window', async () => {
    class Child extends EventEmitter { exitCode: number | null = null; kill = vi.fn(() => true) }
    const child = new Child()
    let attempts = 0
    const runtime = new ManagedOpenListRuntime({
      spawn: (() => child) as never,
      fetch: async () => new Response(++attempts > 20 ? 'pong' : 'starting', { status: 200 }),
      sleep: async () => undefined,
      mkdir: async () => undefined,
      readFile: (async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }) as never,
      writeFile: async () => undefined,
      chmod: async () => undefined,
      securePermissions: async () => undefined,
      rename: async () => undefined,
    })
    await expect(runtime.start('openlist', '/data', 5244)).resolves.toBe('http://127.0.0.1:5244')
    expect(attempts).toBe(21)
    expect(child.kill).not.toHaveBeenCalled()
  })
  it('cancels admin random only before spawn, then learns the committed password despite cancellation', async () => {
    class Child extends EventEmitter { exitCode: number | null = null; stdout = new PassThrough(); stderr = new PassThrough(); kill = vi.fn(() => true) }
    const preCancelled = new AbortController(); preCancelled.abort()
    const spawn = vi.fn(() => new Child()); const preSpawnStates: string[] = []
    await expect(new ManagedOpenListRuntime({ spawn: spawn as never }).setAdminPassword('openlist', '/data', undefined, preCancelled.signal, state => { preSpawnStates.push(state) })).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawn).not.toHaveBeenCalled()
    expect(preSpawnStates).toEqual([])

    const controller = new AbortController(); const child = new Child(); const mutationStates: string[] = []
    const runtime = new ManagedOpenListRuntime({ spawn: (() => { controller.abort(); return child }) as never })
    const pending = runtime.setAdminPassword('openlist', '/data', undefined, controller.signal, state => { mutationStates.push(state) })
    child.stderr.write('password: committed-secret\n'); child.exitCode = 0; child.emit('close', 0)
    await expect(pending).resolves.toBe('committed-secret')
    expect(mutationStates).toEqual(['unknown', 'committed'])
    expect(child.kill).not.toHaveBeenCalled()
  })
  it('uses admin random without putting a secret in argv and parses only its output', async () => {
    class Child extends EventEmitter { exitCode: number | null = null; stdout = new PassThrough(); stderr = new PassThrough(); kill = vi.fn(() => true) }
    const child = new Child(); const calls: unknown[][] = []; const spawn = vi.fn((...args: unknown[]) => { calls.push(args); return child })
    const runtime = new ManagedOpenListRuntime({ spawn: spawn as never })
    const pending = runtime.setAdminPassword('openlist', '/data')
    child.stdout.write("INFO reset admin user's password to a random string from CLI\nadmin user has been updated:\nusername: admin\npassword: ignored-first\n"); child.exitCode = 0; child.emit('exit', 0)
    child.stderr.write('password: generated-secret\n'); child.emit('close', 0)
    await expect(pending).resolves.toBe('generated-secret')
    expect(calls[0]?.[1]).toEqual(['admin', 'random', '--data', '/data'])
    expect(JSON.stringify(calls[0])).not.toContain('generated-secret')
    expect(parseRandomAdminPassword('INFO password is another-secret')).toBeUndefined()
    expect(parseRandomAdminPassword('password: first-secret\npassword: another-secret')).toBe('another-secret')
  })
  it('blocks a second admin random until a timed-out child is confirmed closed', async () => {
    vi.useFakeTimers()
    try {
      class Child extends EventEmitter { exitCode: number | null = null; stdout = new PassThrough(); stderr = new PassThrough(); kill = vi.fn(() => true) }
      const child = new Child(); const spawn = vi.fn(() => child)
      const runtime = new ManagedOpenListRuntime({ spawn: spawn as never })
      const retryingRuntime = new ManagedOpenListRuntime({ spawn: spawn as never })
      const first = runtime.setAdminPassword('openlist', '/locked-data')
      const firstFailure = expect(first).rejects.toThrow(/generate OpenList admin password/)
      await vi.advanceTimersByTimeAsync(16_100)
      await firstFailure
      expect(child.kill).toHaveBeenNthCalledWith(1)
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
      await expect(retryingRuntime.setAdminPassword('openlist', '/locked-data')).rejects.toThrow(/already in progress/)
      expect(spawn).toHaveBeenCalledTimes(1)
      child.exitCode = 0; child.emit('close', 0)
      const secondChild = new Child()
      spawn.mockReturnValueOnce(secondChild)
      const second = retryingRuntime.setAdminPassword('openlist', '/locked-data')
      secondChild.stderr.write('password: replacement-secret\n'); secondChild.exitCode = 0; secondChild.emit('close', 0)
      await expect(second).resolves.toBe('replacement-secret')
      expect(spawn).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
  it('keeps an external connection successful when cancellation follows its credential write', async () => {
    const controller = new AbortController()
    const service = new OpenListService(new Context(), { fetch: async () => json({ code: 200, data: {} }), mkdir: async () => undefined, writeFile: async () => undefined, rename: async () => { controller.abort() }, chmod: async () => undefined, securePermissions: async () => undefined })
    await expect(service.connectExternal({ endpoint: 'http://localhost:5244', token: 'committed' }, controller.signal)).resolves.toMatchObject({ mode: 'external' })
    await expect(service.credentials()).resolves.toMatchObject({ token: 'committed' })
  })
  it('keeps a managed credential refresh successful when cancellation follows its credential write', async () => {
    const controller = new AbortController()
    const service = new OpenListService(new Context(), { fetch: async () => json({ code: 200, data: { token: 'new-token' } }), mkdir: async () => undefined, writeFile: async () => undefined, rename: async () => { controller.abort() }, chmod: async () => undefined, securePermissions: async () => undefined })
    ;(service as unknown as { credentialsValue: unknown, runtime: unknown }).credentialsValue = { endpoint: 'http://localhost:5244', token: 'old-token', password: 'long-password', mode: 'managed', version: OPENLIST_FIXED_VERSION }
    ;(service as unknown as { runtime: unknown }).runtime = { start: async () => 'http://localhost:5244', stop: async () => undefined, running: true }
    ;(service as unknown as { binaryExists(version: string): Promise<boolean> }).binaryExists = async () => true
    await expect((service as unknown as { startManaged(signal: AbortSignal): Promise<void> }).startManaged(controller.signal)).resolves.toBeUndefined()
    await expect(service.credentials()).resolves.toMatchObject({ token: 'new-token' })
  })
  it('reuses the persisted loopback port when restarting a managed instance', async () => {
    const start = vi.fn(async () => 'http://127.0.0.1:5244')
    const urls: string[] = []
    const service = new OpenListService(new Context(), { fetch: async url => { urls.push(String(url)); return String(url).endsWith('/auth/login') ? json({ code: 200, data: { token: 'new-token' } }) : json({ code: 200, data: [] }) }, mkdir: async () => undefined, writeFile: async () => undefined, rename: async () => undefined, chmod: async () => undefined, securePermissions: async () => undefined })
    ;(service as unknown as { credentialsValue: unknown, runtime: unknown }).credentialsValue = { endpoint: 'http://127.0.0.1:5244', token: 'old-token', password: 'long-password', mode: 'managed', version: OPENLIST_FIXED_VERSION }
    ;(service as unknown as { runtime: unknown }).runtime = { start, stop: async () => undefined, running: false }
    ;(service as unknown as { binaryExists(version: string): Promise<boolean> }).binaryExists = async () => true
    await (service as unknown as { startManaged(binary?: string, version?: string): Promise<void> }).startManaged()
    expect(start).toHaveBeenCalledWith(expect.any(String), expect.any(String), 5244, undefined)
    expect(urls).toContain('http://127.0.0.1:5244/api/admin/setting/get?keys=search_index,auto_update_index'); expect(urls).toContain('http://127.0.0.1:5244/api/admin/setting/save')
  })
  it('selects and persists a replacement when the persisted managed port is unavailable', async () => {
    const start = vi.fn(async (_binary: string, _data: string, port?: number) => { if (port === 5244) throw new Error('address in use'); return 'http://127.0.0.1:61234' })
    const service = new OpenListService(new Context(), { fetch: async url => String(url).endsWith('/auth/login') ? json({ code: 200, data: { token: 'new-token' } }) : json({ code: 200, data: [] }), mkdir: async () => undefined, writeFile: async () => undefined, rename: async () => undefined, chmod: async () => undefined, securePermissions: async () => undefined })
    ;(service as unknown as { credentialsValue: unknown, runtime: unknown }).credentialsValue = { endpoint: 'http://127.0.0.1:5244', token: 'old-token', password: 'long-password', mode: 'managed', version: OPENLIST_FIXED_VERSION }
    ;(service as unknown as { runtime: unknown }).runtime = { start, stop: async () => undefined, running: false }
    ;(service as unknown as { binaryExists(version: string): Promise<boolean> }).binaryExists = async () => true
    await (service as unknown as { startManaged(binary?: string, version?: string): Promise<void> }).startManaged()
    expect(start.mock.calls.map(call => call[2])).toEqual([5244, undefined]); await expect(service.credentials()).resolves.toMatchObject({ endpoint: 'http://127.0.0.1:61234' })
  })
  it('keeps disconnect successful when cancellation follows the credential-file unlink', async () => {
    const controller = new AbortController()
    const unlink = vi.fn(async (_path: PathLike) => { controller.abort() })
    const service = new OpenListService(new Context(), { unlink })
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'http://localhost:5244', token: 'old-token', mode: 'external' }
    await expect(service.disconnect(controller.signal)).resolves.toMatchObject({ state: 'install' })
    await expect(service.credentials()).resolves.toBeUndefined()
    expect(unlink.mock.calls.filter(([path]) => String(path).endsWith('credentials.json'))).toHaveLength(1)
  })
  it('preserves an external connection when credential deletion fails other than ENOENT', async () => {
    const service = new OpenListService(new Context(), { unlink: async () => { throw Object.assign(new Error('secret path'), { code: 'EACCES' }) } })
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'http://localhost:5244', token: 'old-token', mode: 'external' }
    await expect(service.disconnect()).rejects.toThrow(/credentials could not be removed/)
    await expect(service.credentials()).resolves.toMatchObject({ token: 'old-token' })
  })
  it('keeps managed disconnect successful when cancellation follows runtime stop', async () => {
    const controller = new AbortController()
    const stop = vi.fn(async () => { controller.abort() })
    const service = new OpenListService(new Context())
    ;(service as unknown as { credentialsValue: unknown }).credentialsValue = { endpoint: 'http://localhost:5244', token: 'old-token', password: 'long-password', mode: 'managed', version: OPENLIST_FIXED_VERSION }
    ;(service as unknown as { runtime: unknown }).runtime = { stop, running: false }
    await expect(service.disconnect(controller.signal)).resolves.toMatchObject({ state: 'install' })
    await expect(service.credentials()).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledOnce()
  })
})

function json(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) }
function zip(name: string, data: Uint8Array): Uint8Array { const encoded = new TextEncoder().encode(name); const out = new Uint8Array(30 + encoded.byteLength + data.byteLength); const view = new DataView(out.buffer); view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint32(18, data.byteLength, true); view.setUint32(22, data.byteLength, true); view.setUint16(26, encoded.byteLength, true); out.set(encoded, 30); out.set(data, 30 + encoded.byteLength); return out }
