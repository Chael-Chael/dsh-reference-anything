# Agent 开发流程

先读根 AGENTS.md，再按任务读取相关子系统和源码。代码规则见 [standards.md](standards.md)，环境只在 [environments.md](environments.md) 维护。

## 日常开发

1. 运行 agent:context，确认用户目标、工作区改动与目标环境；列出受影响调用方及验收项。
2. Bug 先复现，再做最小完整修改；回归测试按代码标准执行。
3. 代码交付运行 agent:verify，随后完成受影响的真实 Web 与 Desktop 窗口验收，分别报告。
4. 审最终 diff，交付结果、证据和未测项；提交、推送、合并按已有授权执行。
5. 有可复用教训才更新 LESSONS.md，细节见 [复盘](retrospective.md)。

纯文档整理检查链接、命令和 Git diff，不为此 build 或重启应用。日常开发只验收受影响功能；npm 发布必须按[发版规程](../testing/npm-release-checklist.md)覆盖全部已提供功能。

## 命令

| npm run 命令 | 行为 |
| --- | --- |
| agent:context | 输出 HEAD、工作区、版本和入口，不修改业务代码 |
| agent:verify | diff 检查 → 完整 check（类型、测试、build）→ 双环境刷新 |
| agent:sync | 单独刷新测试 Web 与 Desktop；不代表 UI 通过 |
| agent:release:prepare | 完整检查、刷新、实际打包、再次刷新，生成候选记录 |
| agent:release:gate | 检查候选指纹、验收证据和用户审稿；不发布 |
| agent:retro -- HEAD~5..HEAD | 收集提交与文件变化；省略范围默认最近一天 |

日志与 release.json 在 .codex-tmp/agent-workflow/。登录 URL 从 instances.json 指向的启动日志读取，不写入提交。环境不匹配时先诊断，不接管其他实例。

直接 build/check/pack 后仍需 agent:sync。prepare 已包含检查和打包，不再重复执行同一候选的 verify/check/pack；当前 pack 生命周期会再次 build，因此脚本两次刷新是现有行为。

## 发布

准备[发布素材](release-materials.md) → release:prepare → 全功能及安装升级验收 → 用户审核最终文字 → release:gate → 按已有授权发布同一 tgz。字段、状态与报告要求统一见[发版规程](../testing/npm-release-checklist.md)。

## 文档和记录

- 上传：用户文档、有效契约、开发规则、可复用诊断方法、合成 fixtures，以及脱敏版本摘要。
- 本地：执行流水、详细矩阵、日志/截图、审稿包与临时产物。新任务记录放 .codex-tmp/tasks/<slug>.md；新发布记录放 .codex-tmp/release-check/<version>/。既有被忽略记录保留原路径，避免破坏门禁证据。
- 多阶段任务只写目标/范围、当前结论、证据、未完成与下一步；小任务不建文件。长期结论提炼进对应正式文档。
- 每个版本只有一个公开 summary；本地完整报告维护全部检查项，历史经过链接归档，不复制原文。迁移记录前检查引用，取消跟踪不删除本地文件。
- 源码指纹包括非忽略文件，排除 docs/testing/releases/；另检查 lib。改代码、依赖或其他文档后旧发布候选失效，必须重新 prepare，不能改 PASS 绕过。
