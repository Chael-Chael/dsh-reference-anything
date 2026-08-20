import { describe, expect, it, vi } from 'vitest'
import { runReferenceUiSwitchWithReload } from '../src/client/reference-ui.ts'

describe('@ reference UI page reload', () => {
  it('reloads the DSH Web shell only after the switch has completed', async () => {
    const events: string[] = []
    const reload = vi.fn(() => { events.push('reload') })

    await runReferenceUiSwitchWithReload(async () => { events.push('switch') }, reload)

    expect(events).toEqual(['switch', 'reload'])
    expect(reload).toHaveBeenCalledOnce()
  })

  it('keeps the current page when the switch fails', async () => {
    const reload = vi.fn()

    await expect(runReferenceUiSwitchWithReload(async () => {
      throw new Error('profile write failed')
    }, reload)).rejects.toThrow('profile write failed')

    expect(reload).not.toHaveBeenCalled()
  })
})
