import { stat } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ChatImportTarget } from './chat-import-reader.ts'

type Entry = { state: string; dependencies: [string, string][]; checked: number }

/** Unknown/error rows stay visible. One background parser never delays discovery. */
export class ConversationAvailability {
  private cache = new Map<string, Entry>()
  private queued = new Map<string, ChatImportTarget>()
  private worker?: ChildProcess
  private active?: string
  private timer?: ReturnType<typeof setTimeout>

  async visible(target: ChatImportTarget): Promise<boolean> {
    const key = JSON.stringify(target)
    const entry = this.cache.get(key)
    if (entry) {
      const unchanged = (await Promise.all(entry.dependencies.map(async ([path, version]) => {
        try { const s = await stat(path); return version === `${s.size}:${s.mtimeMs}:${s.ctimeMs}` }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' && version === 'missing' }
      }))).every(Boolean)
      if (unchanged && (entry.state !== 'unknown' || Date.now() - entry.checked < 300_000)) return entry.state !== 'empty'
      this.cache.delete(key)
    }
    if (this.active !== key && this.queued.size < 128) this.queued.set(key, target)
    this.next()
    return true
  }

  private next() {
    if (this.active || !this.queued.size) return
    const [id, target] = this.queued.entries().next().value!
    this.queued.delete(id)
    this.active = id
    if (!this.worker) {
      // Native parser failures and V8 OOM must not terminate the DSH host.
      this.worker = spawn(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('../vendor/chat-import-reader/availability-worker.mjs', import.meta.url))], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      this.worker.on('message', (result: Entry & { id: string }) => {
        if (result.id !== this.active) return
        clearTimeout(this.timer)
        if (this.cache.size >= 2000) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(result.id, { ...result, checked: Date.now() })
        this.active = undefined
        this.next()
      })
      this.worker.on('error', () => this.failed())
      this.worker.on('exit', () => this.failed())
      this.worker.unref()
      this.worker.channel?.unref()
    }
    this.timer = setTimeout(() => this.failed(), 15_000)
    this.timer.unref()
    this.worker.send({ id, target })
  }

  private failed() {
    if (this.active) this.cache.set(this.active, { state: 'unknown', dependencies: [], checked: Date.now() })
    this.dispose()
    this.next()
  }

  dispose() {
    clearTimeout(this.timer)
    this.worker?.removeAllListeners()
    this.worker?.kill()
    this.worker = undefined
    this.active = undefined
  }
}
