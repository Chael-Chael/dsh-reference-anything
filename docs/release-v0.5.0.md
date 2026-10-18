[中文](#cn-050) | [English](#en-050)

> 审稿草案 / Editorial draft：尚未发布，最终文字待审核，技术验收仍为 BLOCKED。

本版本是一次围绕本地 Agent 历史引用与接续工作流程的重大更新，汇总自 `v0.4.4` 以来的变更：来源目录从 14 类扩展到 29 类，升级本地引用工具协议，并新增正文预览、搜索、图片读取、会话导入和实验性交接摘要。

<h3 id="cn-050">新增功能</h3>

- 来源目录扩展至 29 类，新增 Antigravity、Kilo Code、ChatGPT 导出、WorkBuddy、Qwen Code、Continue、Cline、Goose、DSH4、Zed、Crush、TeleAgent、Trae Work、Mistral Vibe 和 DSH。
- 内置来自 Chat Import 0.26.1 的只读扫描与解析能力，统一发现更多格式的历史。无需安装独立 Chat Import 即可搜索和引用；导入与交接摘要才使用独立插件。
- 本地引用在发送时自动附上正文预览，让模型开始回答前就能看到历史上下文；正文、工具记录、图片目录分开展示。
- 重做本地会话工具协议：reference_read 使用 source/path/sessionId/revision 定位，按从 1 开始的消息编号 start/limit 补读，mode=body 或 tools 分别读取正文与关联工具记录。
- 新增 reference_search，在已授权的单条本地会话正文中搜索关键词，返回消息编号、匹配片段及后续搜索位置；不混入工具输出。
- 新增 reference_image，按图片 ID 取回原生图片内容，模型可以直接看图；每次一张、最大 10 MiB，需要可恢复的图片数据及视觉模型。
- 多条本地引用共享发送时的剩余上下文预算，计入历史、系统提示、工具定义和输出预留；优先保留压缩检查点及近期消息，空间不足则保留定位信息供后续读取。
- 新增可读的 dsh-local 定位与完整 local-agent-reference 引用块，支持同机重启后继续读取、跨会话复制完整引用；仍检查授权、来源根目录和原文件是否存在。
- Enter 引用，Tab 进入会话操作：通过 Chat Import 导入完整历史并打开目标会话，显示导入状态；操作失败在菜单中保留原因并支持重试。
- Claude Code 与 Codex 新增实验性交接摘要，将历史工作的摘要放入当前输入框，便于接着做；默认关闭，不自动发送。
- 新增“会话导入与交接”设置：导入入口、摘要入口及操作确认可分别配置，默认显示导入、关闭摘要并保留确认。
- 新增 Chat Import 状态检查与显式安装/升级入口，兼容已有独立版本；保留用户禁用决定，升级失败可重试，停用引用插件不移除独立 Chat Import。
- 新增离线可看的版本功能卡与 GIF 演示、上一页/下一页导航，以及首次进入该版本插件设置时的介绍；关闭介绍与隐藏菜单入口分别记录。

### 体验优化

- DSH 会话候选区分当前任务的子 Agent 会话并优先展示，补齐冷会话标题信息、过滤已确认的空会话，改进时间与名称展示。
- 文件浏览新增面包屑返回导航；下钻目录时隔离其他来源结果；文件引用支持通过宿主资源面板打开，目录继续保持 Tab 浏览、Enter 引用。
- 完善多个逗号分隔快捷词和跨来源共享快捷词的匹配，保留 codex 等具体来源别名的定向筛选。
- 后台检查会话正文可用性，隐藏已确认无正文的记录；未知结构、读取异常和超出检查预算的条目继续保留，文件变化后重新检查。
- 扫描改为独立子进程并增加短期缓存、请求合并和来源级警告，设置中可查看检测到的路径与会话数量。
- 插件启动后进行轻量连接检查；网页菜单在同步操作旁显示检查中、可用或异常状态，具体列出 OpenCLI、Bridge、适配器及扩展问题，未就绪时阻止无效同步。
- OpenCLI 2.0.0 随插件作为固定依赖安装，更新统一随插件交付；适配 JSON 管理输出、扩展兼容状态与新版 Bridge 生命周期，网页适配器更新至 0.2.3。
- 补齐扩展来源图标，调整本地来源卡片与扫描状态展示；当前版本说明与远端最新版本说明分开获取，避免更新信息错位。

### 问题修复

- 修正 @ 菜单首次打开时的异步选中顺序，等待排在前面的来源完成；用户开始键鼠操作后不再自动改动选择。
- 修正下钻操作与普通搜索缓存混用、重复点击导入/摘要以及菜单刷新影响操作状态的问题，保留错误和重试入口。
- 完善 Codex 附件包装中的正文与图片、Codex/Claude 压缩检查点、Trae 消息分段，以及 Antigravity 类型化工具结果和异步结果的解析关联。
- 防止宿主二次截断破坏有界本地工具结果，保留宿主拒绝/替换策略；明确标注省略范围、截断字节和未读取图片，来源变化后拒绝复用旧消息编号。
- 加强真实路径、来源根目录、会话身份和引用授权验证；导入/摘要只接受当前扫描选择，原始记录缺失或权限失败时返回明确错误。

### 其他变更

- 建立演示、亲测、Desktop、Agent 浏览器测试四环境分工，以及真实来源验收、官方 Session Log 诊断、tgz 安装矩阵、累计报告与文案审稿流程。

#### 本地 Agent 工具协议迁移

这是本次的重要兼容性变化，指的是**读取本地 Agent 历史的工具**，不是启动或远程控制另一个 Agent。

| 调用方式 | 0.4.4 | 0.5.0 本地会话 |
| --- | --- | --- |
| 定位 | `uri` | `source`、`path`、`sessionId` |
| 读取范围 | `cursor` / `before` 翻页 | 从 1 开始的 `start` + `limit` |
| 内容选择 | `detail` | `mode: "body"` 或 `"tools"` |
| 版本一致性 | 旧引用/翻页链 | 预览返回的 `revision` |
| 搜索 / 图片 | 无本地专用工具 | `reference_search` / `reference_image` |

例如，读取已选中的 Codex 会话（以下为结构示意，字段须原样复制实际预览，不能照抄占位符）：

```json
{"source":"codex","path":"<原始会话绝对路径>","sessionId":"<实际会话 ID>","revision":"<预览返回的 revision>","start":1,"limit":20,"mode":"body"}
```

将这组参数交给 `reference_read`；`mode: "tools"` 读取对应消息的工具记录。`reference_search` 使用同一定位与 revision 加 `query`；`reference_image` 使用同一定位与 revision 加预览目录中的 `imageId`。

**旧格式本地引用需重新从 @ 菜单选择。** 本地调用不再接受 `uri/cursor/before/detail`；原文件变化时先用 `reference_read` 省略 revision 刷新预览，再使用新编号。工具详情、搜索和图片调用须携带 revision。其他来源继续沿用其现有协议。

#### 演示与已知限制

![真实 Web 中插入 Codex 与 Claude Code 的虚构历史引用；未发送模型请求。](../release-notes/0.5.0/demos/local-references.gif)

![Enter 引用、Tab 打开确认并模拟导入虚构历史。](../release-notes/0.5.0/demos/agent-import.gif)

来源目录覆盖不等于全部来源均通过真实账号验收；交接摘要为实验功能。预算是保守估计，大记录解析仍可能消耗较多内存；不保存本地正文快照，后续读取依赖原文件。GIF 使用隔离演示数据，不是服务验收证据。

<h3 id="en-050">New Features</h3>

This major update covers changes since `v0.4.4`, focusing on local Agent history and continuing previous work. It expands the source catalog from 14 to 29 formats, upgrades the local reference tool protocol, and adds body previews, search, image retrieval, session imports and experimental handoff summaries.

- Expand the local-source catalog from 14 to 29 formats, adding Antigravity, Kilo Code, ChatGPT exports, WorkBuddy, Qwen Code, Continue, Cline, Goose, DSH4, Zed, Crush, TeleAgent, Trae Work, Mistral Vibe and DSH.
- Bundle read-only scanners and parsers derived from Chat Import 0.26.1. Search and reference local history without installing the independent Chat Import plugin; imports and handoff summaries use that plugin separately.
- Attach a body preview when a local reference is sent, so the model receives historical context before answering. Present body messages, tool records and image indexes separately.
- Redesign local tool calls: reference_read uses source/path/sessionId/revision, 1-based start/limit message ranges, and mode=body or tools for body text or associated tool records.
- Add reference_search for body-text search within a granted local conversation, returning message numbers, excerpts and a continuation position. Tool output is excluded.
- Add reference_image to retrieve actual historical images by ID: one image per call, up to 10 MiB, with recoverable source bytes and a vision-capable model required.
- Share the remaining send-time context budget across local references, accounting for history, system prompts, tool definitions and output reserves. Favor checkpoints and recent messages; retain locators when previews cannot fit.
- Introduce readable dsh-local locators and complete local-agent-reference blocks for rereading after restarts and reuse across conversations on the same machine, with authorization, source-root and original-file checks.
- Use Enter to reference and Tab to open conversation actions: import history through Chat Import, open the destination session and display import status. Keep actionable errors in the menu for retry.
- Add experimental handoff summaries for Claude Code and Codex, placing the summary in the current composer. Disabled by default, with no automatic send.
- Add separate settings for import actions, handoff summaries and confirmation. Defaults show imports, disable summaries and keep confirmation enabled.
- Add Chat Import status checks and explicit install/upgrade actions, reuse compatible independent installations, respect disabled states, allow retry after failure and retain Chat Import when Reference Anything is disabled.
- Add offline feature cards and GIF demonstrations, previous/next navigation and an introduction on the first visit to the installed version’s settings. Closing the dialog and dismissing its menu entry are separate actions.

### Improvements

- Prioritize and label subagent sessions belonging to the current task, refresh cold-session metadata, omit confirmed blank sessions and improve titles and timestamps.
- Add breadcrumb navigation to file browsing, isolate folder drill-down results from other sources and open file references through the host resource panel. Keep Tab for browsing and Enter for referencing folders.
- Improve matching for comma-separated shortcuts and shared shortcuts across sources while preserving provider-specific filters such as codex.
- Check transcript availability in the background and hide confirmed bodyless records. Keep unknown formats, read failures and over-budget records visible, and recheck changed files.
- Run discovery in a separate process with short-lived caching, request coalescing and source-specific warnings. Show discovered paths and session counts in settings.
- Run a lightweight connection check on startup. Show checking, ready or failure status beside Web sync actions, identify OpenCLI, Bridge, adapter and extension issues, and block sync when prerequisites are not ready.
- Ship pinned OpenCLI 2.0.0 with the plugin and update it through plugin releases. Support JSON management output, extension compatibility and Bridge lifecycle changes; update the Web adapter to 0.2.3.
- Extend source icons and refine local-source cards and scan status. Fetch installed-version notes separately from latest-version notes to avoid showing the wrong release.

### Bug Fixes

- Fix initial selection races between asynchronous @ groups; wait for earlier groups and stop automatic selection once the user interacts.
- Separate drill-down actions from ordinary search caches, prevent duplicate import/summary requests and preserve action state and retry errors across menu refreshes.
- Preserve Codex wrapper text and images, Codex/Claude compaction checkpoints and Trae message parts; correctly associate typed and asynchronous Antigravity tool results.
- Preserve bounded local tool results through host rendering without overriding denial/replacement policies. Report omissions, shortened text and unread images, and reject stale message positions after source changes.
- Strengthen canonical-path, source-root, session-identity and reference-authorization checks. Restrict imports/summaries to scanned selections and report missing sources or permission failures explicitly.

### Chores

- Establish separate demo, user-test, Desktop and Agent-browser environments, plus real-source acceptance, official Session Log diagnosis, tgz installation checks, cumulative reporting and editorial review.

#### Local Agent tool protocol migration

This changes tools that **read local Agent history**, not tools that launch or remotely control another Agent. Local `reference_read` moves from `uri/cursor/before/detail` to `source/path/sessionId/revision`, 1-based `start/limit`, and `mode: "body"` or `"tools"`. Copy locator fields from the actual preview rather than constructing them.

```json
{"source":"codex","path":"<absolute source path>","sessionId":"<actual session ID>","revision":"<revision from preview>","start":1,"limit":20,"mode":"body"}
```

Use the same locator and revision with `query` for `reference_search`, or `imageId` from the preview for `reference_image`. **Reselect old local references from the @ menu.** If the source changes, omit revision in `reference_read` to refresh before using new positions. Tool-detail reads, searches and image calls require revision. Other sources retain their existing protocols.

#### Demos and known limitations

The GIFs above use fictional data in the real Web UI, including a simulated import; they are not live-service acceptance evidence. Catalog coverage does not mean every source has passed real-account testing. Handoff summaries are experimental. Context budgeting is conservative, large sources can still consume substantial memory, and later reads require the original files because body snapshots are not saved.

Full Changelog: [v0.4.4…e2841ac](https://github.com/Chael-Chael/dsh-reference-anything/compare/v0.4.4...e2841acb7fff670f5fff687c827b300a2554701d). 远端基线已核对；本轮文案未提交，最终发布前更新为审核通过的最终提交或标签。 Remote baseline verified; this editorial revision is uncommitted. Update the comparison to the approved final commit or tag before publication.
