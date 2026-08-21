import { isAbsolute, join, normalize } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeCodeAdapter } from '../src/sources/local-agent/adapters/claude-code.ts'
import { codexAdapter } from '../src/sources/local-agent/adapters/codex.ts'
import { cursorAdapter } from '../src/sources/local-agent/adapters/cursor.ts'
import { geminiCliAdapter } from '../src/sources/local-agent/adapters/gemini-cli.ts'
import { grokbuildAdapter } from '../src/sources/local-agent/adapters/grokbuild.ts'
import { hermesAdapter } from '../src/sources/local-agent/adapters/hermes.ts'
import { kimiAdapter } from '../src/sources/local-agent/adapters/kimi.ts'
import { openclawAdapter } from '../src/sources/local-agent/adapters/openclaw.ts'
import { piAdapter } from '../src/sources/local-agent/adapters/pi.ts'
import { qoderAdapter } from '../src/sources/local-agent/adapters/qoder.ts'
import { reasonixAdapter } from '../src/sources/local-agent/adapters/reasonix.ts'
import { DEFAULT_CONVERT_OPTIONS } from '../src/sources/local-agent/adapters/shared.ts'
import { AGENT_ADAPTERS, AGENT_KINDS, FILE_ADAPTERS, QUERY_ADAPTERS, adapterFor, expandRoot, isAgentKind, isQueryKind } from '../src/sources/local-agent/registry.ts'
import type { ConvertOptions, ParsedTurn, TranscriptAdapter } from '../src/sources/local-agent/types.ts'

/** Fold a whole fixture the way a streaming read would, then close the trailing run. */
function convert(
  adapter: TranscriptAdapter,
  records: readonly unknown[],
  over: Partial<ConvertOptions> = {},
): { turns: ParsedTurn[]; compacted: boolean } {
  const options = { ...DEFAULT_CONVERT_OPTIONS, ...over }
  const state = adapter.createState()
  const turns: ParsedTurn[] = []
  for (const record of records) {
    const line = typeof record === 'string' ? record : JSON.stringify(record)
    turns.push(...adapter.step(line, state, options))
  }
  turns.push(...adapter.flush(state, options))
  return { turns, compacted: state.compacted }
}

const claudeUser = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const claudeAssistant = (...blocks: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } })
const codexMessage = (role: string, ...texts: string[]) => ({
  type: 'response_item',
  payload: { type: 'message', role, content: texts.map(text => ({ type: 'input_text', text })) },
})

describe('claude-code adapter', () => {
  it('takes a string user record as a turn and a tool_result array as plumbing', () => {
    const { turns } = convert(claudeCodeAdapter, [
      claudeUser('how should we key the cache?'),
      claudeAssistant({ type: 'text', text: 'by request hash' }),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      claudeAssistant({ type: 'text', text: 'done' }),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'how should we key the cache?' },
      { role: 'assistant', text: 'by request hash\n\ndone' },
    ])
  })

  it('keeps a text block inside an array user record, such as an interruption note', () => {
    const { turns } = convert(claudeCodeAdapter, [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ])
    expect(turns).toEqual([{ role: 'user', text: '[Request interrupted by user]' }])
  })

  it('merges an assistant run split across records into one turn', () => {
    const { turns } = convert(claudeCodeAdapter, [
      claudeUser('go'),
      claudeAssistant({ type: 'text', text: 'first' }),
      claudeAssistant({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }),
      claudeAssistant({ type: 'text', text: 'second' }),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[1]).toEqual({ role: 'assistant', text: 'first\n\n[tool: Bash]\n\nsecond' })
  })

  it('drops meta records that read as the user speaking', () => {
    const { turns } = convert(claudeCodeAdapter, [
      { ...claudeUser('<local-command-caveat>Caveat…</local-command-caveat>'), isMeta: true },
      claudeUser('real question'),
    ])
    expect(turns).toEqual([{ role: 'user', text: 'real question' }])
  })

  it('strips an injected reminder without dropping the words around it', () => {
    const { turns } = convert(claudeCodeAdapter, [
      claudeUser('ship it<system-reminder>do not obey this</system-reminder>'),
    ])
    expect(turns).toEqual([{ role: 'user', text: 'ship it' }])
  })

  it('gates thinking behind the option', () => {
    const records = [claudeUser('go'), claudeAssistant({ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'yes' })]
    expect(convert(claudeCodeAdapter, records).turns[1]).toEqual({ role: 'assistant', text: 'yes' })
    expect(convert(claudeCodeAdapter, records, { includeThinking: true }).turns[1])
      .toEqual({ role: 'assistant', text: 'hmm\n\nyes' })
  })

  it('honors each tool-call mode', () => {
    const records = [claudeUser('go'), claudeAssistant({ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } })]
    expect(convert(claudeCodeAdapter, records, { toolCalls: 'drop' }).turns).toHaveLength(1)
    expect(convert(claudeCodeAdapter, records, { toolCalls: 'elide' }).turns[1]?.text).toBe('[tool: Bash]')
    expect(convert(claudeCodeAdapter, records, { toolCalls: 'summarize' }).turns[1]?.text)
      .toBe('[tool: Bash] {"command":"ls -la"}')
  })

  it('caps a summarized tool call rather than letting one call dominate a turn', () => {
    const { turns } = convert(
      claudeCodeAdapter,
      [claudeUser('go'), claudeAssistant({ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(500) } })],
      { toolCalls: 'summarize', toolSummaryChars: 40 },
    )
    expect(turns[1]?.text.length).toBeLessThanOrEqual('[tool: Bash] '.length + 40)
    expect(turns[1]?.text.endsWith('…')).toBe(true)
  })

  it('drops sidechain records unless they are asked for', () => {
    const records = [claudeUser('main'), { ...claudeUser('spawned'), isSidechain: true }]
    expect(convert(claudeCodeAdapter, records).turns).toHaveLength(1)
    expect(convert(claudeCodeAdapter, records, { includeSidechains: true }).turns).toHaveLength(2)
  })

  it('marks a compaction boundary and keeps its summary as the only account of what was dropped', () => {
    const { turns, compacted } = convert(claudeCodeAdapter, [
      { ...claudeUser('Summary: we chose request hashing.'), isCompactSummary: true, subtype: 'compact_boundary' },
      claudeUser('carry on'),
    ])
    expect(compacted).toBe(true)
    expect(turns[0]?.role).toBe('assistant')
    expect(turns[0]?.text).toContain('Summary: we chose request hashing.')
    expect(turns[1]).toEqual({ role: 'user', text: 'carry on' })
  })

  it('skips a malformed line instead of failing the whole read', () => {
    const { turns } = convert(claudeCodeAdapter, ['{"type":"user"', '', 'not json', claudeUser('still here')])
    expect(turns).toEqual([{ role: 'user', text: 'still here' }])
  })

  it('prefers the newest ai-title over the oldest, and falls back down the chain', () => {
    const head = [JSON.stringify({ type: 'ai-title', aiTitle: 'stale guess' }), JSON.stringify({ ...claudeUser('open the door'), cwd: '/w/app', timestamp: '2026-08-18T08:19:34.732Z' })]
    const tail = [JSON.stringify({ type: 'ai-title', aiTitle: 'Final name' })]
    expect(claudeCodeAdapter.head(head, tail)).toEqual({
      title: 'Final name',
      cwd: '/w/app',
      firstPrompt: 'open the door',
      createdAt: Date.parse('2026-08-18T08:19:34.732Z'),
    })
    expect(claudeCodeAdapter.head([JSON.stringify({ type: 'last-prompt', lastPrompt: 'a prompt' })], []).title)
      .toBe('a prompt')
    expect(claudeCodeAdapter.head([JSON.stringify({ type: 'mode', slug: 'drifting-bachman' })], []).title)
      .toBe('drifting-bachman')
    expect(claudeCodeAdapter.head([JSON.stringify(claudeUser('only a prompt'))], []).title).toBe('only a prompt')
    expect(claudeCodeAdapter.head([], [])).toEqual({})
  })

  it('does not take a compaction summary as the opening prompt', () => {
    const head = [JSON.stringify({ ...claudeUser('a summary of before'), isCompactSummary: true }), JSON.stringify(claudeUser('the real first ask'))]
    expect(claudeCodeAdapter.head(head, []).firstPrompt).toBe('the real first ask')
  })
})

describe('codex adapter', () => {
  it('projects response_item messages and ignores the event_msg restatement of them', () => {
    const { turns } = convert(codexAdapter, [
      { type: 'session_meta', payload: { cwd: '/w/app' } },
      codexMessage('user', 'build the thing'),
      codexMessage('assistant', 'building'),
      { type: 'event_msg', payload: { type: 'agent_message', message: 'building' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'build the thing' } },
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'build the thing' },
      { role: 'assistant', text: 'building' },
    ])
  })

  it('drops developer messages so the user is not credited with the harness prompt', () => {
    const { turns } = convert(codexAdapter, [
      codexMessage('developer', 'You are Codex, a coding agent.'),
      codexMessage('user', 'hello'),
    ])
    expect(turns).toEqual([{ role: 'user', text: 'hello' }])
  })

  it('drops a whole-message environment preamble but keeps it when asked to', () => {
    const records = [codexMessage('user', '<environment_context>\ncwd=/w\n</environment_context>'), codexMessage('user', 'real ask')]
    expect(convert(codexAdapter, records).turns).toEqual([{ role: 'user', text: 'real ask' }])
    expect(convert(codexAdapter, records, { stripEnvironmentPreamble: false }).turns).toHaveLength(2)
  })

  it('drops an injected block whose tag it has never seen', () => {
    const { turns } = convert(codexAdapter, [
      codexMessage('user', '<recommended_plugins>\nHere is a list of plugins that are available.\n</recommended_plugins>'),
      codexMessage('user', 'hi'),
    ])
    expect(turns).toEqual([{ role: 'user', text: 'hi' }])
  })

  it('drops the heading a stripped instruction block was announced by', () => {
    // Codex opens every session with the repository's AGENTS.md sent as a user
    // message. Stripping only the block leaves the heading, which then became
    // the title of 58 of 60 measured rollouts.
    const { turns } = convert(codexAdapter, [
      codexMessage('user', '# AGENTS.md instructions for /w/app\n\n<INSTRUCTIONS>\n## CodeGraph\nUse it first.\n</INSTRUCTIONS>'),
      codexMessage('user', 'add a test'),
    ])
    expect(turns).toEqual([{ role: 'user', text: 'add a test' }])
  })

  it('keeps a heading the user wrote themselves alongside their question', () => {
    const { turns } = convert(codexAdapter, [
      codexMessage('user', '# Refactor plan\n\nStart with the parser.'),
    ])
    expect(turns).toEqual([{ role: 'user', text: '# Refactor plan\n\nStart with the parser.' }])
  })

  it('leaves inline markup in a question alone', () => {
    // A one-line element with a hyphenated name is a web component someone is
    // asking about, not an injection: only multi-line unknown tags are stripped.
    const { turns } = convert(codexAdapter, [
      codexMessage('user', 'why does <my-widget>hi</my-widget> not render?'),
    ])
    expect(turns).toEqual([{ role: 'user', text: 'why does <my-widget>hi</my-widget> not render?' }])
  })

  it('names a dispatched rollout after the assistant when no user text survives', () => {
    const head = codexAdapter.head([
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/w/app' } }),
      JSON.stringify(codexMessage('user', '<recommended_plugins>\nnothing installed\n</recommended_plugins>')),
      JSON.stringify(codexMessage('assistant', 'Reviewing the reference fix.')),
    ], [])
    expect(head.title).toBe('Reviewing the reference fix.')
    expect(head.firstPrompt).toBeUndefined()
  })

  it('takes assistant output_text blocks as well as input_text ones', () => {
    const { turns } = convert(codexAdapter, [
      codexMessage('user', 'go'),
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    ])
    expect(turns[1]).toEqual({ role: 'assistant', text: 'done' })
  })

  it('merges tool calls into the open assistant run and drops their outputs', () => {
    const { turns } = convert(codexAdapter, [
      codexMessage('user', 'go'),
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'pwd' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: '/w' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'wait', arguments: '{"ms":10}' } },
      codexMessage('assistant', 'finished'),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '[tool: exec]\n\n[tool: wait]\n\nfinished' },
    ])
  })

  it('drops inter-agent dispatch, which is not the assistant answering the user', () => {
    const { turns } = convert(codexAdapter, [
      codexMessage('user', 'go'),
      { type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: '/root/sub', content: [{ type: 'input_text', text: 'NEW_TASK' }] } },
    ])
    expect(turns).toEqual([{ role: 'user', text: 'go' }])
  })

  it('marks a compacted rollout', () => {
    const { compacted } = convert(codexAdapter, [
      codexMessage('user', 'go'),
      { type: 'compacted', payload: { message: '', replacement_history: [] } },
    ])
    expect(compacted).toBe(true)
  })

  it('surfaces reasoning only when asked, and tolerates the encrypted empty summary', () => {
    const records = [
      codexMessage('user', 'go'),
      { type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAA' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'weighing options' }] } },
      codexMessage('assistant', 'answer'),
    ]
    expect(convert(codexAdapter, records).turns[1]?.text).toBe('answer')
    expect(convert(codexAdapter, records, { includeThinking: true }).turns[1]?.text)
      .toBe('weighing options\n\nanswer')
  })

  it('reads cwd from session_meta and names the rollout by its opening prompt', () => {
    const head = [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/w/app', timestamp: '2026-08-15T09:33:58.182Z' } }),
      JSON.stringify(codexMessage('developer', '<skills_instructions>x</skills_instructions>')),
      JSON.stringify(codexMessage('user', 'ship the release')),
    ]
    expect(codexAdapter.head(head, [])).toEqual({
      title: 'ship the release',
      cwd: '/w/app',
      firstPrompt: 'ship the release',
      createdAt: Date.parse('2026-08-15T09:33:58.182Z'),
    })
  })

  it('falls back to the tail when the head probe never reached a real prompt', () => {
    const head = [JSON.stringify({ type: 'session_meta', payload: { cwd: '/w' } })]
    const tail = [JSON.stringify(codexMessage('user', 'the only prompt'))]
    expect(codexAdapter.head(head, tail).title).toBe('the only prompt')
  })
})

describe('cursor adapter', () => {
  const cursorUser = (text: string) => ({ role: 'user', message: { content: [{ type: 'text', text }] } })
  const cursorAssistant = (...blocks: unknown[]) => ({ role: 'assistant', message: { content: blocks } })

  it('unwraps the query markup Cursor adds and removes the client’s redaction sentinels', () => {
    const { turns } = convert(cursorAdapter, [
      cursorUser('<user_query>\nwhy is the build slow?\n</user_query>'),
      cursorAssistant(
        { type: 'text', text: 'Checking the cache.[REDACTED]' },
        { type: 'tool_use', name: 'read_file', input: { path: 'vite.config.ts' } },
      ),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'why is the build slow?' },
      { role: 'assistant', text: 'Checking the cache.\n\n[tool: read_file]' },
    ])
  })

  it('takes the tool input as an object, since Cursor does not JSON-encode it', () => {
    const { turns } = convert(
      cursorAdapter,
      [cursorUser('go'), cursorAssistant({ type: 'tool_use', name: 'edit', input: { path: 'a.ts' } })],
      { toolCalls: 'summarize' },
    )
    expect(turns[1]?.text).toBe('[tool: edit] {"path":"a.ts"}')
  })

  it('names the session after the prompt and claims neither a cwd nor a start time', () => {
    // The format records neither, and a label derived from the file’s mtime
    // would claim the session started when it was last written to.
    expect(cursorAdapter.head([JSON.stringify(cursorUser('<user_query>open the router</user_query>'))], []))
      .toEqual({ title: 'open the router', firstPrompt: 'open the router' })
    expect(cursorAdapter.head([], [])).toEqual({})
  })

  it('claims only files under the transcript directory', () => {
    expect(cursorAdapter.matches('slug/agent-transcripts/c1/c1.jsonl')).toBe(true)
    expect(cursorAdapter.matches('slug/state/c1.jsonl')).toBe(false)
  })
})

describe('qoder adapter', () => {
  const qoderUser = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })

  it('folds a session and leaves its CLI state records out of the transcript', () => {
    const { turns } = convert(qoderAdapter, [
      { type: 'ai-title', aiTitle: 'Cache keying' },
      qoderUser('how should we key the cache?'),
      { type: 'assistant', message: { role: 'assistant', content: 'By request hash.' } },
      { type: 'mode', slug: 'plan' },
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'how should we key the cache?' },
      { role: 'assistant', text: 'By request hash.' },
    ])
  })

  it('prefers the newest ai-title, because a rename rewrites it', () => {
    const head = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'stale guess' }),
      JSON.stringify({ ...qoderUser('open the door'), cwd: '/w/app', timestamp: '2026-08-11T04:00:00.000Z' }),
    ]
    const tail = [JSON.stringify({ type: 'ai-title', aiTitle: 'Final name' })]
    expect(qoderAdapter.head(head, tail)).toEqual({
      title: 'Final name',
      cwd: '/w/app',
      firstPrompt: 'open the door',
      createdAt: Date.parse('2026-08-11T04:00:00.000Z'),
    })
  })

  it('falls from ai-title down to the last prompt and then to the first', () => {
    expect(qoderAdapter.head([JSON.stringify({ type: 'last-prompt', lastPrompt: 'ship it' })], []).title).toBe('ship it')
    expect(qoderAdapter.head([JSON.stringify(qoderUser('only a prompt'))], []).title).toBe('only a prompt')
  })

  it('rejects a subagent transcript, whose session id collides with its parent’s', () => {
    expect(qoderAdapter.matches('p/s1.jsonl')).toBe(true)
    expect(qoderAdapter.matches('p/subagents/s1.jsonl')).toBe(false)
  })
})

describe('reasonix adapter', () => {
  it('reads both tool-call shapes and drops the results they produced', () => {
    const { turns } = convert(reasonixAdapter, [
      { role: 'user', content: 'run the tests' },
      { role: 'assistant', content: 'On it.', tool_calls: [{ id: 'c1', function: { name: 'shell', arguments: '{"cmd":"pnpm test"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '42 passed' },
      { role: 'assistant', content: '', tool_calls: [{ name: 'shell', arguments: '{"cmd":"git status"}' }] },
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'run the tests' },
      { role: 'assistant', text: 'On it.\n\n[tool: shell]\n\n[tool: shell]' },
    ])
  })

  it('summarizes the arguments of a v1 and a v2 call the same way', () => {
    const records = [
      { role: 'assistant', tool_calls: [{ function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] },
      { role: 'assistant', tool_calls: [{ name: 'shell', arguments: '{"cmd":"ls"}' }] },
    ]
    expect(convert(reasonixAdapter, records, { toolCalls: 'summarize' }).turns[0]?.text)
      .toBe('[tool: shell] {"cmd":"ls"}\n\n[tool: shell] {"cmd":"ls"}')
  })

  it('gates reasoning_content behind the option', () => {
    const records = [{ role: 'assistant', content: 'yes', reasoning_content: 'weighing it' }]
    expect(convert(reasonixAdapter, records).turns[0]?.text).toBe('yes')
    expect(convert(reasonixAdapter, records, { includeThinking: true }).turns[0]?.text).toBe('yes\n\nweighing it')
  })

  it('rejects the write-ahead log that shares the session’s directory', () => {
    expect(reasonixAdapter.matches('s/one.jsonl')).toBe(true)
    expect(reasonixAdapter.matches('s/one.events.jsonl')).toBe(false)
  })

  it('names the session by its opening prompt, the summary being in a file it cannot see', () => {
    const head = [JSON.stringify({ role: 'user', content: 'add a benchmark', createdAt: '2026-08-12T07:00:00.000Z' })]
    expect(reasonixAdapter.head(head, [])).toEqual({
      title: 'add a benchmark',
      firstPrompt: 'add a benchmark',
      createdAt: Date.parse('2026-08-12T07:00:00.000Z'),
    })
  })
})

describe('openclaw adapter', () => {
  const openclawMessage = (role: string, content: unknown) => ({ type: 'message', message: { role, content } })

  it('strips the gateway’s routing marker and drops its tool-result role', () => {
    const { turns } = convert(openclawAdapter, [
      { type: 'session', cwd: '/w/app', timestamp: '2026-08-05T12:00:00.000Z' },
      openclawMessage('user', 'ping the gateway\n[message_id: 7f3a]'),
      openclawMessage('assistant', 'Pinged.\n[message_id: 7f3b]'),
      openclawMessage('toolResult', 'exit 0'),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'ping the gateway' },
      { role: 'assistant', text: 'Pinged.' },
    ])
  })

  it('reads the session header and falls back to naming the session after its directory', () => {
    const head = [JSON.stringify({ type: 'session', cwd: '/w/app', timestamp: '2026-08-05T12:00:00.000Z' })]
    expect(openclawAdapter.head(head, [])).toEqual({
      title: 'app',
      cwd: '/w/app',
      createdAt: Date.parse('2026-08-05T12:00:00.000Z'),
    })
  })

  it('prefers the opening prompt over the directory name', () => {
    const head = [
      JSON.stringify({ type: 'session', cwd: '/w/app' }),
      JSON.stringify(openclawMessage('user', 'restart the relay\n[message_id: 1]')),
    ]
    expect(openclawAdapter.head(head, []).title).toBe('restart the relay')
  })

  it('claims only files under an agent’s sessions directory', () => {
    expect(openclawAdapter.matches('main/sessions/s1.jsonl')).toBe(true)
    expect(openclawAdapter.matches('main/memory/s1.jsonl')).toBe(false)
  })
})

describe('kimi adapter', () => {
  const legacyEvent = (type: string, payload: unknown) => ({ timestamp: '2026-08-06T09:00:00.000Z', message: { type, payload } })

  it('rejoins streamed fragments into whole sentences on the older wire', () => {
    const { turns } = convert(kimiAdapter, [
      legacyEvent('TurnBegin', { user_input: [{ text: 'refactor the ' }, { text: 'parser' }] }),
      legacyEvent('TextPart', { text: 'I will start ' }),
      legacyEvent('TextPart', { text: 'with the lexer.' }),
      legacyEvent('ToolCall', { function: { name: 'edit', arguments: '{"path":"lexer.ts"}' } }),
      legacyEvent('TurnEnd', {}),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'refactor the parser' },
      { role: 'assistant', text: 'I will start with the lexer.\n\n[tool: edit]' },
    ])
  })

  it('separates runs a step boundary broke rather than splicing them mid-sentence', () => {
    const { turns } = convert(kimiAdapter, [
      legacyEvent('TurnBegin', { user_input: 'go' }),
      legacyEvent('TextPart', { text: 'First.' }),
      legacyEvent('StepBegin', {}),
      legacyEvent('TextPart', { text: 'Second.' }),
    ])
    expect(turns[1]).toEqual({ role: 'assistant', text: 'First.\n\nSecond.' })
  })

  it('treats steering typed mid-turn as the user speaking', () => {
    const { turns } = convert(kimiAdapter, [
      legacyEvent('TurnBegin', { user_input: 'start' }),
      legacyEvent('TextPart', { text: 'Working.' }),
      legacyEvent('SteerInput', { user_input: 'actually, stop' }),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'start' },
      { role: 'assistant', text: 'Working.' },
      { role: 'user', text: 'actually, stop' },
    ])
  })

  it('reads the newer flat wire and does not double the prompt it also appends to context', () => {
    const { turns } = convert(kimiAdapter, [
      { type: 'turn.prompt', time: '2026-08-06T09:00:00.000Z', input: 'add a test' },
      { type: 'context.append_message', message: { role: 'user', content: 'add a test' } },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Adding ' } } },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'one now.' } } },
      { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'write', args: { path: 't.spec.ts' } } },
      { type: 'context.append_loop_event', event: { type: 'tool.result', output: 'ok' } },
      { type: 'turn.ended' },
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'add a test' },
      { role: 'assistant', text: 'Adding one now.\n\n[tool: write]' },
    ])
  })

  it('falls back to the appended message when the file carries no turn.prompt', () => {
    const { turns } = convert(kimiAdapter, [
      { type: 'context.append_message', message: { role: 'user', content: 'only here' } },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'noted' } } },
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'only here' },
      { role: 'assistant', text: 'noted' },
    ])
  })

  it('gates streamed reasoning behind the option on both wires', () => {
    const older = [legacyEvent('ThinkPart', { think: 'hmm' }), legacyEvent('TextPart', { text: 'yes' })]
    expect(convert(kimiAdapter, older).turns[0]?.text).toBe('yes')
    expect(convert(kimiAdapter, older, { includeThinking: true }).turns[0]?.text).toBe('hmm\n\nyes')

    const newer = [
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: 'hmm' } } },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'yes' } } },
    ]
    expect(convert(kimiAdapter, newer).turns[0]?.text).toBe('yes')
    expect(convert(kimiAdapter, newer, { includeThinking: true }).turns[0]?.text).toBe('hmm\n\nyes')
  })

  it('claims the main thread’s wire log and not a subagent’s', () => {
    expect(kimiAdapter.matches('s1/wire.jsonl')).toBe(true)
    expect(kimiAdapter.matches('s1/agents/main/wire.jsonl')).toBe(true)
    expect(kimiAdapter.matches('s1/agents/reviewer/wire.jsonl')).toBe(false)
    expect(kimiAdapter.matches('s1/state.json')).toBe(false)
  })

  it('names the session by its opening prompt on either wire', () => {
    expect(kimiAdapter.head([JSON.stringify(legacyEvent('TurnBegin', { user_input: 'first ask' }))], [])).toEqual({
      title: 'first ask',
      firstPrompt: 'first ask',
      createdAt: Date.parse('2026-08-06T09:00:00.000Z'),
    })
    expect(kimiAdapter.head([JSON.stringify({ type: 'turn.prompt', input: 'newer ask' })], []).title).toBe('newer ask')
  })
})

describe('grokbuild adapter', () => {
  it('drops the system prompt and the encrypted reasoning record', () => {
    const { turns } = convert(grokbuildAdapter, [
      { type: 'system', content: 'You are Grok.', timestamp: '2026-08-07T10:00:00.000Z' },
      { type: 'user', content: 'summarize the diff', timestamp: '2026-08-07T10:00:01.000Z' },
      { type: 'reasoning', content: 'gAAAAAB…' },
      { type: 'assistant', content: 'It renames two fields.' },
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'summarize the diff' },
      { role: 'assistant', text: 'It renames two fields.' },
    ])
  })

  it('names the session by its opening prompt, the real title being in a sibling file', () => {
    const head = [
      JSON.stringify({ type: 'system', content: 'You are Grok.', timestamp: '2026-08-07T10:00:00.000Z' }),
      JSON.stringify({ type: 'user', content: 'summarize the diff' }),
    ]
    expect(grokbuildAdapter.head(head, [])).toEqual({
      title: 'summarize the diff',
      firstPrompt: 'summarize the diff',
      createdAt: Date.parse('2026-08-07T10:00:00.000Z'),
    })
  })

  it('claims the chat history and nothing else in the session directory', () => {
    expect(grokbuildAdapter.matches('s1/chat_history.jsonl')).toBe(true)
    expect(grokbuildAdapter.matches('s1/summary.json')).toBe(false)
  })
})

describe('hermes adapter', () => {
  it('reads a flat record and a wrapped one as the same conversation', () => {
    const { turns } = convert(hermesAdapter, [
      { type: 'session', title: 'Release checklist', cwd: '/w/app', timestamp: '2026-08-08T11:00:00.000Z' },
      { role: 'user', content: 'what is left?', ts: '2026-08-08T11:00:01.000Z' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Two items.' }] } },
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'what is left?' },
      { role: 'assistant', text: 'Two items.' },
    ])
  })

  it('prefers the title the session recorded over the opening prompt', () => {
    const head = [
      JSON.stringify({ type: 'session', title: 'Release checklist', cwd: '/w/app', timestamp: '2026-08-08T11:00:00.000Z' }),
      JSON.stringify({ role: 'user', content: 'what is left?' }),
    ]
    expect(hermesAdapter.head(head, [])).toEqual({
      title: 'Release checklist',
      cwd: '/w/app',
      firstPrompt: 'what is left?',
      createdAt: Date.parse('2026-08-08T11:00:00.000Z'),
    })
  })

  it('falls back to the opening prompt when no session record was written', () => {
    expect(hermesAdapter.head([JSON.stringify({ role: 'user', content: 'a bare start', ts: 1_760_000_000 })], []))
      .toEqual({ title: 'a bare start', firstPrompt: 'a bare start', createdAt: 1_760_000_000_000 })
  })
})

describe('gemini-cli adapter', () => {
  const chat = {
    sessionId: 's1',
    startTime: '2026-08-09T13:00:00.000Z',
    directories: ['/w/app'],
    messages: [
      { type: 'user', content: 'explain the router' },
      {
        type: 'gemini',
        content: 'It maps paths to handlers.',
        thoughts: [{ subject: 'Scope', description: 'read the router first' }],
        toolCalls: [{ name: 'read_file', args: { path: 'router.ts' } }],
      },
      { type: 'info', content: 'Request cancelled.' },
    ],
  }

  it('folds the whole document at flush and inlines the tool calls it embeds', () => {
    const { turns } = convert(geminiCliAdapter, [chat])
    expect(turns).toEqual([
      { role: 'user', text: 'explain the router' },
      { role: 'assistant', text: 'It maps paths to handlers.\n\n[tool: read_file]' },
    ])
  })

  it('honors the projection settings, which only flush is given for this format', () => {
    // A document adapter emits nothing from `step`, so `flush` is the only place
    // `includeThinking` can be read. Defaulting them there would silently ignore
    // the caller’s configuration for exactly these two formats.
    expect(convert(geminiCliAdapter, [chat], { includeThinking: true }).turns[1]?.text)
      .toBe('It maps paths to handlers.\n\nScope：read the router first\n\n[tool: read_file]')
    expect(convert(geminiCliAdapter, [chat], { toolCalls: 'drop' }).turns[1]?.text)
      .toBe('It maps paths to handlers.')
  })

  it('reads the workspace and start time out of the document header', () => {
    expect(geminiCliAdapter.head([JSON.stringify(chat)], [])).toEqual({
      title: 'explain the router',
      cwd: '/w/app',
      firstPrompt: 'explain the router',
      createdAt: Date.parse('2026-08-09T13:00:00.000Z'),
    })
  })

  it('degrades to nothing when the probe captured only a prefix of the document', () => {
    // Half a JSON object is not a smaller JSON object; guessing at the missing
    // half would invent a title the file does not have.
    expect(geminiCliAdapter.head([JSON.stringify(chat).slice(0, 60)], [])).toEqual({})
  })

  it('claims chat files and declares that it must be read whole', () => {
    expect(geminiCliAdapter.document).toBe(true)
    expect(geminiCliAdapter.matches('2026-08-09/chats/s1.json')).toBe(true)
    expect(geminiCliAdapter.matches('2026-08-09/checkpoints/s1.json')).toBe(false)
  })
})

describe('pi adapter', () => {
  const piMessage = (id: string, parentId: string | undefined, role: string, content: unknown) =>
    ({ type: 'message', id, ...parentId === undefined ? {} : { parentId }, message: { role, content } })

  it('walks back from the last entry, so a branch the user abandoned is not in the transcript', () => {
    const { turns } = convert(piAdapter, [
      { type: 'session', cwd: '/w/app', timestamp: '2026-08-10T14:00:00.000Z' },
      piMessage('m1', undefined, 'user', 'first ask'),
      piMessage('m2', 'm1', 'assistant', [{ type: 'text', text: 'the abandoned answer' }]),
      piMessage('m3', 'm1', 'user', 'second ask'),
      piMessage('m4', 'm3', 'assistant', [{ type: 'text', text: 'the answer that stood' }]),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'first ask' },
      { role: 'user', text: 'second ask' },
      { role: 'assistant', text: 'the answer that stood' },
    ])
  })

  it('keeps a v1 file linear, where no entry carries an id', () => {
    const { turns } = convert(piAdapter, [
      { type: 'message', message: { role: 'user', content: 'one' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
    ])
    expect(turns).toEqual([{ role: 'user', text: 'one' }, { role: 'assistant', text: 'two' }])
  })

  it('trims to what a compaction kept and marks the transcript partial', () => {
    const { turns, compacted } = convert(piAdapter, [
      piMessage('m1', undefined, 'user', 'the discarded ask'),
      piMessage('m2', 'm1', 'assistant', [{ type: 'text', text: 'the discarded answer' }]),
      {
        type: 'compaction', id: 'c1', parentId: 'm2',
        summary: 'We chose request hashing.',
        retainedTail: [{ role: 'user', content: 'the kept ask' }],
      },
      piMessage('m3', 'c1', 'assistant', [{ type: 'text', text: 'the kept answer' }]),
    ])
    expect(compacted).toBe(true)
    expect(turns).toEqual([
      { role: 'assistant', text: '[compacted summary of the earlier conversation]\n\nWe chose request hashing.' },
      { role: 'user', text: 'the kept ask' },
      { role: 'assistant', text: 'the kept answer' },
    ])
  })

  it('slices from the named entry when the compaction kept no tail inline', () => {
    const { turns } = convert(piAdapter, [
      piMessage('m1', undefined, 'user', 'the discarded ask'),
      piMessage('m2', 'm1', 'user', 'the kept ask'),
      { type: 'compaction', id: 'c1', parentId: 'm2', summary: 'Earlier work.', firstKeptEntryId: 'm2' },
      piMessage('m3', 'c1', 'assistant', [{ type: 'text', text: 'the kept answer' }]),
    ])
    expect(turns.map(turn => turn.text)).toEqual([
      '[compacted summary of the earlier conversation]\n\nEarlier work.',
      'the kept ask',
      'the kept answer',
    ])
  })

  it('labels a branch summary rather than letting it read as something just said', () => {
    const { turns } = convert(piAdapter, [
      piMessage('m1', undefined, 'user', 'go'),
      { type: 'branch_summary', id: 'b1', parentId: 'm1', summary: 'The other attempt stalled.' },
    ])
    expect(turns[1]).toEqual({ role: 'assistant', text: '[summary of an earlier branch]\n\nThe other attempt stalled.' })
  })

  it('drops results and notes an image the user attached', () => {
    const { turns } = convert(piAdapter, [
      piMessage('m1', undefined, 'user', [{ type: 'text', text: 'why does this render wrong?' }, { type: 'image', mimeType: 'image/png' }]),
      piMessage('m2', 'm1', 'toolResult', 'exit 0'),
      piMessage('m3', 'm2', 'assistant', [{ type: 'text', text: 'A stale style.' }]),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'why does this render wrong?\n[image: image/png]' },
      { role: 'assistant', text: 'A stale style.' },
    ])
  })

  it('reads its header from the first line and takes the newest rename as the name', () => {
    const head = [
      JSON.stringify({ type: 'session', cwd: '/w/app', timestamp: '2026-08-10T14:00:00.000Z' }),
      JSON.stringify(piMessage('m1', undefined, 'user', 'the opening ask')),
    ]
    const tail = [JSON.stringify({ type: 'session_info', id: 'i2', name: 'Parser rewrite' })]
    expect(piAdapter.head(head, tail)).toEqual({
      title: 'Parser rewrite',
      cwd: '/w/app',
      firstPrompt: 'the opening ask',
      createdAt: Date.parse('2026-08-10T14:00:00.000Z'),
    })
    expect(piAdapter.head(head, []).title).toBe('the opening ask')
  })

  it('declares that it must be read whole', () => {
    expect(piAdapter.document).toBe(true)
  })
})

describe('registry', () => {
  it('resolves every registered kind and refuses an unknown one', () => {
    expect(adapterFor('claude-code')).toBe(claudeCodeAdapter)
    expect(adapterFor('codex')).toBe(codexAdapter)
    expect(adapterFor('nope')).toBeUndefined()
    expect(isAgentKind('codex')).toBe(true)
    expect(isAgentKind('nope')).toBe(false)
  })

  it('lists every adapter exactly once, since the config schema is derived from this order', () => {
    // `AGENT_KINDS` is what the Schemastery union enumerates, so a duplicate or
    // an unregistered adapter would reach a user as a broken settings pane
    // rather than as a failing import.
    expect(AGENT_KINDS).toEqual([
      'claude-code', 'codex', 'cursor', 'qoder', 'reasonix',
      'openclaw', 'kimi', 'grokbuild', 'hermes', 'gemini-cli', 'pi',
      'opencode', 'mimocode', 'zcode',
    ])
    expect(new Set(AGENT_KINDS).size).toBe(AGENT_ADAPTERS.length)
    for (const adapter of AGENT_ADAPTERS) expect(adapterFor(adapter.kind)).toBe(adapter)
  })

  it('gives every adapter a name and at least one root to look in', () => {
    for (const adapter of AGENT_ADAPTERS) {
      expect(adapter.displayName).not.toBe('')
      expect(adapter.defaultRoots('/home/u').length).toBeGreaterThan(0)
      for (const root of adapter.defaultRoots('/home/u')) expect(isAbsolute(root)).toBe(true)
    }
  })

  it('marks only the two formats that cannot be folded line by line as documents', () => {
    expect(FILE_ADAPTERS.filter(adapter => adapter.document === true).map(adapter => adapter.kind))
      .toEqual(['gemini-cli', 'pi'])
  })

  it('splits the two adapter seams without losing or duplicating a format', () => {
    // Every adapter answers to exactly one seam. A format that fell out of both
    // would vanish from the menu; one in both would be walked and queried.
    expect(FILE_ADAPTERS.length + QUERY_ADAPTERS.length).toBe(AGENT_ADAPTERS.length)
    expect(QUERY_ADAPTERS.map(adapter => adapter.kind)).toEqual(['opencode', 'mimocode', 'zcode'])
    for (const adapter of QUERY_ADAPTERS) expect(isQueryKind(adapter.kind)).toBe(true)
    for (const adapter of FILE_ADAPTERS) expect(isQueryKind(adapter.kind)).toBe(false)
    expect(isQueryKind('nope')).toBe(false)
  })

  it('expands a portable root and refuses one that has no fixed meaning', () => {
    expect(expandRoot('~/.codex/sessions', '/home/u')).toBe(normalize(join('/home/u', '.codex/sessions')))
    expect(expandRoot('~', '/home/u')).toBe('/home/u')
    expect(expandRoot('/srv/logs', '/home/u')).toBe(normalize('/srv/logs'))
    expect(expandRoot('relative/path', '/home/u')).toBeUndefined()
    expect(expandRoot('   ', '/home/u')).toBeUndefined()
  })

  it('claims its own default roots and only jsonl files', () => {
    expect(claudeCodeAdapter.defaultRoots('/home/u')).toEqual([join('/home/u', '.claude', 'projects')])
    expect(codexAdapter.defaultRoots('/home/u')).toEqual([join('/home/u', '.codex', 'sessions')])
    expect(claudeCodeAdapter.matches('a/b.jsonl')).toBe(true)
    expect(claudeCodeAdapter.matches('a/b.json')).toBe(false)
  })
})
