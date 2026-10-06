import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: ({ children, ...props }: any) => createElement('button', props, children), Switch: () => createElement('button', { role: 'switch' }), Checkbox: () => null, Input: () => null, Menu: () => null }))
import { ProviderCard } from '../src/client/components.tsx'

const props = { provider: 'chatgpt' as const, busy: true, autoSync: false, enabled: true, index: 0, onEnabled() {}, onSync() {}, onClear() {}, t: ((key: string) => key) as any }
describe('source card progress', () => {
  it('does not show progress for a source outside the current job', () => {
    expect(renderToStaticMarkup(<ProviderCard {...props} />)).not.toContain('role="progressbar"')
  })
  it('uses the source counts for determinate progress', () => {
    const html = renderToStaticMarkup(<ProviderCard {...props} progress={{ provider: 'chatgpt', phase: 'syncing', completed: 25, total: 100 }} />)
    expect(html).toContain('width:25%')
    expect(html).toContain('aria-valuenow="25"')
  })
  it('does not invent a percentage during listing', () => {
    const html = renderToStaticMarkup(<ProviderCard {...props} progress={{ provider: 'chatgpt', phase: 'listing', completed: 0, total: 0 }} />)
    expect(html).toContain('is_listing')
    expect(html).not.toContain('aria-valuenow')
  })
  it('fills empty completed sources and preserves failed progress', () => {
    expect(renderToStaticMarkup(<ProviderCard {...props} progress={{ provider: 'chatgpt', phase: 'complete', completed: 0, total: 0 }} />)).toContain('width:100%')
    const html = renderToStaticMarkup(<ProviderCard {...props} progress={{ provider: 'chatgpt', phase: 'failed', completed: 2, total: 10, error: 'sync error' }} />)
    expect(html).toContain('width:20%')
    expect(html).toContain('sync error')
  })
})
