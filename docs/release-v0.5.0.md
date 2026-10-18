[中文](#cn-050) | [English](#en-050)

> 审稿草案：0.5.0 尚未发布，完整功能验收仍在进行。本稿不代表发布放行。

本版本汇总自 `v0.4.4` 以来的变更，重点改进本地 Agent 历史对话的引用、读取与继续工作流程。

<h3 id="cn-050">新增功能</h3>

- 本地会话扫描与只读引用不再依赖 Chat Import。内置扫描/解析目录覆盖 29 种来源格式；Chat Import 继续负责导入、导入状态和交接摘要。
- 在 `@` 菜单中按 Enter 引用会话，按 Tab 打开导入操作；确认后将完整历史导入 DSH。Claude Code 和 Codex 可生成实验性交接摘要。
- 发送本地引用时自动提供正文预览。模型可以按消息编号补读正文或工具记录、搜索正文，并读取可恢复的原生图片；图片理解需要支持视觉的模型。
- 同一消息中的多条本地引用共享剩余上下文预算。发送时重新计算，考虑已有上下文和输出预留；容量不足时保留定位信息，延后正文读取。
- 完整来源定位信息支持重启后续读及跨会话复制；来源变化时要求刷新，避免把过期编号用于新内容。

### 体验优化

- 后台隐藏已确认没有正文的本地会话，保留读取异常、未知结构和超出检查预算的条目；来源文件变化后重新检查。
- 本地扫描在独立子进程中运行，提供短期缓存与来源警告。完善来源图标、筛选、菜单高亮、异步候选和文件夹下钻体验。
- 显示 Chat Import API 状态及可用的升级入口；网页对话菜单显示连接就绪状态，帮助定位浏览器扩展及 Profile 问题。
- 设置页可查看当前版本说明和功能演示。

### 问题修复

- 保留 Codex 附件包装中的用户正文和图片消息，以及 Codex/Claude 的压缩检查点。
- 修正 Antigravity 类型化工具结果与异步结果关联，避免用缺失占位或不相关结果替代真实输出。
- 改进有界本地工具结果的宿主渲染，避免二次截断破坏 JSON；保留宿主的拒绝和替换策略。
- 加强来源根目录、真实路径、会话身份、授权和来源版本检查。

### 其他变更

- OpenCLI 随插件安装固定版本 `2.0.0`，适配管理命令的 JSON 输出；网页适配器更新为 `0.2.3`。
- **迁移提示：旧格式本地会话引用需要重新从菜单选择。** 路径与当前机器关联，删除原始记录后不能回读。其他来源的引用协议保持原有行为。
- 扫描目录覆盖不代表所有来源均已完成真实账号验收。大记录解析仍可能消耗较多内存；上下文预算是保守估计，不是绝对容量保证。
- 增加四环境开发约定、真实来源测试、官方日志诊断、包安装验证与发布审稿流程。

<h3 id="en-050">New Features</h3>

This version covers changes since `v0.4.4`, focusing on referencing and continuing local Agent conversations.

- Local scanning and read-only references no longer require Chat Import. Bundled scanners/parsers cover 29 source formats. Chat Import still supplies imports, import status and handoff summaries.
- Press Enter to reference a conversation or Tab to open import actions, then confirm to import its history into DSH. Experimental handoff summaries are available for Claude Code and Codex.
- Local references provide automatic body previews. Models can read numbered body messages or tool records, search body text and retrieve recoverable native images. Image understanding requires a vision-capable model.
- Multiple local references in one message share the remaining context budget, recalculated for each send with existing context and output reserves. When capacity is insufficient, locators remain available and body reads are deferred.
- Complete source locators support reading after a restart and copying between conversations. Changed sources require a refresh before reusing message positions.

### Improvements

- Background checks hide confirmed empty local conversations while retaining read errors, unknown structures and over-budget records. Source changes invalidate the check.
- Local scanning runs in a separate process with a short-lived cache and source warnings. Source icons, filtering, menu highlights, asynchronous results and folder navigation have been refined.
- Chat Import API status and available upgrade actions are visible. Web conversation menus show connection readiness and help identify extension or browser Profile issues.
- Settings can display current-version notes and feature demonstrations.

### Bug Fixes

- Preserve user text and images inside Codex attachment wrappers, plus Codex/Claude compaction checkpoints.
- Correct typed and asynchronous Antigravity tool-result associations, avoiding missing-result placeholders or unrelated replacements.
- Preserve complete JSON in bounded local tool results through the host rendering contract, while respecting host denial and replacement policies.
- Strengthen source-root, canonical-path, session-identity, authorization and revision checks.

### Chores

- Bundle OpenCLI `2.0.0` as a dependency, support its JSON management output and update the web adapter to `0.2.3`.
- **Migration: reselect local conversation references created with the old protocol.** Paths are machine-specific, and deleted source records cannot be reread. Other source protocols keep their existing behavior.
- Catalog coverage does not mean every source has passed live-account acceptance. Large records may still require substantial memory; the context budget is a conservative estimate, not a hard capacity guarantee.
- Add four-environment workflows, real-source tests, official-log diagnosis, package-install checks and editorial review before release.

Full Changelog: [v0.4.4…77e913e](https://github.com/Chael-Chael/dsh-reference-anything/compare/v0.4.4...77e913eddf5769178000bac6d5619e192ebbb11d). 此链接固定到开发基线；最终发布标签尚未创建，发布前应更新到审核通过的最终提交。 This link is pinned to the development baseline; update it to the approved final commit before publication.
