import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { httpCdpTransport } from '../src/cdp/transport.ts'

/**
 * A stand-in for Chrome's DevTools endpoint: the real `/json/list` shape and a
 * real WebSocket speaking the two CDP frames this client uses. Everything the
 * transport does — id correlation, exception surfacing, timeouts, cleanup —
 * is exercised for real; only the browser is absent.
 */
interface FakeBrowser {
  readonly endpoint: string
  readonly sockets: () => number
  close(): Promise<void>
}

type Reply = (frame: { id?: number }) => unknown | undefined

let running: FakeBrowser | undefined

async function startBrowser(options: {
  targets?: unknown
  reply?: Reply
  status?: number
} = {}): Promise<FakeBrowser> {
  const wss = new WebSocketServer({ noServer: true })
  let open = 0

  const server: Server = createServer((request, response) => {
    if (request.url !== '/json/list') {
      response.writeHead(404).end()
      return
    }
    if (options.status !== undefined && options.status !== 200) {
      response.writeHead(options.status).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(options.targets ?? []))
  })

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      open += 1
      ws.on('close', () => { open -= 1 })
      ws.on('message', (data) => {
        const frame = JSON.parse(String(data)) as { id?: number }
        const response = options.reply?.(frame)
        if (response !== undefined) ws.send(JSON.stringify(response))
      })
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const browser: FakeBrowser = {
    endpoint: `http://127.0.0.1:${port}`,
    sockets: () => open,
    close: () => new Promise<void>((resolve) => {
      wss.close(() => { server.close(() => { resolve() }) })
    }),
  }
  running = browser
  return browser
}

function pageTarget(port: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'target-1',
    type: 'page',
    url: 'https://chat.deepseek.com/a/chat/s/abc',
    title: 'Cache design',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/target-1`,
    ...over,
  }
}

function targetOf(browser: FakeBrowser, over: Record<string, unknown> = {}) {
  const port = Number(new URL(browser.endpoint).port)
  return pageTarget(port, over) as unknown as Parameters<ReturnType<typeof httpCdpTransport>['evaluate']>[0]
}

afterEach(async () => {
  await running?.close()
  running = undefined
})

describe('the endpoint must be on this machine', () => {
  it.each([
    ['a public host', 'http://198.51.100.7:9222'],
    ['a hostname that is not loopback', 'http://browser.internal:9222'],
    ['https', 'https://127.0.0.1:9222'],
    ['not a URL at all', 'nope'],
  ])('refuses %s', (_label, endpoint) => {
    // Whoever reaches a DevTools port can read every page and cookie in that
    // browser, so this is a fixed invariant rather than a setting.
    expect(() => httpCdpTransport(endpoint))
      .toThrow(expect.objectContaining({ code: 'REFERENCE_INVALID_CONFIG' }))
  })

  it.each(['http://127.0.0.1:9222', 'http://localhost:9222', 'http://[::1]:9222'])('accepts %s', (endpoint) => {
    expect(() => httpCdpTransport(endpoint)).not.toThrow()
  })
})

describe('listTargets', () => {
  it('returns the targets the endpoint reports', async () => {
    const browser = await startBrowser({ targets: [pageTarget(1)] })
    const targets = await httpCdpTransport(browser.endpoint).listTargets()
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ id: 'target-1', type: 'page' })
  })

  it('tolerates a trailing slash on the endpoint', async () => {
    const browser = await startBrowser({ targets: [pageTarget(1)] })
    await expect(httpCdpTransport(`${browser.endpoint}/`).listTargets()).resolves.toHaveLength(1)
  })

  it('drops entries that are not targets rather than trusting the shape', async () => {
    const browser = await startBrowser({ targets: [pageTarget(1), { id: 5 }, null, 'nope'] })
    await expect(httpCdpTransport(browser.endpoint).listTargets()).resolves.toHaveLength(1)
  })

  it('says plainly when nothing is listening', async () => {
    // Port 1 is privileged and never a DevTools endpoint.
    await expect(httpCdpTransport('http://127.0.0.1:1').listTargets())
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_ENDPOINT_UNREACHABLE' }))
  })

  it('reports a non-200 answer as unreachable', async () => {
    const browser = await startBrowser({ status: 500 })
    await expect(httpCdpTransport(browser.endpoint).listTargets())
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_ENDPOINT_UNREACHABLE' }))
  })

  it('refuses a target list that is not a list', async () => {
    const browser = await startBrowser({ targets: { nope: true } })
    await expect(httpCdpTransport(browser.endpoint).listTargets())
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_ENDPOINT_UNREACHABLE' }))
  })

  it('honors an aborted signal', async () => {
    const browser = await startBrowser({ targets: [] })
    await expect(httpCdpTransport(browser.endpoint).listTargets(AbortSignal.abort()))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_ENDPOINT_UNREACHABLE' }))
  })
})

describe('evaluate', () => {
  it('returns the value and closes the socket behind it', async () => {
    const browser = await startBrowser({
      reply: frame => ({ id: frame.id, result: { result: { value: { turns: [] } } } }),
    })
    const transport = httpCdpTransport(browser.endpoint)
    await expect(transport.evaluate(targetOf(browser), 'expr', 1_000)).resolves.toEqual({ turns: [] })
    // Chrome allows one debugger per target, so a leaked socket would break
    // the very next read.
    await expect.poll(() => browser.sockets()).toBe(0)
  })

  it('ignores unsolicited events and answers only its own id', async () => {
    const browser = await startBrowser({
      reply: (frame) => {
        if (frame.id !== 1) return undefined
        return { method: 'Runtime.consoleAPICalled', params: {} }
      },
    })
    // The first frame back carries no id; the transport must keep waiting
    // rather than mistake it for the reply.
    await expect(httpCdpTransport(browser.endpoint).evaluate(targetOf(browser), 'expr', 300))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_EVALUATE_TIMEOUT' }))
  })

  it('surfaces an exception thrown inside the page', async () => {
    const browser = await startBrowser({
      reply: frame => ({
        id: frame.id,
        result: { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: nope' } } },
      }),
    })
    await expect(httpCdpTransport(browser.endpoint).evaluate(targetOf(browser), 'expr', 1_000))
      .rejects.toThrow(/TypeError: nope/u)
  })

  it('surfaces a protocol-level refusal', async () => {
    const browser = await startBrowser({
      reply: frame => ({ id: frame.id, error: { message: 'Runtime.evaluate is disabled' } }),
    })
    await expect(httpCdpTransport(browser.endpoint).evaluate(targetOf(browser), 'expr', 1_000))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_EVALUATE_FAILED' }))
  })

  it('refuses an unreadable frame', async () => {
    const browser = await startBrowser({ reply: () => 'not json at all' })
    // The fake sends a JSON string, which parses to a string, not an object —
    // so the id never matches and the wait times out rather than crashing.
    await expect(httpCdpTransport(browser.endpoint).evaluate(targetOf(browser), 'expr', 300))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_EVALUATE_TIMEOUT' }))
  })

  it('gives up on a silent page and releases the socket', async () => {
    const browser = await startBrowser({ reply: () => undefined })
    await expect(httpCdpTransport(browser.endpoint).evaluate(targetOf(browser), 'expr', 250))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_EVALUATE_TIMEOUT' }))
    await expect.poll(() => browser.sockets()).toBe(0)
  })

  it('stops when the caller cancels', async () => {
    const browser = await startBrowser({ reply: () => undefined })
    const controller = new AbortController()
    const pending = httpCdpTransport(browser.endpoint)
      .evaluate(targetOf(browser), 'expr', 10_000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'REFERENCE_CANCELLED' }))
    await expect.poll(() => browser.sockets()).toBe(0)
  })

  it('reports a target no debugger can attach to', async () => {
    const browser = await startBrowser({ targets: [] })
    expect(() => httpCdpTransport(browser.endpoint)
      .evaluate(targetOf(browser, { webSocketDebuggerUrl: undefined }), 'expr', 1_000))
      .toThrow(expect.objectContaining({ code: 'CDP_TARGET_BUSY' }))
  })

  it('reports a debugger connection that cannot be opened', async () => {
    const browser = await startBrowser({ targets: [] })
    await expect(httpCdpTransport(browser.endpoint)
      .evaluate(targetOf(browser, { webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/x' }), 'expr', 2_000))
      .rejects.toThrow(expect.objectContaining({ code: 'CDP_ENDPOINT_UNREACHABLE' }))
  })
})
