/**
 * Vocabulary for reading the transcripts other coding agents leave on disk.
 *
 * Every supported agent writes its own record shape, but all of them are
 * append-only logs of one conversation, so the plugin folds each into the same
 * two-role projection the rest of the package already speaks. The types here
 * are deliberately free of `node:fs` and cordis: an adapter is a pure fold over
 * records, which is what lets the streaming reader in `scan.ts` bound its
 * memory and lets the tests drive an adapter from an array of literals.
 *
 * @module dsh-reference-anything/local-agent/types
 */

/**
 * One supported on-disk transcript format.
 *
 * Named after the agent rather than the encoding, because two agents that both
 * write JSONL still disagree about every field inside it.
 */
export type AgentKind =
  /** Claude Code, `~/.claude/projects/<slug>/<uuid>.jsonl`. */
  | 'claude-code'
  /** Codex CLI rollouts, `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`. */
  | 'codex'
  /** Cursor agent transcripts, `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`. */
  | 'cursor'
  /** Qoder, `~/.qoder/projects/<slug>/<sessionId>.jsonl`. */
  | 'qoder'
  /** Reasonix, `~/.reasonix/sessions/<stem>.jsonl`. */
  | 'reasonix'
  /** OpenClaw, `~/.openclaw/agents/<agent>/sessions/<id>.jsonl`. */
  | 'openclaw'
  /** Kimi CLI, `~/.kimi/sessions/**\/wire.jsonl` and `~/.kimi-code/sessions/**\/wire.jsonl`. */
  | 'kimi'
  /** Grok Build, `~/.grok/sessions/<slug>/<id>/chat_history.jsonl`. */
  | 'grokbuild'
  /** Hermes, `~/.hermes/sessions/<id>.jsonl`. */
  | 'hermes'
  /** Gemini CLI, `~/.gemini/history/<slot>/chats/session-*.json` — one JSON document. */
  | 'gemini-cli'
  /** Pi, `~/.pi/agent/sessions/--<cwd>--/<stamp>_<uuid>.jsonl` — a branch tree. */
  | 'pi'
  /** opencode, `~/.local/share/opencode/opencode.db` — SQLite, many sessions in one file. */
  | 'opencode'
  /** mimocode, `~/.local/share/mimocode/mimocode.db` — an opencode fork, same schema. */
  | 'mimocode'
  /** zcode, `~/.zcode/cli/db/db.sqlite` — SQLite with its own session shape. */
  | 'zcode'

/**
 * How much of a tool call survives projection.
 *
 * A coding transcript is mostly tool traffic, so this is the single knob with
 * the largest effect on what a read costs: `'drop'` hides that any work
 * happened, `'summarize'` can let one `Bash` invocation outweigh the answer it
 * produced, and `'elide'` keeps the shape of the work at a fixed ~15 bytes.
 */
export type ToolCallMode = 'elide' | 'summarize' | 'drop'

/** How a transcript is projected into turns; fixed for the whole of one read. */
export interface ConvertOptions {
  /** Keep assistant reasoning blocks, which are usually noise and sometimes the answer. */
  readonly includeThinking: boolean
  /** How much of each tool call survives. */
  readonly toolCalls: ToolCallMode
  /** Keep records belonging to a spawned subagent rather than the main thread. */
  readonly includeSidechains: boolean
  /** Drop harness-injected preambles that were never typed by a person. */
  readonly stripEnvironmentPreamble: boolean
  /** Longest single tool-call summary, in characters, under `'summarize'`. */
  readonly toolSummaryChars: number
}

/**
 * One projected turn.
 *
 * Structurally a {@link ConversationItem} minus attachments, kept separate so
 * adapters stay independent of the package's public wire types.
 */
export interface ParsedTurn {
  readonly role: 'user' | 'assistant'
  /** Visible text; never empty, because an empty turn tells a reader nothing. */
  readonly text: string
}

/**
 * Fold state carried across one file's records.
 *
 * Small and concrete on purpose. An opaque per-adapter bag would push the
 * assistant-run merging rule — the one rule that decides what "a turn" even
 * means — into each adapter separately. Each field below is here because a
 * shipped adapter needs it, not because a future one might.
 */
export interface AdapterState {
  /**
   * Fragments of the assistant run still open.
   *
   * Agents emit text, reasoning, and each tool call as separate records, so a
   * single reply arrives as a run of ten or twenty of them. They are buffered
   * here and joined into one turn when the next user turn arrives or the file
   * ends; without that, a turn limit would page through tool plumbing.
   */
  readonly pending: string[]
  /**
   * Raw records a whole-document format is holding until the file ends.
   *
   * Most formats decide each turn from one record and never touch this. Three
   * cannot: Gemini CLI writes a single JSON object per session, Pi stores a
   * branch tree whose active path is only knowable from the last entry
   * backwards, and both must therefore see everything before emitting
   * anything. They accumulate here and emit the whole conversation from
   * {@link TranscriptAdapter.flush}. Bounded by `maxScanBytes`, which is what
   * {@link TranscriptAdapter.document} exists to enforce.
   */
  readonly held: string[]
  /**
   * One-shot markers for folds a single record cannot decide.
   *
   * Kimi's newer wire format, for one, carries a `context.append_message` that
   * is a real user turn only when no `turn.prompt` has opened one yet — a fact
   * about the records already seen, not about this record. Keys are private to
   * the adapter that writes them.
   */
  readonly seen: Set<string>
  /**
   * A compaction boundary was crossed.
   *
   * What came before it is genuinely gone from the file, so this becomes the
   * snapshot's `partial` flag rather than merely its `hasOlder`.
   */
  compacted: boolean
}

/** What a bounded head-and-tail probe can learn without reading the whole file. */
export interface TranscriptHead {
  /** Best available human-facing name; absent when the probe found none. */
  readonly title?: string
  /** Working directory the agent recorded, used to scope listing to this workspace. */
  readonly cwd?: string
  /** The conversation's opening user prompt, for ranking and for a title fallback. */
  readonly firstPrompt?: string
  /** Session start in Unix epoch milliseconds, when the format records one. */
  readonly createdAt?: number
}

/**
 * A pure reader for one transcript format.
 *
 * The interface is line-local rather than whole-file because a transcript can
 * be hundreds of megabytes: `read()` streams and folds, holding only the
 * requested window. A whole-file entry point is then a trivial loop over
 * {@link TranscriptAdapter.step}, which is what the tests use.
 */
export interface TranscriptAdapter {
  /** Registry key; also the `kind` half of every reference id this adapter owns. */
  readonly kind: AgentKind
  /** Name shown beside a candidate in the `@` menu. */
  readonly displayName: string
  /**
   * Where this agent keeps its transcripts.
   * @param home - the user's home directory.
   * @returns absolute directories to walk, most canonical first.
   */
  defaultRoots(home: string): readonly string[]
  /**
   * Whether a discovered file could be this format, from its path alone.
   * @param relativePath - path below the root, using forward slashes.
   * @returns whether the file is worth opening. No I/O.
   */
  matches(relativePath: string): boolean
  /**
   * Whether this format must be read whole before it yields any turn.
   *
   * A line-local adapter folds each record as it arrives and can be read from
   * a byte region at the end of a file it never fully opens. A document
   * adapter cannot: half of a JSON object is not a smaller JSON object, and
   * half of a branch tree is not a shorter conversation. Marking it here lets
   * the reader refuse an oversized file with a reason instead of streaming it
   * to a silent zero turns.
   */
  readonly document?: boolean
  /** Fresh fold state for one file. */
  createState(): AdapterState
  /**
   * Fold one record into zero or more completed turns.
   *
   * Returns only turns that are *finished*: an assistant run stays buffered in
   * `state.pending` until something closes it, so a caller that stops early
   * must call {@link TranscriptAdapter.flush}.
   * @param line - one raw line; malformed JSON is skipped, never thrown.
   * @param state - fold state, mutated in place.
   * @param options - projection settings.
   * @returns turns completed by this record, in order.
   */
  step(line: string, state: AdapterState, options: ConvertOptions): readonly ParsedTurn[]
  /**
   * Close the transcript.
   *
   * For a line-local adapter this only closes the trailing assistant run. For
   * a {@link TranscriptAdapter.document} one it is where the entire fold
   * happens, which is why it takes the projection settings: a document adapter
   * that defaulted them would ignore `includeThinking` and `toolCalls`.
   * @param state - fold state, mutated in place.
   * @param options - projection settings, the same ones `step` was given.
   * @returns the turns this closed, in order.
   */
  flush(state: AdapterState, options: ConvertOptions): readonly ParsedTurn[]
  /**
   * Derive metadata from bounded slices of the file's start and end.
   * @param headLines - complete lines from the start of the file.
   * @param tailLines - complete lines from the end of the file.
   * @returns what those slices could establish; every field optional.
   */
  head(headLines: readonly string[], tailLines: readonly string[]): TranscriptHead
}

/**
 * The narrow slice of SQLite a database-backed adapter is allowed to use.
 *
 * Deliberately not `DatabaseSync`. Keeping the adapters behind this interface
 * is what lets them stay in the same pure tier as the line-local ones: they
 * import no `node:sqlite`, so they load on a Node that has none, and a test can
 * drive one from a literal table instead of a temporary file. It is read-only
 * by construction — there is no `run`, so no adapter can write to a database
 * the user's own agent owns.
 */
export interface SqliteReader {
  /**
   * Run one parameterised query.
   * @param sql - the statement; every value must come through `params`.
   * @param params - bound values, in order.
   * @returns every row, as plain objects keyed by column name.
   */
  all(sql: string, ...params: readonly (string | number)[]): readonly Record<string, unknown>[]
  /**
   * Column names of one table, for probing between schema variants.
   *
   * Two of the three supported databases are the same project one fork apart
   * and differ by a single column, so asking is cheaper than maintaining a
   * version table that neither of them writes.
   * @param table - the table to describe.
   * @returns its column names; empty when the table does not exist.
   */
  columns(table: string): ReadonlySet<string>
}

/**
 * One conversation inside a database that holds many.
 *
 * This is what a directory scan learns about a file for the line-local
 * formats, except that here it comes back from an indexed query rather than
 * from a bounded read of the file's two ends — so there is nothing to amortize
 * and no bookmark to write.
 */
export interface TranscriptSession {
  /** Primary key inside its database; the second half of the reference id. */
  readonly id: string
  /** Human-facing name the agent recorded; empty when it recorded none. */
  readonly title: string
  /** Working directory the session ran in, for workspace scoping; may be empty. */
  readonly cwd: string
  /** Session start in Unix epoch milliseconds; 0 when unknown. */
  readonly createdAt: number
  /** Last activity in Unix epoch milliseconds, used to order the menu. */
  readonly updatedAt: number
}

/** One conversation folded out of a database. */
export interface SessionTurns {
  readonly items: readonly ParsedTurn[]
  /** Older messages were left unread because the record cap was reached. */
  readonly truncated: boolean
  /** The agent compacted this session, so what came before is gone from the database too. */
  readonly compacted: boolean
}

/**
 * A pure reader for one database-backed transcript format.
 *
 * Separate from {@link TranscriptAdapter} rather than a mode of it, because the
 * two disagree about what a transcript even is. A JSONL file is one
 * conversation and can be folded a record at a time from any byte offset; a
 * SQLite database is many conversations and is only addressable by query. The
 * shared parts — the kind, where it lives, how a turn is shaped — stay shared;
 * the fold does not.
 */
export interface QueryAdapter {
  /** Registry key; also the `kind` half of every reference id this adapter owns. */
  readonly kind: AgentKind
  /** Name shown beside a candidate in the `@` menu. */
  readonly displayName: string
  /** Discriminant: marks this adapter as database-backed rather than line-local. */
  readonly query: true
  /**
   * Directories holding this agent's database.
   * @param home - the user's home directory.
   * @returns absolute directories to walk, most canonical first.
   */
  defaultRoots(home: string): readonly string[]
  /**
   * Whether a discovered file is this agent's database, from its path alone.
   *
   * Must reject SQLite's `-wal` and `-shm` sidecars, which sit beside the
   * database and are not databases.
   * @param relativePath - path below the root, using forward slashes.
   * @returns whether the file is worth opening. No I/O.
   */
  matches(relativePath: string): boolean
  /**
   * Every conversation the database holds, newest activity first.
   * @param db - a read-only reader over the database.
   * @param limit - most sessions to return.
   * @returns the sessions, already filtered of whatever this format considers noise.
   */
  sessions(db: SqliteReader, limit: number): readonly TranscriptSession[]
  /**
   * Describe one conversation by id.
   *
   * Needed because a database-backed reference is read without a listing having
   * happened first — the model may hold an id from a previous turn — and the
   * row that names a session is the only thing that can label it. Unlike
   * {@link sessions} this applies no discovery filter: a caller holding an id
   * has already got past whatever the menu chose not to show.
   * @param db - a read-only reader over the database.
   * @param sessionId - the conversation to describe.
   * @returns its row, or undefined when the database has no such session.
   */
  session(db: SqliteReader, sessionId: string): TranscriptSession | undefined
  /**
   * Fold one conversation into turns, oldest first.
   * @param db - a read-only reader over the database.
   * @param sessionId - the conversation to read.
   * @param options - projection settings.
   * @param maxRecords - most message rows to materialize; older ones are dropped first,
   *   which mirrors what the line-local reader does when a file is too large to stream.
   * @returns the turns, and what was lost getting them.
   */
  turns(db: SqliteReader, sessionId: string, options: ConvertOptions, maxRecords: number): SessionTurns
}

/** Either kind of reader, as discovery and reading hold them. */
export type AgentAdapter = TranscriptAdapter | QueryAdapter

/**
 * Narrow an adapter to the database-backed shape.
 * @param adapter - either kind of reader.
 * @returns whether it reads a database rather than a line-local file.
 */
export function isQueryAdapter(adapter: AgentAdapter): adapter is QueryAdapter {
  return (adapter as Partial<QueryAdapter>).query === true
}
