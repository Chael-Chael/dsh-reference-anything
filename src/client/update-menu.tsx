import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import ReactMarkdown from 'react-markdown'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { PackageUpdateResult, PackageUpdateStatus } from './remote.ts'
import type { PickerMenuUpdater } from './menu-update.ts'

type T = TranslateNS<'reference-anything'>
const DISMISSED_VERSION = 'dsh-reference-anything.dismissed-update'

export function createUpdateSource(
  status: () => Promise<PackageUpdateStatus | undefined>,
  install: () => Promise<PackageUpdateResult>,
  updateMenu: PickerMenuUpdater,
  t: T,
): InputTriggerSource & { dispose(): void } {
  let dismissed: string | undefined
  try { dismissed = window.localStorage.getItem(DISMISSED_VERSION) ?? undefined } catch { /* Storage may be disabled. */ }
  let host: HTMLDivElement | undefined
  let root: Root | undefined
  let latest: PackageUpdateStatus | undefined
  const source: InputTriggerSource & { dispose(): void } = {
    trigger: '@', name: 'reference-anything-update', order: -1_000, showGroupTitle: false,
    async candidates(session, request) {
      if (request.quoted || request.query.trim()) return []
      let update: PackageUpdateStatus | undefined
      try { update = await status() } catch { return [] }
      if (request.signal.aborted) return []
      latest = update
      if (!latest?.updateAvailable || latest.latestVersion === dismissed) return []
      const version = latest.latestVersion
      return [{
        name: t('menu.updateAvailable', { version }), value: version,
        description: t('settings.showReleaseNotes'),
        icon: () => <UpdateIcon label={t('menu.dismissUpdate', { version })} dismiss={() => {
          dismissed = version
          try { window.localStorage.setItem(DISMISSED_VERSION, version) } catch { /* Keep dismissal for this session. */ }
          updateMenu({ sessionId: session.sessionId, source: source.name, query: request.query, candidates: [], reopen: false })
        }} />,
      }]
    },
    onPick({ candidate }) {
      if (!latest || candidate.value !== latest.latestVersion) return 'handled'
      if (!host) { host = document.createElement('div'); document.body.append(host); root = createRoot(host) }
      root!.render(<UpdateDialog key={latest.latestVersion} update={latest} install={install} t={t}
        close={() => { root?.render(null) }} />)
      return 'handled'
    },
    dispose() { root?.unmount(); root = undefined; host?.remove(); host = undefined },
  }
  return source
}

function UpdateIcon({ label, dismiss }: { label: string; dismiss(): void }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    // The host hides icon wrappers from accessibility; this icon also carries an action.
    const wrapper = ref.current?.parentElement
    const hidden = wrapper?.getAttribute('aria-hidden')
    wrapper?.removeAttribute('aria-hidden')
    return () => { if (hidden !== null && hidden !== undefined) wrapper?.setAttribute('aria-hidden', hidden) }
  }, [])
  return <span ref={ref} className="dsh_ref_update_icon"><span aria-hidden="true">↑</span>
    <span role="button" tabIndex={0} className="dsh_ref_update_dismiss" aria-label={label} title={label}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation() }}
      onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); dismiss() }
      }}
      onClick={event => { event.preventDefault(); event.stopPropagation(); dismiss() }}>×</span>
  </span>
}

export function UpdateDialog({ update, install, close, t }: {
  update: PackageUpdateStatus; install(): Promise<PackageUpdateResult>; close(): void; t: T
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PackageUpdateResult>()
  return <Modal open onClose={() => { if (!busy) close() }} title={t('menu.updateAvailable', { version: update.latestVersion })}
    closeLabel={t('menu.closeUpdate')} description={t('settings.updateAvailableDetail', { current: update.currentVersion, latest: update.latestVersion })}
    footer={<Button disabled={busy || Boolean(result)} onClick={async () => {
      if (busy || result) return
      setBusy(true); setError('')
      try { setResult(await install()) } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
      finally { setBusy(false) }
    }}>{t(busy ? 'settings.updating' : 'settings.updateNow', { version: update.latestVersion })}</Button>}>
    <div className="dsh_ref_update_markdown"><ReactMarkdown disallowedElements={['img']}
      components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
      {update.releaseNotes || t('menu.noReleaseNotes')}
    </ReactMarkdown></div>
    {update.releaseUrl && <a href={update.releaseUrl} target="_blank" rel="noreferrer">{t('settings.fullReleaseNotes')}</a>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">{t(result.restartRequired ? 'notice.updateInstalled' : 'notice.upToDate', { version: result.version })}</p>}
  </Modal>
}
