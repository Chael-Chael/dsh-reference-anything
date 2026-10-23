# Bundled conversation scanners and readers

Derived from [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import), npm
0.26.2 (MIT). `upstream-sha256.json` records the exact version and source hashes.
Both generated bundles include fzstd (MIT); `LICENSE` and `LICENSE.fzstd` ship
with the package. Upstream paths in comments are not runtime dependencies.

`parsers.mjs` exposes preview-based text/image reading and default roots.
`scanners.mjs` reuses all upstream source descriptors and SQLite summary readers.
The scan entry provides filesystem-only access and runs in `scan-worker.mjs`,
without plugin registration or session mutations. The host caches metadata for
30 seconds; missing paths are empty, while permission/database errors are warnings.
Import status is not inferred locally: Reference Anything asks the optional
Chat Import API separately. Import and summaries also remain API operations.

Local patches expose preview content, preserve Trae message parts, export the
upstream database-summary table, and replace a dynamic Trae scanner import with
a static named import so mutation code can be removed by tree shaking.
The generator rejects leaked mutation code and changed patch anchors.
Antigravity IDE typed tool results (directory/file reads, code actions,
subagents, commands and searches) are matched by tool name rather than discarded
as missing background output; GENERIC results keep their existing handling.
Async sidecar reports only supplement GENERIC results, never replace typed output.
Hermes SQLite and JSONL reads preserve tool-only assistant messages, OpenAI-style
function calls, and role=tool results. Results are associated by call ID, including
parallel calls; string arguments and result text remain unchanged.

## Update from upstream

1. Download/build the desired upstream version in a separate directory (or use
   an installed npm package directory). Do not overwrite the running Desktop plugin.
2. Run `npm run vendor:sync -- <built-dsh-chat-import-directory>` from this repository.
   This regenerates both bundles and their shared version/hash manifest. Normal
   builds never download upstream or inspect another installed plugin.
3. Review source/version/license changes, then run `npm run agent:verify` and
   test the Web profile with Chat Import disabled and enabled. The catalog test
   detects new upstream formats that need settings/icon/type support here.
4. Ship the verified snapshot in a new Reference Anything release. Users receive
   upstream changes when updating Reference Anything, not automatically at runtime.

Parsing a reference may read its whole source before returning a page. Images
require recoverable bytes or a valid attachment; unavailable images are reported.

The structured read projection numbers body messages independently of tools,
links tool records and images to those numbers, and hashes normalized source
content before applying presentation budgets. The host adds original-file
fingerprints/version checks. This projection is used for automatic send-time
previews and numeric read/search/image calls; it retains no parsed-body cache.
