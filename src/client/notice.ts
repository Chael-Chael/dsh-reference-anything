export const NOTICE_DURATION_MS = 5_000

/** Publish transient success/info notices without hiding persistent error or status state. */
export function createAutoDismissNotice<T extends { notice?: string }>(
  read: () => T,
  write: (value: T) => void,
  durationMs = NOTICE_DURATION_MS,
): { show: (notice: string, patch?: Partial<T>) => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    show(notice, patch = {}) {
      if (timer) clearTimeout(timer)
      write({ ...read(), ...patch, notice })
      timer = setTimeout(() => {
        const current = read()
        if (current.notice === notice) write({ ...current, notice: undefined })
        timer = undefined
      }, durationMs)
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
