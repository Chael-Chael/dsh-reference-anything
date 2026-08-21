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

## Cloud drive transports

`src/sources/cloud-drive/providers/` talks to each drive's own HTTP API directly.
No vendor code is redistributed here and no vendor SDK is a dependency; what was
reused is the request shape, which was read from these sources.

**百度网盘.** Endpoints, parameters, and response fields come from the official Go
SDK `baidu-netdisk/baidu-drive-sdk-go` and from the official
`baidu-netdisk/bdpan-storage` skill repository, both licensed under the Apache
License 2.0. The credential is the one that repository's `login.sh` already
mints; this package reads `~/.config/bdpan/config.json` and never writes it.

**阿里云盘 (PDS).** Data-plane request shapes — `POST {endpoint}/v2/file/list`,
`/file/search` and its query syntax, `/file/get_download_url`, and the
`Authorization: Bearer` header the data plane takes in place of Alibaba request
signing — come from `aliyun/aliyun-pds-js-sdk` v1.4.0, licensed under the MIT
License.

The credential location and layout come from a different place, and it is worth
saying which. The `aliyun` CLI's `pds` plugin is distributed as a compiled Go
binary under the Apache License 2.0 with no published source; the path
`~/.aliyun/pds_config.json` and the `{current, profiles[]}` shape this package
reads were recovered from the debugging information in the shipped binary itself
(`aliyun-cli-pds` 0.7.8, sha256
`b11db8c52338814ed4438e82a7504da3e4b7552948f982777419dbee3f8b66dc`). That is the
plugin's own on-disk format rather than a documented interface, so it is
transcribed rather than guessed at, and this package treats it as read-only: it
never writes the file, never refreshes the token, and leaves login and logout to
the CLI that owns it.

## DeepSeek Harness reference services

File candidate formatting and cross-session candidate types use the official
DeepSeek Harness packages `@deepseek-ai/dsh-file-reference` and
`@deepseek-ai/dsh-session-reference`. Those packages remain external package
dependencies and are used under the DeepSeek Harness project's MIT license.
