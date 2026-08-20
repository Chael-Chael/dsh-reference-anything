# Third-party notices

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

## DeepSeek Harness reference services

File candidate formatting and cross-session candidate types use the official
DeepSeek Harness packages `@deepseek-ai/dsh-file-reference` and
`@deepseek-ai/dsh-session-reference`. Those packages remain external package
dependencies and are used under the DeepSeek Harness project's MIT license.
