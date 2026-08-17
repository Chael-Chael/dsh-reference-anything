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

## dsh-at-file

Portions of the workspace file/folder autocomplete, path ranking, and
existence-only reference implementation are adapted from `dsh-at-file`:

- Upstream repository: https://github.com/omdsh-dev/dsh-at-file
- Upstream revision: `898369ece56ae6ec41afd8e014f187bb5b723409`
- Upstream license: MIT

Copyright (c) 2026 dsh-at-file contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## DeepSeek Harness session reference

Cross-session candidate listing, canonical `dsh-session:` references, and
immutable snapshot preparation use the official DeepSeek Harness package
`@deepseek-ai/dsh-session-reference`. That package remains an external/package
dependency and is used under the DeepSeek Harness project's MIT license.
