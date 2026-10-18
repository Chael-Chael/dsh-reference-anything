import { discoverySchema } from './chat-import-discovery.ts'
import type { z } from 'zod'

type Snapshot = z.infer<typeof discoverySchema>
type Entry = { value?: Snapshot; expires: number; pending?: Promise<Snapshot> }

/** Short-lived metadata only; readers still open the original transcript. */
export class AgentScanCache {
  constructor(private readonly ttl = 2_000) {}
  private entries = new Map<string, Entry>()
  private owner: unknown
  private policy = ''

  async read(owner: unknown, policy: string, key: string, scan: () => Promise<unknown>, signal: AbortSignal): Promise<Snapshot> {
    signal.throwIfAborted()
    if (owner !== this.owner || policy !== this.policy) {
      this.entries.clear()
      this.owner = owner
      this.policy = policy
    }
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!)
      entry = { expires: 0 }
      this.entries.set(key, entry)
    }
    if (entry.value && entry.expires > Date.now()) return entry.value
    const current = entry
    current.pending ??= Promise.resolve().then(scan).then(value => {
      const parsed = discoverySchema.parse(value)
      current.value = parsed
      current.expires = Date.now() + this.ttl
      return parsed
    }).finally(() => { current.pending = undefined })
    // Cancelling one picker request must not cancel another caller's shared scan.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      current.pending!.then(value => { if (!signal.aborted) resolve(value) }, reject)
        .finally(() => signal.removeEventListener('abort', abort))
    })
  }
}
