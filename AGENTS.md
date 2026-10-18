# Agent 工作入口

先读本文件与 [LESSONS.md](LESSONS.md)，再按任务读取对应文档，不一次性加载整个仓库。

| 当前任务 | 必读入口 |
| --- | --- |
| 开始/继续开发 | [开发闭环与命令](docs/development/workflow.md)、[代码与验收标准](docs/development/standards.md) |
| 定位改动、找调用方和测试 | [子系统地图](docs/subsystems/README.md) |
| 规划网页 AI 引用改进 | [未来方案：网页 AI 引用](docs/ideas/web-chat-reference.md)（待实施；阅读不代表授权开发） |
| 启动、build、浏览器测试、Desktop 同步 | [四环境约定](docs/development/environments.md) |
| 修改 UI | [设计规范](design.md)、[浏览器验收](docs/testing/npm-release-checklist.md) |
| 功能测试失败 | [官方 Session Log 诊断](docs/testing/session-log-diagnosis.md)：导出失败会话、分析事件链、修复并保留复测证据 |
| npm 发布 | [发版规程](docs/testing/npm-release-checklist.md)，使用 agent:release:prepare / agent:release:gate |
| README、发布说明、新功能 GIF | [发布素材与用户审稿](docs/development/release-materials.md)、[Release 正文模板](docs/development/release-notes-template.md)；Agent 完成初稿和录制，最终文字必须交用户审核 |
| 任务完成、返工或复盘 | [复盘与经验晋升](docs/development/retrospective.md) |
| 制作 GIF | [演示流程](scripts/web-demos/README.md) |

## 不变量

- 用户明确的产品决定和环境分工优先；不混用演示、用户亲测、Desktop 和 Agent 测试环境。
- 保留已有未提交改动。修 bug 先复现，遍查共享实现的调用方，再修根因；只改任务必要范围。
- 本地 @ 引用只读；导入必须单独确认。用户于 2026-10-18 授权在 agent-browser-test 中引用其实际对话/来源并使用其 DeepSeek 官方账号模型额度发送验收消息；按发版规程执行真实读取与回答核验，其他普通菜单测试仍不发送，结束清空草稿。
- 每次 build 同步刷新 agent-browser-test 和 Desktop；自动化 UI 实验放在前者，Desktop 做实际窗口验收。
- 没跑的写 NOT_RUN / BLOCKED，不伪造证据；构建成功不能代替真实 UI 或 npm 包验收。
- 每次发版逐项验证所有已提供功能，不轮换抽样。失败先查官方 Session Log（无会话时查宿主/浏览器日志），根因修复并真实复测后才可标 PASS。
- 官方日志 ZIP 及解压副本用完即清理：先保留脱敏诊断/复测报告，再删除本次临时副本并核实；不删除 DSH 原始会话或待发布 npm 包。
- 长期项目信息写入对应仓库文档并保持此入口可达，不只存个人记忆。稳定规则不复制多份，复盘教训进入 LESSONS.md。
- 发布、推送、合并按用户实际授权执行；实现本流程不代表授权发布 npm 或创建定时任务。
- 发布前由 Agent 主动更新中英文 README、发布说明/功能卡并制作适用的新功能 GIF；汇总最终文字及演示预览交用户明确审核，不得自行代审。审核后的文字或候选内容改变则重新交审。
