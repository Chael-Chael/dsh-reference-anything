import { beforeEach, expect, it, vi } from 'vitest'
import { captureWebChatToken } from '../src/web-chat-token-capture.ts'
const page = vi.hoisted(() => ({ create: vi.fn(), newTab: vi.fn(), setActivePage: vi.fn(), evaluate: vi.fn(), closeTab: vi.fn() }))
vi.mock('@jackwener/opencli/browser/page', () => ({ Page: class {
  constructor(...args: unknown[]) { page.create(...args) }
  newTab = page.newTab
  setActivePage = page.setActivePage
  evaluate = page.evaluate
  closeTab = page.closeTab
} }))
beforeEach(() => {
  vi.clearAllMocks()
  page.newTab.mockResolvedValue('owned-tab')
  page.closeTab.mockResolvedValue(undefined)
})
it('captures the live browser login, waits for SPA refresh, and closes only its owned tab', async () => {
  page.evaluate.mockResolvedValueOnce(JSON.stringify({ ok: false, code: 'AUTH' }))
    .mockResolvedValueOnce(JSON.stringify({ ok: true, identity: 'account' }))
    .mockResolvedValueOnce('synthetic-token')
  expect(await captureWebChatToken('kimi', 'selected-profile')).toBe('synthetic-token')
  expect(page.create).toHaveBeenCalledWith(expect.any(String), 60, 'selected-profile', 'background', 'browser')
  expect(page.newTab).toHaveBeenCalledWith('https://www.kimi.com/')
  expect(page.setActivePage).toHaveBeenCalledWith('owned-tab')
  expect(page.closeTab).toHaveBeenCalledOnce()
})
it('cleans up the temporary tab when credential extraction fails', async () => {
  page.evaluate.mockResolvedValueOnce(JSON.stringify({ ok: true, identity: 'account' })).mockResolvedValueOnce('bad\ntoken')
  await expect(captureWebChatToken('deepseek', 'selected-profile')).rejects.toThrow('Invalid credential')
  expect(page.closeTab).toHaveBeenCalledOnce()
})
