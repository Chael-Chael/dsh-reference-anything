import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AgentScanCache } from './agent-scan-cache.ts'
import { discoverySchema } from './chat-import-discovery.ts'

type Input = { format: string; path?: string; query?: string }
type Snapshot = ReturnType<typeof discoverySchema.parse>

/** Keep SQLite and large export scans outside the DSH event loop. */
export class LocalConversationScanner {
  private worker?: ChildProcess
  private sequence = 0
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private cache = new AgentScanCache(30_000)

  async scanDiscover(input: Input, signal = new AbortController().signal): Promise<Snapshot> {
    const result = await this.cache.read(this, '', JSON.stringify([input.format, input.path]), () => this.scan(input), signal)
    const query = input.query?.trim().toLowerCase()
    return query ? { ...result, sessions: result.sessions.filter(row => [row.title, row.project, row.sourcePath].some(s => s?.toLowerCase().includes(query))) } : result
  }

  private scan(input: Input): Promise<unknown> {
    if (!this.worker) {
      const worker = this.worker = spawn(process.execPath, ['--max-old-space-size=512', fileURLToPath(new URL('../vendor/chat-import-reader/scan-worker.mjs', import.meta.url))], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
        const request = this.pending.get(message.id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(message.id)
        if (message.error) request.reject(new Error(message.error))
        else request.resolve(message.result)
      })
      worker.on('error', error => this.dispose(error))
      worker.on('exit', code => this.dispose(new Error(`Conversation scanner exited (${code})`)))
      worker.unref()
      worker.channel?.unref()
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => this.dispose(new Error('Conversation scan timed out')), 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.send({ id, input }, error => { if (error) this.dispose(error) })
    })
  }

  dispose(error = new Error('Conversation scanner stopped')) {
    this.worker?.removeAllListeners()
    this.worker?.kill()
    this.worker = undefined
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
  }
}
