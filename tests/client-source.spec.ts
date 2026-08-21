import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_SOURCE, CONVERSATION_SOURCE, agentReferenceUri, conversationReferenceUri, createCommandSource,
  createConversationSource, createFileSource, createLocalAgentSource, createSearchDebounce, createSessionSource, createSkillSource,
  describeRow, disambiguate, parseQuery, scopedQuery, workspaceIconKind,
  type PickerSourceOptions,
} from '../src/client/source.ts'
import { AGENT_ICON_MARKER, PICKER_ICON_MARKER } from '../src/client/provider-icons.tsx'
import type { PickerMenuUpdate } from '../src/client/menu-update.ts'
import type { AgentCandidate, SearchResult } from '../src/client/remote.ts'
import { REFERENCE_ANYTHING_INVOCATIONS } from '../src/contract.ts'
import { decodeReferenceUri } from '../src/uri.ts'

const options = (overrides: Partial<PickerSourceOptions> = {}): PickerSourceOptions => ({
  order: 30, limit: 6, maxCandidates: 50, displayMode: 'collapse', ...overrides,
})
const session = { sessionId: 'session-1' as never }
const request = (query = '', quoted = false) => ({
  query, quoted, position: 'inline' as const, signal: new AbortController().signal,
})
const pick = (candidate: { name: string; description?: string; icon?: string; hint?: string; section?: string; value?: string }) => ({
  candidate, session, position: 'inline' as const, via: 'menu' as const,
  span: { start: 0, end: 1, draftRev: 1 },
})

describe('native @ sources', () => {
  it('uses the canonical opaque dsh-ref URI accepted by the host', () => {
    const uri = conversationReferenceUri('chatgpt\0scope\0conversation-1')
    expect(uri).toMatch(/^dsh-ref:[A-Za-z0-9_-]+$/)
    expect(decodeReferenceUri(uri)).toEqual({ source: 'web-chat', id: 'chatgpt\0scope\0conversation-1' })
  })

  it('parses provider and source scopes consistently', () => {
    expect(parseQuery('gpt:cache')).toEqual({ provider: 'chatgpt', query: 'cache' })
    expect(parseQuery('ds/cache')).toEqual({ provider: 'deepseek', query: 'cache' })
    expect(parseQuery('cache design')).toEqual({ query: 'cache design' })
    expect(scopedQuery('commands', 'commands')).toBe('')
    expect(scopedQuery('commands', 'files')).toBeUndefined()
    expect(scopedQuery('skills:creator', 'skills')).toBe('creator')
    expect(scopedQuery('外部对话', 'conversations')).toBe('')
  })

  it('describes result provenance and disambiguates duplicate menu names', () => {
    const row = searchRow({ matchedVia: 'content', snippet: '…used pgvector for…' })
    expect(describeRow(row)).toContain('ChatGPT · ')
    expect(describeRow(row)).toContain('…used pgvector for…')
    const names = disambiguate([{ name: 'New chat' }, { name: 'New chat (2)' }, { name: 'New chat' }])
    expect(names.map(item => item.name)).toEqual(['New chat', 'New chat (2)', 'New chat (3)'])
  })

  it('keeps sync as a pinned first candidate on empty query and hides it while filtering', async () => {
    const sync = vi.fn()
    const updateMenu = vi.fn((_update: PickerMenuUpdate) => true)
    const source = createConversationSource(async () => [searchRow()], undefined, options({ updateMenu }), {
      sync, status: () => undefined, lastSyncedAt: () => undefined, lastSourceResult: () => undefined,
    })
    const open = await source.candidates(session, request())
    expect(open.map(row => row.name)).toEqual(['Sync all now', 'Cache design notes'])
    expect(open[0]?.icon).toBe(PICKER_ICON_MARKER.refresh)
    expect(source.onPick(pick(open[0]!))).toBe('handled')
    expect(sync).toHaveBeenCalledOnce()
    expect(updateMenu).toHaveBeenCalledWith(expect.objectContaining({
      source: CONVERSATION_SOURCE, query: '', reopen: true, anchor: 'first',
    }))
    const filtered = await source.candidates(session, request('cache'))
    expect(filtered.map(row => row.name)).toEqual(['Cache design notes'])
    const providerScoped = await source.candidates(session, request('chatgpt'))
    expect(providerScoped.map(row => row.name)).toEqual(['Cache design notes'])
  })

  it('shows live sync progress and the previous result in the pinned action', async () => {
    const running = createConversationSource(async () => [], undefined, options(), {
      sync: vi.fn(),
      status: () => ({
        jobId: 'job', status: 'running', providers: ['chatgpt'], completed: 3, total: 10,
        providerProgress: [{ provider: 'chatgpt', phase: 'syncing', completed: 3, total: 10 }],
      }),
      lastSyncedAt: () => undefined,
      lastSourceResult: () => undefined,
    })
    expect((await running.candidates(session, request()))[0]).toMatchObject({
      name: 'Sync 3/10', description: 'An external-conversation sync is already running',
    })

    const completed = createConversationSource(async () => [], undefined, options(), {
      sync: vi.fn(),
      status: () => ({
        jobId: 'job', status: 'partial', providers: ['chatgpt', 'claude'], completed: 8, total: 10,
        providerProgress: [
          { provider: 'chatgpt', phase: 'complete', completed: 8, total: 8 },
          { provider: 'claude', phase: 'failed', completed: 0, total: 2 },
        ],
      }),
      lastSyncedAt: () => '2026-08-20T06:30:00.000Z',
      lastSourceResult: () => undefined,
    })
    const result = (await completed.candidates(session, request()))[0]!
    expect(result.name).toBe('Sync again')
    expect(result.description).toContain('Successful sources 1/2')
  })

  it('hands a plain external label and native session appearance to the Composer', async () => {
    const row = searchRow({ title: 'BiWM SFT Loss 解释' })
    const source = createConversationSource(async () => [row])
    const candidate = (await source.candidates(session, request()))[0]!
    expect(candidate.icon).toBe('')
    const outcome = source.onPick(pick(candidate))
    if (outcome === undefined || outcome === 'handled' || !('insert' in outcome)) throw new Error('expected insert')
    expect(outcome.insert).toMatchObject({
      source: CONVERSATION_SOURCE,
      label: 'ChatGPT·BiWM SFT Loss 解释',
      appearance: 'session',
    })
    expect(outcome.insert.label).not.toContain('')
    await expect(source.codec?.serialize(outcome.insert.ref, new AbortController().signal))
      .resolves.toBe(`@[ChatGPT·BiWM SFT Loss 解释](${conversationReferenceUri(row.uriId)})`)
  })

  it('does not offer conversations or sessions inside an open quoted file token', async () => {
    const conversations = createConversationSource(async () => [searchRow()])
    const sessions = createSessionSource(async () => [{
      sessionId: 'source' as never, label: 'Other', createdAt: 1, mention: '@[Other](dsh-session:abc)',
    }])
    await expect(conversations.candidates(session, request('path with', true))).resolves.toEqual([])
    await expect(sessions.candidates(session, request('path with', true))).resolves.toEqual([])
  })

  it('uses the official file grammar and native file insert without dsh-file', async () => {
    const source = createFileSource(async (_sessionId, query) => {
      expect(query).toBe('index')
      return [{ path: 'src/index.ts', kind: 'file' }]
    })
    const candidate = (await source.candidates(session, request('index')))[0]!
    expect(candidate.icon).toBe(PICKER_ICON_MARKER.code)
    const outcome = source.onPick(pick(candidate))
    if (outcome === undefined || outcome === 'handled' || !('insert' in outcome)) throw new Error('expected insert')
    expect(outcome.insert).toMatchObject({
      ref: '@src/index.ts', label: 'index.ts', appearance: 'file', clipboardText: '@src/index.ts',
    })
    await expect(source.codec?.serialize(outcome.insert.ref, new AbortController().signal)).resolves.toBe('@src/index.ts')
    expect(JSON.stringify(outcome)).not.toContain('dsh-file:')
  })

  it('keeps official quoted-directory completion editable', async () => {
    const source = createFileSource(async () => [{ path: 'docs with space', kind: 'directory' }])
    const candidate = (await source.candidates(session, request('docs with', true)))[0]!
    expect(source.onPick(pick(candidate))).toEqual({ text: '@"docs with space/', continue: true })
  })

  it('classifies official file candidates for menu logo projection', () => {
    expect(workspaceIconKind({ path: 'assets/hero.PNG', kind: 'file' })).toBe('image')
    expect(workspaceIconKind({ path: 'src/index.ts', kind: 'file' })).toBe('code')
    expect(workspaceIconKind({ path: 'exports/report.xlsx', kind: 'file' })).toBe('spreadsheet')
    expect(workspaceIconKind({ path: 'unknown/model.bin', kind: 'file' })).toBe('file')
    expect(workspaceIconKind({ path: 'src', kind: 'directory' })).toBe('folder')
  })

  it('passes through the official canonical dsh-session mention', async () => {
    const mention = '@[项目聊天导出](dsh-session:InNvdXJjZSI)'
    const source = createSessionSource(async () => [{
      sessionId: 'source' as never, label: '项目聊天导出', cwd: 'fixture-repo', createdAt: 1, mention,
    }])
    const candidate = (await source.candidates(session, request()))[0]!
    expect(candidate.icon).toBe(PICKER_ICON_MARKER.session)
    expect(candidate.description).toBe(`fixture-repo · ${new Date(1).toLocaleString()}`)
    const outcome = source.onPick(pick(candidate))
    if (outcome === undefined || outcome === 'handled' || !('insert' in outcome)) throw new Error('expected insert')
    expect(outcome.insert).toMatchObject({
      ref: mention, label: '项目聊天导出', appearance: 'session', clipboardText: mention,
    })
  })

  it('keeps Commands and Skills in @ while returning native slash text', async () => {
    const commands = createCommandSource(async () => [{ name: 'plan', description: 'Plan mode' }])
    const command = (await commands.candidates(session, request('pla')))[0]!
    expect(command).toMatchObject({ name: 'plan', icon: PICKER_ICON_MARKER.command })
    expect(commands.onPick(pick(command))).toEqual({ text: '/plan' })

    const skills = createSkillSource(async () => [{ name: 'review', description: 'Review code', modelInvocable: false }])
    const skill = (await skills.candidates(session, request('rev')))[0]!
    expect(skill).toMatchObject({ name: 'review', icon: PICKER_ICON_MARKER.skill })
    expect(skill.description).toContain('user-only')
    expect(skills.onPick(pick(skill))).toEqual({ text: '/review ' })
  })

  it('expands a collapsed source by at most five rows per click', async () => {
    const rows = Array.from({ length: 14 }, (_, index) => searchRow({ uriId: String(index), title: `Row ${index}` }))
    const updateMenu = vi.fn((_update: PickerMenuUpdate) => true)
    const source = createConversationSource(async (_query, _provider, _signal, limit) => {
      expect(limit).toBe(12)
      return rows
    }, undefined, options({ order: 77, limit: 2, maxCandidates: 12, updateMenu }))
    const candidates = await source.candidates(session, request('row'))
    expect(source.order).toBe(77)
    expect(candidates.map(row => row.name)).toEqual(['Row 0', 'Row 1', 'Show 5 more'])
    expect(source.onPick(pick(candidates.at(-1)!))).toBe('handled')
    expect(updateMenu).toHaveBeenLastCalledWith(expect.objectContaining({
      source: CONVERSATION_SOURCE, query: 'row', reopen: true, anchor: 'viewport',
    }))
    const firstPage = updateMenu.mock.calls.at(-1)![0].candidates
    expect(firstPage.map(row => row.name)).toEqual([
      'Row 0', 'Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5', 'Row 6', 'Show 5 more', 'Collapse',
    ])
    expect(source.onPick(pick(firstPage.find(row => row.name === 'Show 5 more')!))).toBe('handled')
    expect(updateMenu).toHaveBeenLastCalledWith(expect.objectContaining({ reopen: true, anchor: 'viewport' }))
    const secondPage = updateMenu.mock.calls.at(-1)![0].candidates
    expect(secondPage.map(row => row.name)).toEqual([
      'Row 0', 'Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5', 'Row 6',
      'Row 7', 'Row 8', 'Row 9', 'Row 10', 'Row 11', 'Collapse',
    ])
    expect(source.onPick(pick(secondPage.at(-1)!))).toBe('handled')
    expect(updateMenu).toHaveBeenLastCalledWith(expect.objectContaining({ reopen: true, anchor: 'last' }))
    await expect(source.candidates(session, request('row'))).resolves.toMatchObject([
      { name: 'Row 0' }, { name: 'Row 1' }, { name: 'Show 5 more' },
    ])
  })

  it('uses all capped rows in native-scroll mode and omits expand controls', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => searchRow({ uriId: String(index), title: `Row ${index}` }))
    const source = createConversationSource(async () => rows, undefined, options({
      limit: 2, maxCandidates: 5, displayMode: 'native-scroll',
    }))
    await expect(source.candidates(session, request('row'))).resolves.toHaveLength(5)
  })

  it('declares only plugin-owned search cancellation on its Remote face', () => {
    expect(REFERENCE_ANYTHING_INVOCATIONS.find(item => item.method === 'search')?.cancellation)
      .toEqual({ parameter: 'signal' })
    expect(REFERENCE_ANYTHING_INVOCATIONS.some(item => item.method === 'workspaceSearch')).toBe(false)
    expect(REFERENCE_ANYTHING_INVOCATIONS.some(item => item.method === 'sessionSearch')).toBe(false)
    expect(REFERENCE_ANYTHING_INVOCATIONS.find(item => item.method === 'agentSearch')?.cancellation)
      .toEqual({ parameter: 'signal' })
    expect(REFERENCE_ANYTHING_INVOCATIONS.find(item => item.method === 'switchReferenceUiMode')?.cancellation)
      .toEqual({ parameter: 'signal' })
  })
})

describe('local agent conversations', () => {
  const agentRow = (over: Partial<AgentCandidate> = {}): AgentCandidate => ({
    id: 'codex:2026/08/rollout-a.jsonl', kind: 'codex', label: 'Refactor the scan probe',
    provider: 'Codex', updatedAt: Date.UTC(2026, 7, 17), ...over,
  })

  it('uses the canonical opaque dsh-ref URI, so the host dispatches to the local-agent source', () => {
    const uri = agentReferenceUri('claude-code:project-a/session.jsonl')
    expect(uri).toMatch(/^dsh-ref:[A-Za-z0-9_-]+$/)
    expect(decodeReferenceUri(uri)).toEqual({ source: 'local-agent', id: 'claude-code:project-a/session.jsonl' })
    // The transcript path never appears verbatim in the URI a mention carries.
    expect(uri).not.toContain('project-a')
  })

  it('routes hyphenated agent spellings here while bare provider names keep meaning the browser chat', () => {
    expect(scopedQuery('agents', 'agents')).toBe('')
    expect(scopedQuery('codex:probe', 'agents')).toBe('probe')
    expect(scopedQuery('claude-code:probe', 'agents')).toBe('probe')
    expect(scopedQuery('codex:probe', 'conversations')).toBeUndefined()
    // The near-collision that makes this group risky: `claude` and `gemini`
    // were already taken by External conversations and must stay taken.
    expect(scopedQuery('claude:probe', 'conversations')).toBe('probe')
    expect(scopedQuery('claude:probe', 'agents')).toBeUndefined()
    expect(scopedQuery('gemini:probe', 'agents')).toBeUndefined()
    expect(scopedQuery('gemini-cli:probe', 'agents')).toBe('probe')
    expect(scopedQuery('grok:probe', 'conversations')).toBe('probe')
    expect(scopedQuery('grok:probe', 'agents')).toBeUndefined()
    expect(scopedQuery('grokbuild:probe', 'agents')).toBe('probe')
    expect(scopedQuery('kimi:probe', 'conversations')).toBe('probe')
    expect(scopedQuery('kimi:probe', 'agents')).toBeUndefined()
    expect(scopedQuery('kimi-cli:probe', 'agents')).toBe('probe')
    expect(scopedQuery('本地对话', 'agents')).toBe('')
  })

  it('gives every format whose name is not already taken a prefix of its own', () => {
    for (const prefix of ['cursor', 'qoder', 'reasonix', 'openclaw', 'hermes', 'pi', 'opencode', 'mimocode', 'zcode']) {
      expect(scopedQuery(`${prefix}:probe`, 'agents')).toBe('probe')
      expect(scopedQuery(`${prefix}:probe`, 'files')).toBeUndefined()
    }
  })

  it('names the writing agent on the row and numbers transcripts that share a title', async () => {
    const source = createLocalAgentSource(async () => [
      agentRow(),
      agentRow({ id: 'codex:2026/08/rollout-b.jsonl' }),
      agentRow({ id: 'claude-code:p/x.jsonl', label: '', provider: 'Claude Code', updatedAt: undefined }),
    ], undefined, options({ order: 25 }))
    const candidates = await source.candidates(session, request('agents'))
    expect(source.name).toBe(AGENT_SOURCE)
    expect(candidates.map(row => row.name)).toEqual(['Refactor the scan probe', 'Refactor the scan probe (2)', 'Untitled'])
    expect(candidates[0]?.icon).toBe(AGENT_ICON_MARKER)
    expect(candidates[0]?.description).toContain('Codex')
    // A transcript whose mtime the host could not report still gets a row; the
    // date is the only part that goes missing.
    expect(candidates[2]?.description).toBe('Claude Code')
  })

  it('inserts a native session chip while serializing the canonical mention on send', async () => {
    const row = agentRow()
    const source = createLocalAgentSource(async () => [row], undefined, options({ order: 25 }))
    const candidate = (await source.candidates(session, request()))[0]!
    const outcome = source.onPick(pick(candidate))
    if (outcome === undefined || outcome === 'handled' || !('insert' in outcome)) throw new Error('expected insert')
    expect(outcome.insert).toMatchObject({
      source: AGENT_SOURCE, label: 'Codex·Refactor the scan probe', appearance: 'session',
    })
    // The separator stays adjacent, and the marker stays out of the label, so
    // the user-bubble renderer does not re-project `Codex` as a pill of its own.
    expect(outcome.insert.label).not.toContain(AGENT_ICON_MARKER)
    await expect(source.codec?.serialize(outcome.insert.ref, new AbortController().signal))
      .resolves.toBe(`@[Codex·Refactor the scan probe](${agentReferenceUri(row.id)})`)
    expect(source.codec?.clipboardText(outcome.insert.ref)).toBe(`@[Codex·Refactor the scan probe](${agentReferenceUri(row.id)})`)
  })

  it('escapes a title that would otherwise break out of the mention it is written into', async () => {
    const row = agentRow({ label: 'why does ](evil) fail', provider: '' })
    const source = createLocalAgentSource(async () => [row], undefined, options({ order: 25 }))
    const candidate = (await source.candidates(session, request()))[0]!
    const outcome = source.onPick(pick(candidate))
    if (outcome === undefined || outcome === 'handled' || !('insert' in outcome)) throw new Error('expected insert')
    await expect(source.codec?.serialize(outcome.insert.ref, new AbortController().signal))
      .resolves.toBe(`@[why does (evil) fail](${agentReferenceUri(row.id)})`)
  })

  it('stays out of a query scoped to another group and out of an open quoted file token', async () => {
    const source = createLocalAgentSource(async () => [agentRow()], undefined, options({ order: 25 }))
    await expect(source.candidates(session, request('files:index'))).resolves.toEqual([])
    await expect(source.candidates(session, request('path with', true))).resolves.toEqual([])
  })
})

describe('search debounce', () => {
  it('answers an empty query immediately', async () => {
    const debounce = createSearchDebounce<string>()
    await expect(debounce.run('', new AbortController().signal, async () => ['row'])).resolves.toEqual(['row'])
  })

  it('drops a superseded query and always refetches repeated queries', async () => {
    const debounce = createSearchDebounce<string>()
    const controller = new AbortController()
    const pending = debounce.run('cache', controller.signal, async () => ['stale'])
    controller.abort()
    await expect(pending).resolves.toEqual([])
    let fetches = 0
    const run = () => debounce.run('', new AbortController().signal, async () => { fetches++; return ['row'] })
    await run(); await run()
    expect(fetches).toBe(2)
  })
})

function searchRow(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    uriId: 'id', provider: 'chatgpt', title: 'Cache design notes', url: 'https://example.test/c/1',
    updatedAt: '2026-08-17T00:00:00.000Z', turnCount: 24, partial: false,
    syncedAt: '2026-08-17T00:00:00.000Z', matchedVia: 'title', ...overrides,
  }
}
