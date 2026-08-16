/**
 * The smallest useful Chrome DevTools Protocol client: list the open targets,
 * and evaluate one package-owned expression inside one of them.
 *
 * Deliberately not a CDP library. Everything here rides Node's built-in `fetch`
 * and `WebSocket` (both stable on the engines the harness supports), so the
 * package keeps its single runtime dependency. A general client would add
 * session multiplexing, event routing, and a CLI we would never call.
 *
 * @module dsh-reference-anything/cdp/transport
 */

import { ReferenceAnythingError } from '../errors.ts'

/** One page or worker the browser has open, as `/json/list` describes it. */
export interface CdpTarget {
  readonly id: string
  /** `page`, `iframe`, `service_worker`, … Only pages are of interest here. */
  readonly type: string
  readonly url: string
  readonly title: string
  /** Absent for targets that are already being debugged elsewhere. */
  readonly webSocketDebuggerUrl?: string
}

/**
 * The seam the DeepSeek source is written against.
 *
 * Everything the browser touches lives behind this interface, so the source's
 * own logic — target selection, origin checks, payload parsing — is testable
 * without a browser.
 */
export interface CdpTransport {
  /**
   * Enumerate the browser's open targets.
   * @param signal - cancellation from the caller.
   * @returns every target the endpoint reports.
   */
  listTargets(signal?: AbortSignal): Promise<CdpTarget[]>
  /**
   * Evaluate one expression in a target and return its value.
   * @param target - the page to evaluate in; must carry a debugger URL.
   * @param expression - a package-owned constant. Never built from caller input.
   * @param timeoutMs - how long to wait before giving up on the page.
   * @param signal - cancellation from the caller.
   * @returns the expression's value, serialized by the browser.
   */
  evaluate(target: CdpTarget, expression: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown>
}

/**
 * Talk to a DevTools endpoint that is already listening.
 *
 * Never starts a browser: the endpoint either exists because the user chose to
 * open it, or this source does not work. That is the whole opt-in gate.
 * @param endpoint - base HTTP origin of the DevTools endpoint, e.g. `http://127.0.0.1:9222`.
 * @returns a transport bound to that endpoint.
 */
export function httpCdpTransport(endpoint: string): CdpTransport {
  const base = endpoint.replace(/\/+$/u, '')
  return {
    async listTargets(signal?: AbortSignal): Promise<CdpTarget[]> {
      let response: Response
      try {
        const init = signal === undefined ? {} : { signal }
        response = await fetch(`${base}/json/list`, init)
      } catch (error: unknown) {
        throw new ReferenceAnythingError(
          `no browser is listening for DevTools connections at ${base}`,
          'CDP_ENDPOINT_UNREACHABLE',
          { cause: error },
        )
      }
      if (!response.ok) {
        throw new ReferenceAnythingError(
          `DevTools endpoint ${base} answered ${response.status} for /json/list`,
          'CDP_ENDPOINT_UNREACHABLE',
        )
      }
      const parsed: unknown = await response.json()
      if (!Array.isArray(parsed)) {
        throw new ReferenceAnythingError(
          `DevTools endpoint ${base} returned a target list that is not an array`,
          'CDP_ENDPOINT_UNREACHABLE',
        )
      }
      return parsed.filter(isTarget)
    },

    evaluate(target: CdpTarget, expression: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
      const url = target.webSocketDebuggerUrl
      if (url === undefined) {
        throw new ReferenceAnythingError(
          `target ${JSON.stringify(target.title)} has no debugger connection; another client may already hold it`,
          'CDP_TARGET_BUSY',
        )
      }
      return evaluateOverSocket(url, expression, timeoutMs, signal)
    },
  }
}

/** One CDP round trip, with every exit path closing the socket. */
function evaluateOverSocket(
  url: string,
  expression: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(url)
    let settled = false

    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // Close before settling: the caller may start another evaluate the
      // instant it resolves, and Chrome allows one debugger per target.
      try {
        socket.close()
      } catch {
        // The socket was never open, or the browser closed it first. Either
        // way there is nothing left to release.
      }
      outcome()
    }

    const fail = (error: ReferenceAnythingError): void => { finish(() => { reject(error) }) }

    const timer = setTimeout(() => {
      fail(new ReferenceAnythingError(
        `the page did not answer within ${timeoutMs}ms`,
        'CDP_EVALUATE_TIMEOUT',
      ))
    }, timeoutMs)

    const onAbort = (): void => {
      fail(new ReferenceAnythingError('reference lookup was cancelled', 'REFERENCE_CANCELLED', {
        cause: signal?.reason,
      }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          // The extractor is an async IIFE, so the browser must settle it
          // before replying, and the value must cross as JSON rather than as
          // a remote object handle we would have to fetch separately.
          awaitPromise: true,
          returnByValue: true,
        },
      }))
    })

    socket.addEventListener('message', (event: MessageEvent) => {
      let frame: unknown
      try {
        frame = JSON.parse(String(event.data))
      } catch (error: unknown) {
        fail(new ReferenceAnythingError('the browser sent an unreadable frame', 'CDP_EVALUATE_FAILED', { cause: error }))
        return
      }
      const message = frame as { id?: number; result?: EvaluateResult; error?: { message?: string } }
      // Chrome interleaves unsolicited events with replies; only our id matters.
      if (message.id !== 1) return
      if (message.error !== undefined) {
        fail(new ReferenceAnythingError(
          `the browser refused the evaluation: ${message.error.message ?? 'unknown error'}`,
          'CDP_EVALUATE_FAILED',
        ))
        return
      }
      const details = message.result?.exceptionDetails
      if (details !== undefined) {
        fail(new ReferenceAnythingError(
          `the extractor threw inside the page: ${details.exception?.description ?? details.text ?? 'unknown error'}`,
          'CDP_EVALUATE_FAILED',
        ))
        return
      }
      const value = message.result?.result?.value
      finish(() => { resolve(value) })
    })

    socket.addEventListener('error', () => {
      fail(new ReferenceAnythingError(`could not open a debugger connection to ${url}`, 'CDP_ENDPOINT_UNREACHABLE'))
    })

    socket.addEventListener('close', () => {
      fail(new ReferenceAnythingError('the browser closed the debugger connection', 'CDP_EVALUATE_FAILED'))
    })
  })
}

interface EvaluateResult {
  readonly result?: { readonly value?: unknown }
  readonly exceptionDetails?: {
    readonly text?: string
    readonly exception?: { readonly description?: string }
  }
}

function isTarget(value: unknown): value is CdpTarget {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.type === 'string'
    && typeof record.url === 'string'
    && typeof record.title === 'string'
    && (record.webSocketDebuggerUrl === undefined || typeof record.webSocketDebuggerUrl === 'string')
}
