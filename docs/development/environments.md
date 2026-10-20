# 四环境约定

环境用途由用户确定，版本、路径和运行状态在操作前复核。开发标准见 standards.md，执行命令见 workflow.md。

Desktop 欢迎页报认证失败时，可查阅 [本地认证 Cookie 累积导致 HTTP 431 的诊断与恢复记录](tasks/desktop-startup-cookie-overflow.md)；先核实实际状态码，不据通用错误直接重装或停用插件。

## 四个环境

用户于 2026-10-17 确认前三个环境，并要求新增第四个。操作前明确目标环境，不混用配置、演示数据或测试结果。

| 环境 | 用途 | 入口与位置 |
| --- | --- | --- |
| 演示动画环境 | 制作演示动画、录屏和 GIF | `scripts/web-demos/start.mjs`；独立目录 `.codex-tmp/web-demos/`；流程见 `scripts/web-demos/README.md` |
| 用户亲自测试环境 | 供用户自己测试 | 现有 Web 启动入口 `docs/testing/Start-DSH-RC1.ps1`（端口 3080）；操作前核对实际 profile，不将它用于 Agent 自动化测试 |
| Desktop 环境 | DSH Desktop 客户端 | 本机 `%USERPROFILE%/.dsh/profiles/desktop`，由 Electron 管理 |
| Agent 浏览器测试环境 | Agent 使用 browser use 做真实 Web UI 自动化测试 | 新增 `agent-browser-test` profile，端口 3081；启动见下文 |

### Agent 浏览器测试环境

- Profile：`C:/Users/27923/.dsh/profiles/agent-browser-test`。
- `dsh-reference-anything` 使用 `link:D:/dsh-reference-anything`，测试当前本地构建产物。
- `dsh-chat-import` 使用 npm 精确版本 `0.26.1`；两个插件都加入 profile 的 bundles。
- `cordis.patch.yml` 必须同时将 `storage-json.config.root` 指向该 profile 的 `storages`，将 `session-persistence-jsonl.config.root` 指向该 profile 的 `sessions`。只改前者不能隔离实际会话。刷新脚本在启动前校验两项；工作区为仓库下 `.codex-tmp/agent-browser-test/workspace`。
- 该环境仍使用真实本机插件和 Agent 数据源，不等于操作系统沙箱。导入测试使用明确的测试样例，不修改用户原始会话。
- 日常启动（仓库根目录 PowerShell）：

  ```powershell
  Push-Location .codex-tmp/agent-browser-test/workspace
  try { dsh --profile agent-browser-test --host 127.0.0.1 --port 3081 --no-open }
  finally { Pop-Location }
  ```

- 使用启动日志中的登录链接；不要把认证链接或密钥写进本文件。启动前确认端口及进程，避免重复启动；只停止本环境的进程。
- 不要日常使用 `--from-default-profile web`：它用于初始化，会重置自定义 profile。

## 演示和测试边界

- 插件更新统一在 `agent-browser-test` 环境中使用 Browser Use 做真实浏览器实验和验收，不使用用户亲自测试环境或 Desktop 进行自动化实验。
- 同一更新也需同步到 Desktop：核对本地链接，构建后完整重启 Desktop 并验证实际界面；浏览器测试结果与 Desktop 同步、验收结果分别报告。
- 后续 GIF 更新复用真实 Web 演示环境，保留旧 HTML 动画与 GIF 备份；遵循演示 README 的 build → prepare → start 流程。
- 演示环境的虚构服务结果不能作为真实导入、同步或升级功能通过的证据。
- 测试“所有 @ 功能”时，覆盖所有已提供类别并验证实际插入。普通菜单检查不发送消息；真实引用端到端验收可按用户 2026-10-18 授权，使用其实际对话/来源和 DeepSeek 官方账号模型额度发送测试，具体步骤见发版规程 4.5。结束清空草稿，原始来源保持只读。
- 构建、进程启动和自动化单测通过，不等于 Desktop 窗口或浏览器端到端验收通过。报告已验证项及未验证项。


## 构建与刷新

2026-10-20 用户要求解除 Desktop 的本地链接，自行安装线上版本；已移除 Desktop 的本地依赖、bundle 加载项和 junction，保留源码与插件设置。后续不得自动恢复 Desktop 本地链接。`agent-browser-test` 继续使用 link:D:/dsh-reference-anything；本地 build 不再更新 Desktop 的插件版本。Desktop profile 由 Electron 管理，不使用 dsh plugin --profile desktop 安装或刷新。

刷新脚本会先尝试关闭 Desktop 窗口，再结束仍存活的同一可执行文件的托盘进程。不要在进行中的用户任务期间强行刷新，应先确认运行状态并说明阻塞。它不会修改 profile 或关闭其他 Web 实例。
