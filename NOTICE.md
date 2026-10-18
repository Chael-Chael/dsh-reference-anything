# Third-party notices

## Lucide action icons

The Import, Summary, and Undo 2 SVG paths in `src/client/provider-icons.tsx`
are from https://github.com/lucide-icons/lucide and are licensed under ISC:

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

The OpenCLI provider adapters in `opencli-plugin/` are derived in part from
`pinguarmy/ai-chat-exporter` at commit
`9f0f9e21d818316d45c0a13c98d288a80bb8174e`.

AI Chat Exporter is Copyright (c) pinguarmy contributors and is licensed under
the MIT License. The adapted source paths are:

- `src/contents/chatgpt-parser.ts`
- `src/contents/claude-parser.ts`
- `src/contents/gemini-parser.ts`
- `src/contents/deepseek-parser.ts`
- `src/contents/grok-parser.ts`
- `src/lib/grok-api.ts`

OpenCLI is not redistributed by this package. It is an external runtime
dependency licensed under Apache-2.0.

## Local agent transcript formats

The transcript formats read by `src/sources/local-agent/adapters/` were
determined from `Nwflower/dsh-chat-import` at commit
`0fb7d9c479dd7f56edc61c8c633b883abdae3dfd`, whose `lib/convert/*.mjs` converters
and default root layouts are the documentation of record for the twelve formats
this package could not validate against a local corpus.

dsh-chat-import is licensed under the MIT License. Nothing is copied from it:
that project imports transcripts into DSH's session store, while this one only
reads them in place, so the adapters here are separate implementations against
the same record shapes. The attribution is for the format knowledge, which is the
part that was genuinely reused.

Claude Code and Codex were additionally validated against real transcripts on the
developer's own machine and do not rest on that source.

## Cloud drives

The managed OpenList binary is pinned to v4.2.2 and is licensed under the
GNU Affero General Public License v3.0 (AGPL-3.0). Corresponding source is
available at https://github.com/OpenListTeam/OpenList/tree/v4.2.2.

The optional API Pages connection is the official hosted service and source at
https://github.com/OpenListTeam/OpenList-APIPages. API Pages is not copied or
redistributed by this package.

## DeepSeek Harness reference services

File candidate formatting and cross-session candidate types use the official
DeepSeek Harness packages `@deepseek-ai/dsh-file-reference` and
`@deepseek-ai/dsh-session-reference`. Those packages remain external package
dependencies and are used under the DeepSeek Harness project's MIT license.

## dsh-chat-import agent icons

Settings icons in images/agents are copied from Nwflower/dsh-chat-import (dbd03e1dfeaffea980458df1afc4ef899af9a2a4).
Copyright (c) 2026 Nwflower; Copyright (c) 2026 Scarlett.
Distributed under the MIT License; the full license is included in images/agents/LICENSE.

## Bundled conversation scanners and readers

`vendor/chat-import-reader/parsers.mjs` and `scanners.mjs` contain adapted
read-only discovery, database summary, parser and preview code from Nwflower/dsh-chat-import npm 0.26.1, plus its fzstd decoder.
Copyright (c) 2026 Nwflower and Scarlett; fzstd copyright (c) 2020 Arjun Barrett.
Both are MIT licensed. Full licenses are shipped in
`vendor/chat-import-reader/LICENSE` and `LICENSE.fzstd`; source hashes and
regeneration instructions accompany the snapshot in the repository.
