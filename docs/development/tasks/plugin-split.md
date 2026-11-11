# 来源插件化（一切皆插件）

- 用户目标与授权范围：每个 @ 来源是可独立开关的插件；设置开关与功能一一对应；第三方可接入自己的引用来源。用户 2026-11-10 选定单包方案（不拆 npm 包）。授权范围为本地实现，提交/发布另行授权。
- 状态：进行中
- 工作区：`D:/dsh-reference-anything-claude`，分支 `claude/main-work`，基于 origin/main `3d0d788`（= v0.5.2 产品代码）。
- 基线：typecheck 通过；vitest 1189 passed / 8 skipped。

## 目标架构

- 核心 `references`（`src/index.ts`）：来源注册表、授权、模型工具、提及展开、菜单外壳、设置存储、自更新。
- 来源插件只依赖 `references`，在自身生命周期内注册；插件行关闭 = 该来源功能关闭。
- 设置：核心持有 `reference_anything_sources` 存储域，每个来源一条记录，由来源自己的 schema 校验（`ctx.references.defineSettings`）。核心不知道任何来源的字段。
- 旧设置迁移：web-chat 启动时把旧 `reference_anything` 全局记录交给核心保存一次（`publishLegacySettings`）；各来源用自己的 `fromLegacy` 映射，只覆盖从未由用户保存过的条目。旧记录保留不删，便于降级。
- 安全语义保持：旧 `picker.agents.enabled=false` 是本地 Agent 的读取闸门，迁移为 `enabledAgents=[]`，不因菜单开关改为"只管显示"而放开读取。

## 阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P1 | 核心设置注册表（`src/settings.ts`，`ctx.references.defineSettings`） | 完成 |
| P2 | 各来源设置拆分与迁移；Remote 暂时组合旧形状，客户端不变 | 宿主侧完成 |
| P3 | 模型工具按来源能力分派（附件、读取上限）；`dsh-local:` 协议判断集中 | 完成 |
| P4 | 每个来源自己的 Remote；`web.ts` 不再强依赖 web-chat/OpenList | 完成（真实 UI 未验） |
| P5 | 客户端来源注册表；分组开关 = 插件行；未加载来源隐藏分组与设置分区 | 完成；Web 已真实验收 |
| P6 | 第三方示例来源与开发文档 | 完成（测试覆盖；未在真实宿主装载示例） |

## 设置归属（P2）

| 旧字段 | 新归属 |
| --- | --- |
| opencliPath, profile, detailConcurrency, autoSync, syncOnStartup, autoSyncMinutes, historyMode, syncHistoryDays, enabledProviders, maxReadTurns | web-chat |
| enabledAgents, agentDirectories, picker.agents.showImport/showSummary/skipConfirmation | local-agent |
| cloudDriveDownloadDirectory, enabledDriveMounts | cloud-drive |
| picker.plugins.onlyLive/showDeepSeek | local-plugin |
| picker.displayMode 与各分组 enabled/order/limit/maxCandidates/shortcut/aliases/sourceAliases | 核心菜单 |
| inputRenderMode, picker.*.sort | 删除（无代码读取） |

## P1/P2 已完成及证据

- 新增 `src/settings.ts`（存储域 `reference_anything_sources`）；各来源设置模块：`sources/local-agent/settings.ts`、`sources/cloud-drive/settings.ts`、`local-plugin-settings.ts`、`menu-settings.ts`。
- local-agent 不再通过 web-chat 读取设置；扫描/内置发现由新配置 `discovery`（默认 `scanner`）决定，不再取决于 web-chat 是否存在。
- 服务端强制：`enabledProviders`（web-chat list/search/read）、`enabledMounts`（cloud-drive list/pickerList/read/attachment）、插件过滤（local-plugin list/read）。
- `host.ts` 的 `settingsGet/settingsUpdate` 由各来源设置组合/拆分，客户端暂不改。
- 测试：新增 `tests/source-settings.spec.ts`、`tests/web-chat-providers.spec.ts`、`cloud-drive-source.spec.ts` 挂载开关用例；`npm run check` 退出码 0，1198 passed / 8 skipped。
- 过渡期语义：P2 后菜单"本地 Agent"分组开关只管显示，读取闸门只看各 Agent 开关；P5 将分组开关改为插件行开关。不在 P5 前发版。
- 遗留：web-chat `applySettings` 中的下载目录校验已成死路径（宿主传入其自身旧值），连同 `download-directory.spec.ts` 的相关用例在 P4 迁到 cloud-drive。

## P3 已完成及证据

- `ReferenceSource` 新增可选能力：`readLimit()`、`attachments`（`fetch` 返回字节或 `writeTo`，核心负责临时目录、大小上限、图片保存与清理）。`reference_attachment_read` 不再按来源名分支，第三方来源声明 `attachments` 即可用。
- web-chat 附件逻辑与 OpenCLI 错误映射移到 `sources/web-chat/attachments.ts`；云盘移到 `cloudDriveAttachments()`；`tool.ts` 不再依赖 web-chat / cloud-drive 服务。
- `'local-agent'` 字面量收敛为 `local-locator.ts` 的 `LOCAL_REFERENCE_SOURCE` / `usesLocalProtocol()`：它属于 `dsh-local:` 持久 URI 格式，不做成可注册项。
- 不改：`uri-codec.ts` 的 `compactReference` 来源列表。解码会重新编码比对，扩大列表会让其他来源的旧 URI 失去规范性；已加注释说明，第三方来源使用通用无损编码。
- 本地 Agent 的提及预览（`reference.ts`）仍在核心内，依赖 `dsh-local:` 协议；运行时关闭本地 Agent 时返回 SOURCE_DISABLED，不影响其他来源。
- 测试：`tests/tool.spec.ts` 新增能力用例；附件测试改用能力工厂；`npm run check` 退出码 0，1201 passed / 8 skipped。

## P4 已完成及证据

- Remote 拆为 4 个服务：`referenceAnything`（核心：设置、来源列表 `sources`、包更新、本地插件）、`referenceAnythingWebChat`、`referenceAnythingLocalAgent`、`referenceAnythingDrive`（含 OpenList 管理与新 `driveStatus`）。
- 各来源在自己的 init 中用 `mountRemote()` 挂载 Remote（Typert 存在时），随插件卸载；`web.ts` 只注入 `typert`、`references`。
- 包更新器从 web-chat 移到核心；更新后若 web-chat 已加载则重装 OpenCLI 适配器。
- 客户端分别挂载 4 个贡献，`composeRemoteFace` 合成原有接口；缺席的 Remote 返回 `SOURCE_UNAVAILABLE` 失败结果。存储统计与健康检查在 web-chat 关闭时不再让整个设置面板报错。
- 遗留：web-chat `applySettings` 的下载目录校验仍保留（死路径，仅为既有队列合并测试的暂停手段）；校验已由 cloud-drive `updatePreferences` 负责并有测试。
- 测试：`tests/client-remote-face.spec.ts`、`web.spec.ts` 重写两例、`cloud-drive-source.spec.ts` 下载目录用例；`npm run check` 退出码 0，1204 passed / 8 skipped。

## P5 已完成及证据

- 本地插件来源独立为插件行 `reference-local-plugin`（`dsh-reference-anything/local-plugin`），4 个来源与插件行一一对应：`reference-local-agent`、`reference-web-chat`、`reference-cloud-drive`、`reference-local-plugin`。
- 来源设置新增 `prepare` 钩子（保存前校验）；云盘下载目录校验移入其定义。核心新增通用 `updateSettings(id, value)`。
- 核心 Remote 新增 `sources()`；客户端记录已加载来源。未加载来源的 @ 分组与设置分区（本地插件、本地 Agent、云盘、网页对话）不显示。
- 通用设置中这 4 个分组的开关调用 `remote.pluginManager.setPluginEnabled(行 id)`：关 = 卸载该来源（模型也不可用），开 = 加载并显示。插件管理器不可用时退回为仅菜单显示开关。
- 客户端服务 `referenceSources`（`src/client/source-registry.ts`）：第三方插件注册 @ 分组（`id/label/hostSource/order/aliases/create`）。其排序、条数、快捷词存于 `picker.groups[id]`，通用设置列表中与内置分组同列显示、可拖动排序。
- 修复图标标记冲突：本地 Agent ChatGPT 改为 ``（原 `` 与 `goal` 相同）。
- 测试：`tests/client-source-registry.spec.ts`（注册表、加载判断、行 id 存在、图标唯一、本地插件插件卸载）；`npm run check` 退出码 0，1209 passed / 8 skipped。
- 风险：插件行 id 是否即 `setPluginEnabled` 接受的 entry id 尚未在真实宿主核实；需真实 UI 验收。

## P5 真实 Web 验收（2026-11-10，agent-browser-test，端口 3081）

- 方法：测试 profile 的 `node_modules/dsh-reference-anything` 联接临时指向本 worktree，结束后恢复原目标（`.t3/worktrees/.../codex-issue-14-remote-boot`）；profile 的 `cordis.patch.yml` 先备份、结束后原样恢复。Desktop 未触碰。
- 环境事实：web-chat 因测试存储中已有 `qwen` 提供商记录（其他分支写入）无法启动，属 LESSONS 2026-10-29 记录的跨分支存储污染；未修改该数据。这正好构成"一个来源失效"的真实场景。
- 首轮发现并修复：
  1. 4 个 Remote 共用 Typert 包名，客户端与宿主都拒绝重复注册（"Remote package already registered"），且 `Promise.all` 让一个失败拖垮全部。改为每个 Remote 独立包名（`REMOTE_PACKAGES`）+ `Promise.allSettled`，加测试。
  2. 未加载的 web-chat 仍被健康检查/OpenList 刷新调用，设置页报 404。按已加载来源跳过这些调用。
  3. `setPluginEnabled` 需要 Loader `entryId`（`include:reference-local-plugin`），不是补丁行 id；改为先 `listPlugins()` 按 `patchId` 查找。返回 `ok:true` 但 `application:'failed'` 时之前被当成功；现按 `changed` 判断，另一行的重载失败不再误报。
- 结果 PASS：
  - `sources()` = `file, local-plugin, local-agent, cloud-drive, menu`（无 web-chat）。
  - @ 菜单：命令、技能、文件与文件夹、对话、本地 Agent 对话、网盘文件、本地插件；无"网页端 AI 对话"；本地 Agent 与网盘有实际候选。
  - 设置页：无错误横幅；"网页端 AI 对话"开关为关、其设置分区隐藏，其余分区显示。
  - 关闭"本地插件"开关：profile 补丁写入 `reference-local-plugin disabled`，`sources()` 不再含 local-plugin，@ 菜单无该分组，设置分区隐藏。再打开：补丁移除，`sources()` 恢复，开关与分区恢复（宿主重载约 8–10 秒）。
- 未测：第三方 `referenceSources` 分组的真实注册（仅单元测试）；Desktop；模型端真实读取（发版规程 4.5）。

## P6 已完成及证据

- 新子路径 `dsh-reference-anything/sdk`（`src/sdk.ts`）：来源、设置、分组类型，以及浏览器安全的 `formatReferenceMention`、`scopedGroupQuery`、`encodeReferenceUri`；不引入 Node 依赖。
- 示例插件 `examples/reference-source-notes/`：宿主来源 + 来源设置 + 自有 Remote（独立 Typert 包名）+ `@` 菜单分组，只用 SDK 公开接口。
- 测试 `tests/example-source.spec.ts`：模型经 `external_reference_list/read` 读到示例条目；设置存于核心，卸载后来源与设置一并移除；分组遵守 `alias:` 作用域，插入文本可被核心解析。
- 文档 `docs/development/third-party-source.md`；AGENTS.md 与子系统地图已加入口。
- `npm run check` 退出码 0，1213 passed / 8 skipped。
- 未做：示例未在真实宿主中安装运行；README 中英文未改（发布素材须用户审稿）。

## 未完成 / NOT_RUN

- 全部阶段的真实 UI 验收（agent-browser-test、Desktop）：NOT_RUN。P4 改了客户端 Remote 挂载，P5 还会再改客户端，计划在 P5 后一并真实验收（含逐个关闭来源插件后设置面板仍可用）。

## 来源开关过渡（2026-11-11）

- 问题：插件行开关需宿主重载（约 4–10 秒），之前开关不动、完成后才跳变，期间无反馈。
- 现状：点击后开关立即移到目标位置并禁用，滑块内转圈，行说明改为"正在启用…/正在停用…"；关闭时对应设置分区变暗保留至卸载完成；分区出现时淡入。
- 坑：滑块打开态由 `transform: translateX` 定位，直接对滑块做旋转动画会让它绕原点公转。改为在 `::after` 内画转圈环；`client-styles.spec.ts` 有用例防回归。
- 测试：`client-manage.spec.tsx` 待定态用例；Web（3081）实测本地插件开/关时序与滑块位置不动。
- 转圈环第二版：边框画法在 1.5 倍缩放下边宽取整为 1.33px，两色边的端点是斜切的，看起来不圆；渐变遮罩在 10px 尺寸下栅格过粗，同样变方。改为 SVG 遮罩（浅色整圈 + 圆头弧线），任意缩放都是正圆。
- 设置分区顺序跟随 @ 分组的用户排序（`inGroupOrder`）；删除原 CSS 固定 `order`（网页对话 1 / Agent 2 / 网盘 3）。测试：`client-manage.spec.tsx` 分区顺序用例；3081 实测顺序与 @ 列表一致。`npm run check` 1216 passed / 8 skipped。

## 插件行精简（2026-11-11）

用户决定：插件行只保留用户该看到的部分。

| 原行 | 处理 |
| --- | --- |
| `reference-chat-import-runtime` | 删除（空插件，仅为旧 profile 保留） |
| `reference-file` | 删除（只供模型、无菜单入口、默认不生效） |
| `reference-mention` | 改名 `reference-prestep`（导出 `dsh-reference-anything/prestep`），仍独立一行 |
| `reference-openlist` | 并入网盘：网盘插件自己启动 OpenList，关网盘即停 OpenList 进程 |
| `reference-anything-web` | 并入核心：`references` 在有 Typert 时挂载核心 Remote、菜单设置与启动更新检查 |
| `reference-tool` | 不变 |

- 本地插件列表接口从核心 Remote 移到本地插件来源自己的 Remote（`referenceAnythingLocalPlugin`），关闭本地插件时接口随之消失。
- 结果：7 行——核心、prestep、tool、本地 Agent、网页对话、网盘、本地插件；四个来源行对应设置开关。
- 兼容：被删/改名行的 profile 覆盖配置需改到新行（如 `reference-mention.maxReferences` → `reference-prestep.maxReferences`）；本机 profile 无此类覆盖。
- 测试：`cloud-drive-openlist-lifecycle.spec.ts`（OpenList 随网盘启停、宿主自带管理器时不重复启动）；`web.spec.ts` 改为核心挂载 Remote、无 Typert 时不挂载。

### 发布说明草稿：插件行变化（待发版时并入 Release 正文，须用户审稿）

版本号未定。下面两段分别放入中文"其他变更"和英文 "Chores"。

```markdown
- 插件详情页的组件从 11 个精简为 7 个，四个来源（本地 Agent、网页 AI 对话、网盘、本地插件）各对应设置中的一个开关。OpenList 现在随网盘一起开关：关闭网盘时，插件启动的 OpenList 进程也会停止。只通过设置页使用插件的用户无需任何操作。
- **仅当你在 profile 的 `cordis.patch.yml` 中手动覆盖过以下组件的配置时**，需要按下表调整，否则覆盖不再生效、该组件回到默认值：

  | 原组件 id | 现在 |
  | --- | --- |
  | `reference-mention` | 改名为 `reference-prestep`，配置项不变（如 `maxReferences`、`maxTextBytes`） |
  | `reference-openlist` | 已并入 `reference-cloud-drive`，无单独配置 |
  | `reference-anything-web` | 已并入核心 `references`，无单独配置 |
  | `reference-file` | 已移除（读取 `references/` 目录下导出对话的来源） |
  | `reference-chat-import-runtime` | 已移除（空组件） |
```

```markdown
- The plugin's component list shrinks from 11 entries to 7, and each of the four sources (local Agents, web AI chats, cloud drives, local plugins) maps to one switch in Settings. OpenList now follows the cloud-drive switch: turning cloud drives off also stops the OpenList process the plugin started. If you only use the Settings page, nothing needs to change.
- **Only if you hand-edited the config of these components in your profile's `cordis.patch.yml`**, move the override as below; otherwise it no longer applies and the component falls back to its defaults:

  | Old component id | Now |
  | --- | --- |
  | `reference-mention` | Renamed to `reference-prestep`; same keys (e.g. `maxReferences`, `maxTextBytes`) |
  | `reference-openlist` | Merged into `reference-cloud-drive`; no config of its own |
  | `reference-anything-web` | Merged into the core `references`; no config of its own |
  | `reference-file` | Removed (the source that read exported conversations from a `references/` folder) |
  | `reference-chat-import-runtime` | Removed (it did nothing) |
```

未核实：宿主遇到指向已不存在组件的覆盖时，是静默忽略还是在日志里报错。发版前在临时 profile 里加一条 `reference-mention` 覆盖实测一次，按结果补充说明。
