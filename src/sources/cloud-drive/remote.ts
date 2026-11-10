/** Remote for the cloud-drive source: `@` discovery, downloads, and OpenList administration. */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { REMOTE_SERVICE_KEYS } from '../../contract.ts'
import { validateDownloadDirectory } from '../../download-directory.ts'
import type {} from '../../openlist/index.ts'
import type {} from './index.ts'

export class CloudDriveRemote extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, REMOTE_SERVICE_KEYS.drive) }


  /**
   * Discovery for the `@` menu's cloud-drive group.
   *
   * Optional for the same reason as `agentSearch` above. It takes no session:
   * a drive is not scoped to a workspace, so there is nothing a cwd could
   * narrow. `list` already refuses to name a download URL, so what comes back
   * here is a label and a display path.
   */
  async driveSearch(input: { query: string; limit: number }, signal: AbortSignal) {
    const drives = this.ctx.get('referenceCloudDrive')
    if (drives === undefined) return []
    const rows = await drives.pickerList(input.query, input.limit, signal)
    return rows.map(row => ({
      id: row.ref.id,
      label: row.label,
      provider: row.provider ?? '',
      ...row.origin === undefined ? {} : { origin: row.origin },
      ...row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt },
      ...row.isDirectory === true ? { isDirectory: true } : {},
    }))
  }

  /** Facts the drive settings need from the Host. */
  driveStatus(signal: AbortSignal) {
    signal.throwIfAborted()
    return { systemTempDirectory: tmpdir() }
  }

  async openDownloadDirectory(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const configured = this.ctx.get('referenceCloudDrive')?.preferences.get().downloadDirectory ?? ''
    const path = configured || tmpdir()
    await validateDownloadDirectory(path)
    const child = process.platform === 'win32'
      ? spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' })
      : process.platform === 'darwin'
        ? spawn('open', [path], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [path], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  }
  openListStatus(signal: AbortSignal) { return this.ctx.openListManager.status(signal) }
  openListInstall(signal: AbortSignal) { return this.ctx.openListManager.install(signal) }
  openListUpgrade(input: { rollback?: boolean }, signal: AbortSignal) { return this.ctx.openListManager.upgrade(input, signal) }
  openListConnectExternal(input: { endpoint: string, username?: string, password?: string, token?: string }, signal: AbortSignal) { return this.ctx.openListManager.connectExternal(input, signal) }
  openListDisconnect(signal: AbortSignal) { return this.ctx.openListManager.disconnect(signal) }
  openListDrivers(signal: AbortSignal) { return this.ctx.openListManager.drivers(signal) }
  openListMounts(signal: AbortSignal) { return this.ctx.openListManager.mounts(signal) }
  openListCreateMount(input: { id?: string, mountPath: string, driver: string, addition: Record<string, unknown>, order?: number, remark?: string }, signal: AbortSignal) { return this.ctx.openListManager.createMount(input, signal) }
  async openListDisableMount(input: { id: string, disabled?: boolean }, signal: AbortSignal): Promise<boolean> { await this.ctx.openListManager.disableMount(input.id, input.disabled ?? true, signal); return true }
  async openListRemoveMount(input: { id: string }, signal: AbortSignal): Promise<boolean> { await this.ctx.openListManager.removeMount(input.id, signal); return true }
  openListReindex(input: { id: string }, signal: AbortSignal) { return this.ctx.openListManager.reindexMount(input.id, signal) }
}
