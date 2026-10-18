import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { SettingsSnapshot } from './components.tsx'
import { createRoot, type Root } from 'react-dom/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import ReactMarkdown from 'react-markdown'
import type { TranslateNS, LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PackageUpdateResult, PackageUpdateStatus } from './remote.ts'
import type { PickerMenuUpdater } from './menu-update.ts'
import { releaseFeaturesFor } from './release-features.ts'

type T = TranslateNS<'reference-anything'>
type ReleaseLocale = Pick<LocaleRuntime, 'getSnapshot' | 'subscribe'>
const noSubscribe = () => () => {}
const defaultLanguage = () => 'zh'
const DISMISSED_VERSION = 'dsh-reference-anything.dismissed-update'
const DISMISSED_RELEASE = 'dsh-reference-anything.dismissed-release'
const AUTO_SHOWN_RELEASE = 'dsh-reference-anything.auto-shown-release'

export function SettingsReleaseIntro({ useScope, shown, install, t, locale }: {
  useScope: SnapshotSelectorHook<SettingsSnapshot>; shown: Set<string>
  install(): Promise<PackageUpdateResult>; t: T; locale?: ReleaseLocale
}) {
  const update = useScope(state => state.update)
  const [intro, setIntro] = useState<PackageUpdateStatus>()
  const openIntro = useCallback(() => {
    if (!update || !update.currentVersion || update.currentVersion === '0.0.0') return
    const version = update.currentVersion
    setIntro({
      ...update, latestVersion: version, updateAvailable: false,
      releaseNotes: update.currentReleaseNotes ?? (version === update.latestVersion ? update.releaseNotes : undefined),
      releaseUrl: update.currentReleaseUrl ?? (version === update.latestVersion ? update.releaseUrl : undefined),
    })
  }, [update])
  useEffect(() => {
    const version = update?.currentVersion
    if (!update || !version || version === '0.0.0' || shown.has(version)) return
    try { if (window.localStorage.getItem(AUTO_SHOWN_RELEASE) === version) return } catch { /* Retain session memory when storage is disabled. */ }
    shown.add(version)
    openIntro()
    try { window.localStorage.setItem(AUTO_SHOWN_RELEASE, version) } catch { /* Already remembered for this session. */ }
  }, [update, shown, openIntro])
  return <>
    {update?.currentVersion && update.currentVersion !== '0.0.0' && <Button type="button" aria-haspopup="dialog" onClick={openIntro}>{t('settings.showReleaseIntro')}</Button>}
    {intro && <UpdateDialog key={intro.currentVersion} update={intro} install={install} t={t} locale={locale} close={() => setIntro(undefined)} />}
  </>

}

export function createUpdateSource(
  status: () => Promise<PackageUpdateStatus | undefined>,
  install: () => Promise<PackageUpdateResult>,
  updateMenu: PickerMenuUpdater,
  t: T,
  locale?: ReleaseLocale,
): InputTriggerSource & { dispose(): void } {
  let dismissed: string | undefined
  try { dismissed = window.localStorage.getItem(DISMISSED_VERSION) ?? undefined } catch { /* Storage may be disabled. */ }
  let dismissedRelease: string | undefined
  try { dismissedRelease = window.localStorage.getItem(DISMISSED_RELEASE) ?? undefined } catch { /* Storage may be disabled. */ }
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
      if (!update) return []
      const current: PackageUpdateStatus = {
        ...update, latestVersion: update.currentVersion, updateAvailable: false,
        releaseNotes: update.currentReleaseNotes ?? (update.currentVersion === update.latestVersion ? update.releaseNotes : undefined),
        releaseUrl: update.currentReleaseUrl ?? (update.currentVersion === update.latestVersion ? update.releaseUrl : undefined),
      }
      const rows = () => [
        ...(update.updateAvailable && update.latestVersion !== dismissed ? [update] : []),
        ...(update.currentVersion && update.currentVersion !== '0.0.0' && update.currentVersion !== dismissedRelease ? [current] : []),
      ].map(item => {
        const version = item.latestVersion
        const isUpdate = item.updateAvailable
        return {
          name: t(isUpdate ? 'menu.updateAvailable' : 'menu.currentRelease', { version }),
          value: `${isUpdate ? 'update' : 'release'}:${version}`,
          description: t('settings.showReleaseNotes'),
          icon: () => <UpdateIcon label={t(isUpdate ? 'menu.dismissUpdate' : 'menu.dismissCurrentRelease', { version })} dismiss={() => {
            if (isUpdate) dismissed = version
            else dismissedRelease = version
            try { window.localStorage.setItem(isUpdate ? DISMISSED_VERSION : DISMISSED_RELEASE, version) } catch { /* Keep dismissal for this session. */ }
            updateMenu({ sessionId: session.sessionId, source: source.name, query: request.query, candidates: rows(), reopen: false })
          }} />,
        }
      })
      return rows()
    },
    onPick({ candidate }) {
      if (!latest) return 'handled'
      const isCurrent = candidate.value === `release:${latest.currentVersion}`
      if (!isCurrent && candidate.value !== `update:${latest.latestVersion}`) return 'handled'
      const update = isCurrent ? {
        ...latest, latestVersion: latest.currentVersion, updateAvailable: false,
        releaseNotes: latest.currentReleaseNotes ?? (latest.currentVersion === latest.latestVersion ? latest.releaseNotes : undefined),
        releaseUrl: latest.currentReleaseUrl ?? (latest.currentVersion === latest.latestVersion ? latest.releaseUrl : undefined),
      } : latest
      if (!host) { host = document.createElement('div'); document.body.append(host); root = createRoot(host) }
      root!.render(<UpdateDialog key={candidate.value} update={update} install={install} t={t} locale={locale}
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

export function UpdateDialog({ update, install, close, t, locale }: {
  update: PackageUpdateStatus; install(): Promise<PackageUpdateResult>; close(): void; t: T; locale?: ReleaseLocale
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PackageUpdateResult>()
  const [page, setPage] = useState(0)
  const subscribe = useCallback((notify: () => void) => locale ? locale.subscribe(notify) : noSubscribe(), [locale])
  const language = useSyncExternalStore(subscribe, locale ? () => locale.getSnapshot().active : defaultLanguage)
  const features = releaseFeaturesFor(update.latestVersion, language)
  const feature = features[page]
  return <Modal open className="dsh_ref_update_dialog" onClose={() => { if (!busy) close() }} title={feature?.title ?? t(update.updateAvailable ? 'menu.updateAvailable' : 'menu.currentRelease', { version: update.latestVersion })}
    closeLabel={t('menu.closeUpdate')} description={update.updateAvailable ? t('settings.updateAvailableDetail', { current: update.currentVersion, latest: update.latestVersion }) : t('menu.installedVersion', { version: update.currentVersion })}
    footer={<div className="dsh_ref_release_footer">
      {update.updateAvailable && <Button disabled={busy || Boolean(result)} onClick={async () => {
      if (busy || result) return
      setBusy(true); setError('')
      try { setResult(await install()) } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
      finally { setBusy(false) }
    }}>{t(busy ? 'settings.updating' : 'settings.updateNow', { version: update.latestVersion })}</Button>}
      {feature && <nav className="dsh_ref_release_navigation" aria-label={t('release.navigation')}>
        <span aria-live="polite">{page + 1} / {features.length}</span>
        <Button disabled={page === 0} onClick={() => { setPage(value => Math.max(0, value - 1)) }}>{t('release.previous')}</Button>
        <Button disabled={page === features.length - 1} onClick={() => { setPage(value => Math.min(features.length - 1, value + 1)) }}>{t('release.next')}</Button>
      </nav>}
    </div>}>
    {feature ? <article className="dsh_ref_release_feature" aria-label={feature.title}>
      {feature.media && <div className="dsh_ref_release_media"><img key={feature.media} src={feature.media} alt={feature.alt} /></div>}
      <div className="dsh_ref_release_description"><ReactMarkdown disallowedElements={['img']}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
        {feature.description}
      </ReactMarkdown></div>
    </article> : <div className="dsh_ref_update_markdown"><ReactMarkdown disallowedElements={['img']}
      components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
      {update.releaseNotes || t('menu.noReleaseNotes')}
    </ReactMarkdown></div>}
    {!feature && update.releaseUrl && <a href={update.releaseUrl} target="_blank" rel="noreferrer">{t('settings.fullReleaseNotes')}</a>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">{t(result.restartRequired ? 'notice.updateInstalled' : 'notice.upToDate', { version: result.version })}</p>}
  </Modal>
}
