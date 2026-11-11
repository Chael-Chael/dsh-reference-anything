# Agent 工作入口

先读本文件与 [LESSONS.md](LESSONS.md)，再按任务读取对应文档，不一次性加载整个仓库。

| 当前任务 | 必读入口 |
| --- | --- |
| 开始/继续开发 | [开发闭环与命令](docs/development/workflow.md)、[代码与验收标准](docs/development/standards.md) |
| 定位改动、找调用方和测试 | [子系统地图](docs/subsystems/README.md) |
| 设计引用返回协议、精简本地 Agent 输出 | [引用协议重设计](docs/ideas/reference-protocol-redesign.md)（协议契约与实施入口） |
| 规划网页 AI 引用改进 | [未来方案：网页 AI 引用](docs/ideas/web-chat-reference.md)（待实施；阅读不代表授权开发） |
| 接入或修改引用来源（含第三方） | [接入第三方引用来源](docs/development/third-party-source.md)、[来源插件化任务](docs/development/tasks/plugin-split.md) |
| 查看后续方案与待办 | [Ideas 清单](docs/ideas/README.md) |
| 启动、build、浏览器测试、Desktop 同步 | [四环境约定](docs/development/environments.md) |
| 修改 UI | [设计规范](design.md)、[浏览器验收](docs/testing/npm-release-checklist.md) |
| 功能测试失败 | [官方 Session Log 诊断](docs/testing/session-log-diagnosis.md)：导出失败会话、分析事件链、修复并保留复测证据 |
| npm 发布 | [发版规程](docs/testing/npm-release-checklist.md)，使用 agent:release:prepare / agent:release:gate |
| 输出/更新验收报告 | [验收报告格式](docs/testing/npm-release-checklist.md#8-记录与发布交接)：每个版本一份，开头列当前 FAIL 与未测项 |
| README、发布说明、新功能 GIF | [发布素材与用户审稿](docs/development/release-materials.md)、[Release 正文模板](docs/development/release-notes-template.md)；Agent 完成初稿和录制，最终文字必须交用户审核 |
| 任务完成、返工或复盘 | [复盘与经验晋升](docs/development/retrospective.md) |
| 制作 GIF | [演示流程](scripts/web-demos/README.md) |

## 不变量

每条规则只在一处写全，这里只放产品决定和入口；细则见链接。

- 用户明确的产品决定和[环境分工](docs/development/environments.md)优先。保留已有未提交改动；只改任务必要范围。
- 本地 @ 引用只读，导入必须单独确认。每次读取都检查当前来源开关与允许目录，关闭来源后旧引用也不可新读取；不放宽 DSH 沙箱。
- 测试证据规则（状态词、不伪造、构建 ≠ 验收、失败查 Session Log）见[代码与验收标准](docs/development/standards.md)。
- 发布、推送、合并按用户实际授权执行；发版前的 README、发布说明、GIF 由 Agent 准备，最终文字交用户审核（[发布素材](docs/development/release-materials.md)）。
- 长期项目信息写进仓库文档并保持此入口可达；复盘教训进入 LESSONS.md。
