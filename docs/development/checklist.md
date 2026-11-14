# 任务跟踪清单

用户与 Agent 共用的待改 / 待测总表。每项只写一句话 + 链接，细节留在对应任务记录。
完成后勾选并注明日期与证据位置；新任务开工时先在这里加一行。`[ ]` 未做，`[~]` 进行中，`[x]` 完成，`[!]` 阻塞。

最后整理：2026-11-13（基于 e066afa + 未提交工作区）

## 0. 用户近期重点（2026-11-13 定）

目标版本：**0.6.0 为上限**，下列 1/3/4/5 进入 0.6.0，抓紧测试；网盘自主性推迟到 0.6.0 之后。

1. [~] **网页 AI 引用 Token 化** → 见下方「网页 AI Token 优先」
2. [ ] **（0.6.0 后）网盘自主性功能提升**：范围待定（例：模型自主浏览/搜索/下载网盘内容）。开工前写任务记录并与用户确认范围
3. [ ] **测试用户自定义插件可行性**：在真实宿主装载第三方 `referenceSources` 示例，走通注册 → @ 菜单 → 模型读取 → 关闭后不可读 → 见下方「来源插件化」及[接入文档](third-party-source.md)
4. [~] **优化 tools 格式和结构** → 见下方「统一引用工具与附件读取」
5. [~] **适配新版 OpenCLI 与 Chat Import**：bundled reader 0.26.6、新增 CodeBuddy / CodeArts / openCoWork 来源、OpenCLI 2.0.3 与最低版本已更新；typecheck + vitest 通过；真实数据与宿主菜单验收 NOT_RUN → [任务](tasks/chat-import-0266-opencli-203.md)

6. [ ] **评估子插件作为独立 npm 子包发布**（2026-11-13 提出）：目标是各来源插件可单独更新。需核实：DSH 宿主能否独立安装/更新同一包族的多个插件、对核心 `references` 的版本依赖与兼容声明、设置迁移与自更新是否按插件分别处理、发版流程改为多包。注意：2026-11-10 曾选定单包方案（[来源插件化](tasks/plugin-split.md)），本项是重新评估，先出结论再决定是否进 0.6.0

## 1. 进行中的开发

- [~] **单一 `reference` 工具**（list/search/read 三动作，取代 `reference_*` 四工具；2026-11-14 用户说开始）：代码已实施，`tsc --noEmit` 与全量 vitest 通过（2026-11-14，见[方案第 11 节](../ideas/reference-single-tool.md)）；未提交
  - [ ] build + `agent:sync -- all` 后在真实 Web 跑：总结最近结论、找中段决定、看图片、读文件附件
  - [ ] Desktop 同样四项
  - [ ] README 模型侧协议段落（中英）已按单工具改写，待用户审稿

- [~] **统一引用工具与附件读取**：只保留 `reference_list/read/search/attachment`，删除旧四个工具；云盘与第三方来源迁 ref + revision。→ [任务](tasks/reference-attachment-unify.md)
  - [ ] 实现完成 → `agent:verify`（2026-11-13 FAIL：typecheck 5 处，`tests/local-agent-source.spec.ts` 用已删的 `resolveReadReference`，`tests/tool.spec.ts` 用已删的 Config 字段 `listLimit/maxOutputBytes/readTurns`；日志 `.codex-tmp/check-20261113.log`）
  - [ ] `agent:verify` 脚本自身报 `EISDIR` 未跑检查，需修
  - [ ] Web 验收（agent-browser-test）
  - [ ] 50 MiB 附件经 OpenCLI 浏览器通道实测
  - [ ] 关闭来源 / 账号切换 / revision 变化后读取失败并给原因
- [~] **网页 AI Token 优先**（DeepSeek / Kimi 凭据、新 provider）：自动检查与 3082 设置页 PASS。→ [任务](tasks/web-chat-token.md)、[方案](../ideas/web-chat-token-first.md)
  - [ ] 方案剩余部分待用户拍板
  - [ ] 标准环境刷新（3081 绑定主目录导致 BLOCKED）
  - [ ] Desktop 实测
- [~] **来源插件化**：P1–P6 代码完成。→ [任务](tasks/plugin-split.md)
  - [ ] P4 每来源 Remote 的真实 UI 验收
  - [ ] 第三方 `referenceSources` 在真实宿主装载示例
  - [ ] Desktop 验收
  - [ ] 模型端真实读取（发版规程 4.5）
  - [ ] 插件行变化写入 Release 正文（用户审稿）

## 2. 待用户决定（未授权实施）

- [ ] 引用协议重设计 → [方案](../ideas/reference-protocol-redesign.md)
- [ ] 网页 AI 引用改进 → [方案](../ideas/web-chat-reference.md)
- [ ] 功能卡媒体迁移到 DSH 官方资源通道（等 DSH 0.2.2 正式版）→ [Ideas](../ideas/README.md)

## 3. 遗留未测 / 失败项

- [!] 本地引用多引用端到端回答：BLOCKED（主动中断）；文件缺失原因归因不准 FAIL → [任务](tasks/local-reference-protocol.md)
- [ ] Antigravity 工具结果占位符替代真实内容的回归复测 → [任务](tasks/local-reference-preview.md)
- [ ] Chat Import API 异常提醒 UI：插件停用 `Failed to fetch` BLOCKED → [任务](tasks/chat-import-api-notice.md)
- [ ] 官方引用折叠：Desktop、原生拖放、关闭态模型读取未测 → [任务](tasks/issue-13-reference-ownership.md)
- [ ] 29 种来源扫描目录覆盖 ≠ 实机验收，需逐来源真实问答 → [0.5.0 清单](tasks/version-0.5.0.md)
- [ ] 全来源真实问答、确认导入写入、非默认设置升级保留、官方插件页在线更新 → [0.5.2 报告](../testing/releases/0.5.2-acceptance-report.md)
- [ ] 标准 `agent:sync` 因日常 Desktop 链接不符 BLOCKED → [环境约定](environments.md)

## 4. 下一版发布前

- [ ] 新版本验收报告（开头列 FAIL 与未测项）→ [发版规程](../testing/npm-release-checklist.md)
- [ ] 完整标准门禁 `agent:release:prepare` / `agent:release:gate`
- [ ] 干净安装 + 从上一正式版升级
- [ ] README / Release 正文 / GIF 初稿，交用户审稿 → [发布素材](release-materials.md)
- [ ] npm 认证恢复（上次 `npm whoami` E401）
- [ ] 宣传片 v2 分镜与 v1 成片文案待用户审阅 → [任务](tasks/intro-film.md)

## 5. 杂项

- [ ] 清理旧 session zip 与 `.codex-tmp/local-protocol-web/` 解压目录（清单见[任务](tasks/local-reference-protocol.md)，删除前确认）
