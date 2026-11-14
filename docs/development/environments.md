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
- `dsh-chat-import` 使用 npm 精确版本 `0.26.6`；两个插件都加入 profile 的 bundles。
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

- 自动化浏览器实验和验收只在 `agent-browser-test` 做，不用用户亲测环境或 Desktop。
- GIF 更新复用真实 Web 演示环境，保留旧 HTML 动画与 GIF 备份；遵循演示 README 的 build → prepare → start 流程。
- 普通菜单检查不发送消息。真实引用端到端验收按[发版规程 4.4](../testing/npm-release-checklist.md#44-真实来源--官方账号模型--回答核验)发送；结束清空草稿，原始来源保持只读。

### Desktop 同步本地构建

用户于 2026-11-12 决定：Desktop profile 的 `dsh-reference-anything` 也改为 `link:D:/dsh-reference-anything`（原为 npm `^0.5.2`，备份在 profile 的 `backups/`），并在每次修改构建后同步接入，即 build 后执行 `npm run agent:sync -- all`。同步会重启 Desktop；完整窗口验收仍按下节条件执行。

### Desktop 何时验收

用户于 2026-11-11 决定：日常开发只刷新、验收测试 Web；Desktop 只在以下情况完整重启并做窗口验收：

- npm 发版；
- 改动涉及 Desktop 专属行为（Electron 窗口、原生文件打开/选择、Desktop 启动或认证）。

## 构建与刷新

两个 profile 均保持 `link:D:/dsh-reference-anything`，共用 `lib/`。build 后：

| 命令 | 刷新 |
| --- | --- |
| `npm run agent:sync`（默认） | 测试 Web |
| `npm run agent:sync -- desktop` | Desktop |
| `npm run agent:sync -- all` | 两者（发版准备自动执行） |

`agent:verify` 接受同样的参数。仅文档修改无需构建或重启。Desktop profile 由 Electron 管理，不使用 `dsh plugin --profile desktop` 安装或刷新。

刷新 Desktop 时脚本先关闭窗口，再结束同一可执行文件残留的托盘进程，所以不要在用户正使用 Desktop 时刷新。脚本不修改 profile，也不关闭其他 Web 实例。
