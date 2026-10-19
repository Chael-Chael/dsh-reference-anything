// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { en } from '../src/client/locale.ts'
import type { SettingsSnapshot } from '../src/client/components.tsx'
import { AGENT_SOURCE, CONVERSATION_SOURCE, FILE_SOURCE, PLUGIN_SOURCE, SESSION_SOURCE } from '../src/client/source.ts'
import { ALL_LOCAL_AGENTS, ALL_PROVIDERS, defaultPickerSettings, settingsRecordSchema, type SettingsRecord } from '../src/wire.ts'

it('removes and restores the plugin source immediately through the settings save action', async () => {
  let settings = settingsRecordSchema.parse({
    opencliPath: 'opencli', profile: '', detailConcurrency: 2, autoSync: false,
    autoSyncMinutes: 60, historyMode: 'metadata-only', picker: defaultPickerSettings(),
  })
  settings.picker!.agents.sourceAliases = { 'claude-code': ['cc'], codex: [], cursor: [] }
  settings.picker!.conversations.sourceAliases = { claude: ['webclaude'], chatgpt: [] }
  const ok = <T,>(value: T) => ({ ok: true, value })
  const remote = {
    settingsGet: async () => ok(settings),
    settingsUpdate: vi.fn(async (value: SettingsRecord) => ok(settings = settingsRecordSchema.parse(value))),
    quickHealth: vi.fn(async () => ok({ version: '2.0.0' })),
    health: vi.fn(async () => ok({ version: '2.0.0', extensionUpdateAvailable: true, latestExtensionVersion: '2.1.0' })),
    search: vi.fn(async () => ok([])),
    agentSearch: vi.fn(async () => ok([])),
    storageStats: async () => ok({}), stats: async () => ok([]), agentStats: async () => ok([]),
    chatImportStatus: async () => ok({ state: 'incompatible', version: '0.25.2', missing: ['importPath'], canUpgrade: true }),
    openListStatus: async () => ok({}), updateStatus: async () => ok({ updateAvailable: false }),
    localPlugins: vi.fn(async () => ok([{ id: 'local', name: 'local', label: 'local', status: 'live' }])),
  }
  const sources = new Map<string, InputTriggerSource>()
  let retained = false
  let bound = true
  let openState = 'open'
  const openError = new Error('session open failed')
  const binding = { session: { getSnapshot: () => ({ openState, openError }) } }
  const using = vi.fn(async (_id, _options, operation) => {
    retained = true
    try { return await operation({ binding }) } finally { retained = false }
  })
  const fileList = vi.fn(async () => { expect(retained).toBe(true); return ok([]) })
  const openResource = vi.fn()
  const listed = { empty: { blank: true }, populated: { blank: false } }
  const sessionCandidates = vi.fn(async () => ok(['empty', 'populated', 'unknown'].map(sessionId => ({
    sessionId, label: sessionId, mention: `@[${sessionId}](dsh-session:${sessionId})`, createdAt: 1, sameWorkspace: true,
  }))))
  const effects: Array<Promise<unknown>> = []
  let snapshot!: () => SettingsSnapshot
  let save!: (settings: SettingsRecord) => Promise<boolean>
  const ctx = {
    effect: (run: () => unknown) => { effects.push(Promise.resolve(run())) },
    remote: { $mount: async () => () => {}, fileReferences: { list: fileList }, sessionReferenceResolver: { candidates: sessionCandidates } }, reflect: { get: () => remote },
    sidebarRight: { openResource },
    get: () => ({ registerSource: (source: InputTriggerSource) => {
      sources.set(source.name, source)
      return () => { sources.delete(source.name) }
    } }),
    locale: { register: () => () => {}, bind: () => (key: keyof typeof en) => en[key] },
    sessions: { scope: () => undefined, binding: () => bound ? binding : undefined, using, list: { getSnapshot: () => ({ byId: listed }) } },
    inputTriggers: { sessionOf: vi.fn() },
    slots: {
      inject: (_name: string, run: () => unknown) => run(),
      register: (section: { inject: () => { save: typeof save; hooks: { scope: { getSnapshot(): SettingsSnapshot } } } }) => { const props = section.inject(); save = props.save; snapshot = () => props.hooks.scope.getSnapshot() },
    },
  } as unknown as Context
  apply(ctx)
  const disposers = await Promise.all(effects)
  try {
    await vi.waitFor(() => expect(snapshot().chatImport).toMatchObject({ state: 'incompatible', canUpgrade: true }))
    expect(snapshot().agentStats).toEqual([])
    await vi.waitFor(() => expect(remote.quickHealth).toHaveBeenCalledOnce())
    const web = sources.get(CONVERSATION_SOURCE)!
    const session = { sessionId: 'health-test' as never }
    const request = { query: '', quoted: false, position: 'inline' as const, drilled: false, signal: new AbortController().signal }
    const native = sources.get('reference')
    expect(native, 'Desktop drops and file pastes require the native reference owner').toBeDefined()
    expect(await native!.candidates(session, request)).toEqual([])
    for (const ref of ['@README.md', '@docs/', '@"D:/demo folder/readme.md"', '@"D:/demo folder/"', '@[Existing session](dsh-session:existing)']) {
      expect(await native!.codec!.serialize(ref, request.signal)).toBe(ref)
      expect(native!.codec!.clipboardText(ref)).toBe(ref)
    }
    expect(native!.openReference!(session, { ref: '@"docs/a #?.md"', appearance: 'file' })).toBe(true)
    expect(openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/health-test/docs/a%20%23%3F.md')
    expect(native!.openReference!(session, { ref: '@docs/', appearance: 'folder' })).toBe(false)
    const dshSessions = sources.get(SESSION_SOURCE)!
    expect((await dshSessions.candidates(session, request)).map(row => row.name)).toEqual(['populated', 'unknown'])
    expect(using).toHaveBeenCalledWith(session.sessionId, { source: 'referenceCandidates', signal: request.signal }, expect.any(Function))
    expect(retained).toBe(false)
    const files = sources.get(FILE_SOURCE)!
    await files.candidates(session, request)
    expect(files.openReference!(session, { ref: '@"docs/a #?.md"', appearance: 'file' })).toBe(true)
    expect(openResource).toHaveBeenCalledWith('dsh-resource://file/session/health-test/docs/a%20%23%3F.md')
    expect(files.openReference!(session, { ref: '@docs/', appearance: 'folder' })).toBe(false)
    for (const source of [files, dshSessions]) {
      bound = false
      await expect(source.candidates(session, request)).rejects.toThrow('retained session')
      bound = true
      openState = 'error'
      await expect(source.candidates(session, request)).rejects.toBe(openError)
      expect(retained).toBe(false)
      openState = 'open'
      const controller = new AbortController()
      controller.abort()
      await expect(source.candidates(session, { ...request, signal: controller.signal })).rejects.toThrow()
    }
    fileList.mockRejectedValueOnce(new Error('lookup failed'))
    await expect(files.candidates(session, request)).rejects.toThrow('lookup failed')
    expect(retained).toBe(false)
    listed.empty.blank = false
    expect((await dshSessions.candidates(session, request)).map(row => row.name)).toEqual(['empty', 'populated', 'unknown'])
    await web.candidates(session, request)
    await vi.waitFor(() => expect(snapshot().health?.extensionUpdateAvailable).toBe(true))
    await web.candidates(session, request)
    expect(remote.health).toHaveBeenCalledOnce()
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    try {
      await web.candidates(session, request)
      await vi.waitFor(() => expect(remote.health).toHaveBeenCalledTimes(2))
    } finally { now.mockRestore() }

    for (const kind of ALL_LOCAL_AGENTS) {
      await sources.get(AGENT_SOURCE)!.candidates(session, { ...request, query: `${kind}:` })
      expect(remote.agentSearch).toHaveBeenLastCalledWith(session.sessionId, { query: '', limit: 100, kind }, expect.anything())
    }
    for (const [alias, kind] of Object.entries({ cc: 'claude-code', 'kimi-cli': 'kimi', 'kimi-code': 'kimi', 'grok-build': 'grokbuild', mimo: 'mimocode' })) {
      await sources.get(AGENT_SOURCE)!.candidates(session, { ...request, query: `${alias}:` })
      expect(remote.agentSearch).toHaveBeenLastCalledWith(session.sessionId, { query: '', limit: 100, kind }, expect.anything())
    }
    for (const provider of ALL_PROVIDERS) {
      await sources.get(CONVERSATION_SOURCE)!.candidates(session, { ...request, query: `${provider}:` })
      expect(remote.search).toHaveBeenLastCalledWith({ query: '', provider, limit: 50 }, expect.anything())
    }
    await sources.get(CONVERSATION_SOURCE)!.candidates(session, { ...request, query: 'webclaude:' })
    expect(remote.search).toHaveBeenLastCalledWith({ query: '', provider: 'claude', limit: 50 }, expect.anything())

    expect(sources.has(PLUGIN_SOURCE)).toBe(true)
    const originalSources = [...sources.keys()]
    expect(await save({ ...settings, picker: { ...settings.picker!, plugins: { ...settings.picker!.plugins, enabled: false } } })).toBe(true)
    expect(sources.has(PLUGIN_SOURCE)).toBe(false)
    expect([...sources.keys()]).toEqual(originalSources.filter(name => name !== PLUGIN_SOURCE))
    expect(settings.picker?.plugins.enabled).toBe(false)
    expect(await save({ ...settings, picker: { ...settings.picker!, plugins: { ...settings.picker!.plugins, enabled: true } } })).toBe(true)
    expect([...sources.keys()]).toEqual(originalSources)
    expect(await save({ ...settings, picker: { ...settings.picker!, files: { ...settings.picker!.files, enabled: false } } })).toBe(true)
    expect(sources.has(FILE_SOURCE)).toBe(false)
    expect(sources.get('reference')).toBe(native)
    expect(await native!.codec!.serialize('@README.md', request.signal)).toBe('@README.md')
  } finally {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose()
  }
  expect(sources.has('reference')).toBe(false)
})
