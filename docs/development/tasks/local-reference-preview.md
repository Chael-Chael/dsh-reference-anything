# Local Agent readable references

- Scope: local Agent references use durable readable locators and automatic body previews; body/tool/image reads use numeric message ranges and source revisions. No full-text snapshot or completed parse cache. Non-local references, scanning/settings/icons/filters and Chat Import actions retain their existing behavior.
- Status: implementation, automated checks and real Web acceptance complete.
- No commit, push or package publication. Pre-existing working-tree changes preserved.

## Implementation

- Composer transport stores source/path/sessionId; model-facing context contains one readable `<local-agent-reference>` block. User-visible @ selection stays the same. Old local dsh-ref/ref/cursor identifiers are deliberately rejected; reselect them.
- Pre-step resolves, checks task grants and canonical source roots, parses the original record and adds a bounded English preview. Copied full locator blocks and durable session history restore grants. Quoted references inside body data do not grant additional conversations.
- Preview budget uses complete serialized UTF-8 bytes. The initial per-reference budget has since been replaced by [send-time shared remaining-context budgeting](shared-reference-budget.md). Old non-checkpoint body messages are dropped before shortening text head/tail. Omissions are separated by category.
- `reference_read`: source/path/sessionId/revision, 1-based start/limit, mode body/tools. `reference_search`: body text matches and numeric positions. `reference_image`: actual DSH attachment image blocks, 10 MiB per image.
- Source revision includes normalized complete parser output, original-file fingerprints and source/WAL versions. Tool visibility does not affect it. Stale body/search/image calls reject; omitting revision in reference_read refreshes.
- At most two concurrent parses; Codex header reads stream. Existing converters can still read a whole source into memory; no completed body parse is cached. SQLite remains read-only. Missing files, access failures, parse failures and revision changes are reported separately.
- Bounded local Native tool results request canonical rendering through the public post-execute contract, preserving host blocks/replacements while avoiding a second spill-policy truncation. Other tools keep the host policy.
- Vendor sync script retains all local converter patches when updating pinned upstream input. Codex attachment wrappers preserve the real My request text and image-only messages. Codex/Claude compaction checkpoints are retained alongside earlier body text. Converter-generated tool IDs do not enter structured revisions.

## Automated evidence

- Final verification: `.codex-tmp/agent-workflow/verify-1792316953188/`; typecheck, full tests and build passed: 1098 passed, 8 skipped, 58 test files passed, 2 skipped. Skips are existing opt-in/platform cases, not reported as passes.
- New integration coverage includes actual pre-step injection, UTF-8 budget formula/override/fallback, numbered body and tool association, native image blocks, stale versions, copied and resumed authorization, root/junction escapes, session identity, Codex attachment wrappers/checkpoints, stable Vibe IDs, canonical local output and host policy denial.
- Structured projection/revision checks now run through existing source fixtures including SQLite and compressed inputs.
- Break check: isolated `.codex-tmp/local-reference-break/` copy bypassed root validation. The arbitrary-path test failed because a forbidden source was returned; working-tree security code was never changed.

## Web and source evidence

- Environment: agent-browser-test, http://127.0.0.1:3081; actual DeepSeek-V4.1-Flash official account model, High. Source data remained read-only.
- Initial FAIL: session `session-0d521ab3-5d6a-4d22-9f7b-652b7c586088`, turn 1, preview notice seq 8 and failed read seq 28/29. Root cause: upstream Codex prompt filter treated the attachment wrapper, including My request, as injected metadata; no user turn was opened. Fixed in vendor generation patch and covered by regression.
- Retest: session `session-35c3e502-2e35-40c8-9752-1618b7fce6f8`, same source/input/model, turn 1: seq 8 has 4278-byte automatic preview, body 1-7 of 7, 4 images, no opaque URI/handle/cursor. Calls seq 20-23 are read/search/read tools/image; results seq 24-27 all successful, seq 27 contains text + native image. Image verified visually against exported original: DSH composer with ChatGPT reference using a generic robot icon, 1069×286 PNG.
- Restart continuation, same session turn 2: calls seq 45/46 and results seq 47/48 succeeded after Web process restart. This also exposed host spill-policy second truncation (seq 47); resolved by bounded canonical projection and covered by host-policy tests. Final retest below.
- Final restart retest, same session turn 3: results seq 69/70 succeeded. The tool JSON parses completely (22 records, 4 shortened by the response budget, 64619 UTF-8 bytes); image result contains text + image. No spill path. The model's reported count of 21 was inaccurate; this count is from the exported JSON.
- Cross-session copy: new session `session-0a5d4e09-4d8c-48c1-9686-6353c21a8e2f`, turn 1, complete tagged locator pasted into a new conversation. Seq 8 automatically provides a 4386-byte preview with no opaque URI/handle/cursor. Calls seq 23-26 and results seq 27-30 pass body/search/tools/image; all text payloads parse as complete JSON and have no spill path. Tools result has 22 records (4 budget-shortened), 64595 bytes. Native image SHA-256 matches the first test. The model correctly distinguishes response-budget truncation from missing original text.
- Sanitized evidence: `.codex-tmp/local-preview-final-evidence.json`, `.codex-tmp/local-preview-log-evidence.json`, `.codex-tmp/local-preview-resume-evidence.json`, `.codex-tmp/local-preview-real-report.json`. Screenshot: `.codex-tmp/local-preview-web-acceptance.jpg`.
- Additional real local parser samples: Codex 2,280,681 bytes, 7 bodies/96 tool records/4 images, 81 ms; Claude 15,823 bytes, 2 bodies, 5 ms; Antigravity 26,579 bytes, 4 bodies/20 tools, 4 ms; WorkBuddy 152,321 bytes, 6 bodies/10 tools, 4 ms. Each repeated read had the same revision and matching source sessionId. These are individual samples, not universal latency guarantees or every-source live acceptance.

## Limits

- Old local reference protocol is intentionally not migrated. Paths remain machine-specific. Deleted original records cannot be reread.
- Full parsing can consume memory proportional to the source size. Large-file performance is not exhaustively benchmarked.
- Native direct tool calls tested; generic model programs that reprint tool values through other host tools remain governed by those tools' policies.
- Desktop: built artifact linked and process restarted; actual Desktop window acceptance NOT_RUN (current available UI surface is Web).
- No npm clean-install/publish validation or real-account test for every one of 29 providers in this task.
- Final Web continuation/copy retests passed. Task-created export ZIPs and extracted image/locator copies were removed after the sanitized evidence was saved; original sessions and user-supplied archives were retained.

## Supplemental Claude Code / Antigravity Web acceptance (2026-10-18)

- User scope: complete real Web acceptance for the two previously parser-only sources, Claude Code and Antigravity. OpenCode acceptance was subsequently completed below.
- Same agent-browser-test profile on port 3081, DeepSeek-V4.1-Flash official account, High. Both selected using their provider shortcuts in the actual @ menu; source records remain read-only.
- Claude Code PASS: session `session-414e2b48-d085-447e-a56a-29bcfe9863ea`, turn 1. Preview seq 8 has 15 body messages and 2 images (5878 bytes). Calls 26-30/results 31-35 cover body 1-2, search (1 match), tools for messages 2-3 (10 records), image-1 and image-2. All successful, complete JSON, no spill. Both image results contain actual native image blocks; exported image bytes match attachment SHA-256. Visual inspection confirms the model's descriptions: blue Claude Code menu and striped Default backend selector. Model summary agrees with source's theme propagation/select rendering work.
- Antigravity initial content FAIL: session `session-443b80d5-6652-4d6b-b1a0-e0e47fd7487f`, turn 1. Preview seq 8 has 51 body messages, 0 images (19852 bytes); calls/results succeed technically, search returns messages 16/17, but tool result seq 25 wrongly substitutes 11 missing-background placeholders for real directory/file results. Direct source comparison proves LIST_DIRECTORY/VIEW_FILE contents exist. Never count transport success as content acceptance.
- Root fix in our vendored parser generator: upstream converter only handles GENERIC results. Recognize typed directory/file/code-action/subagent/command/search results and match pending calls by tool name; preserve RUNNING/system exclusions and genuine missing-result handling. No upstream Chat Import repository or installed npm plugin changed.
- First retest, same Antigravity session turn 2: results 59-61 contain real outputs, but seq 61 has one directory result replaced by an unrelated async sidecar report sharing its step index. Scope sidecar substitution to GENERIC results; typed records retain their own content. Direct comparison after correction: all 11 selected results match original transcript text, zero missing placeholders.
- Regression red/green: test fails on original six typed results, passes after typed mapping, then fails on sidecar collision and passes with GENERIC-only supplementation. Break check in isolated `.codex-tmp/antigravity-match-break` removed name matching and failed on swapped directory/file results; working source was not weakened.
- Latest full check/build: `.codex-tmp/agent-workflow/verify-1792318321854/`, 1099 passed / 8 skipped; Web and Desktop processes refreshed.
- Final Antigravity Web PASS: same session turn 3, results seq 93-95. Body read/search succeed; seq 95 returns 22 tool records including 11 results. Each of those 11 returned texts was independently compared with the original transcript and matches exactly after converter normalization; zero missing placeholders, zero response-budget shortening, complete JSON, no spill. The renderer/ui directory lists App.tsx and CursorTrail.tsx correctly. Model's final answer now agrees with those records. Screenshot `.codex-tmp/local-preview-antigravity-web-final.jpg`.
- Antigravity image limitation: parsed all 34 currently discovered transcripts without errors; none yielded image blocks. Selected source USER_INPUT has no image/attachment fields or image path markers. Image read acceptance is NOT_RUN for this source, not claimed as supported from this sample. Original source text may itself include truncation markers; model claims about complete original files are not evidence.
- Evidence: `.codex-tmp/local-preview-supplemental-evidence.json` retains initial failures and final PASS; `.codex-tmp/local-preview-claude-web.jpg`. Supplemental exports (one Claude ZIP and three Antigravity ZIPs) and two extracted source images removed after saving this sanitized evidence. Original sessions retained. No commit, push, npm publish or new upstream PR.

## OpenCode real Web acceptance (2026-10-18)

- PASS in the same agent-browser-test Web environment and official DeepSeek-V4.1-Flash High model. Selected the real Zotero translation conversation using `@opencode:Zotero`, inserted a read-only reference, and sent an explicit read/search/tool-detail acceptance request. Session `session-99c04d09-c1b1-4b2e-a78e-3e7920d98ba9`, turn 1; source session `ses_fcbc6c8c9ffeTVVLMKvpltA0m0` in the local OpenCode SQLite database.
- Preview seq 8: 5181 UTF-8 bytes, all 15 body messages, 72 tool records deferred, 0 images. Calls seq 20-22/results 23-25 passed body messages 1-2, search for the translation keyword (messages 1/13/14), and tool details associated with messages 2-3 (14 records, including 7 results; 12261 bytes).
- Independently opened the original SQLite database read-only: all 15 preview bodies match source text; all 7 returned tool-result strings match exactly, including CRLF endings. Same session identity and revision throughout, complete JSON, no response-budget shortening. The historical ripgrep failure and garbled PDF filename already occur in the original database; they are not current reference-tool failures. Model summary agrees with the source translation workflow.
- No OpenCode implementation change was needed. Tested the already built/synchronized artifact from `verify-1792318321854`; no redundant rebuild/restart for this documentation-only update. Desktop window acceptance remains NOT_RUN. No real image-read claim for OpenCode because this selected conversation has no images.
- Evidence: `.codex-tmp/local-preview-opencode-evidence.json`, screenshot `.codex-tmp/local-preview-opencode-web.jpg`. Test-created export ZIP and extracted log were removed after retaining the sanitized evidence; original source/database and DSH session retained.

## Budget and path boundaries clarified

- Preview truncation only changes a copied projection of referenced historical body text. Current user instructions, system/developer prompts, original records, locator/revision, tool guidance and omission metadata are not truncated by this implementation. If fixed reference metadata cannot fit, it reports a budget error.
- The initial implementation used a per-reference capacity budget. The subsequent [shared budget update](shared-reference-budget.md) now accounts for estimated remaining context at each send, with output and safety reserves. Host context management remains separate; estimates and minimal locator notices do not provide an absolute overflow guarantee.
- Paths are interpreted on the DSH host using its native filesystem rules. Windows/macOS/Linux paths are supported on their respective hosts, but a Windows absolute path is not automatically mapped to another computer or OS. macOS/Linux runtime acceptance was not performed on this Windows machine.
