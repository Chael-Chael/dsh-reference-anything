# Agent 开发流程自身验证（不是产品发版验收）

日期：2026-10-18，Asia/Shanghai。未发布 npm，未提交/推送代码，未设置定时任务。

## 已完成

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| context 命令 | PASS，输出实际 HEAD、版本、工作区和命令入口 | `node scripts/agent/workflow.mjs context` |
| 规则入口链接 | PASS，根入口与 development/subsystems 的本地 Markdown 链接可达 | 本次逐链接文件存在检查 |
| 放行器单测 | PASS，4 项；覆盖候选变更、缺证据、未测、条件项理由与内容指纹 | `tests/agent-workflow.spec.mjs` |
| 完整 check | PASS，55 文件通过、2 文件跳过；1020 测试通过、8 跳过；typecheck/build 成功 | `.codex-tmp/agent-workflow/release-1792253191207/check.log` |
| 双环境刷新 | PASS，仅进程/服务级结果；两个本地链接已核对 | 同目录 `sync.log`、`sync-after-pack.log` |
| release:prepare | PASS，生成实际 tgz、检查日志和候选指纹，未发布 | 同目录 `pack.log`、`release.json` |
| release:gate 拒绝未测 | PASS，退出 1，提示 `browser: PASS with summary and evidence required` | 主记录 `.codex-tmp/agent-workflow/release.json` 手工项仍是 NOT_RUN |
| retro 材料收集 | PASS，读取指定提交范围，未自动改账本 | `.codex-tmp/agent-workflow/retro-1792252544545.txt` |
| Web 启动冒烟 | PASS，使用本次登录 URL 打开真实页面，完成插件加载并显示新会话输入页 | Browser Use 本次观察；不等于来源功能回归 |

## 已修复的流程问题

- 未登录的 Web 根路径返回 401，视为服务可达而不是界面验收成功。
- 后台 Electron 进程可能持有输出管道，导致同步命令不退出；改为文件描述符输出后实际运行返回 0，见 LESSONS L-001。

## 未执行和限制

- 未做本次产品的完整 Browser Use 来源回归、Desktop 实际窗口验收、tgz 干净安装或旧版升级，不把流程验证当成产品可发布。
- 既有 8 个跳过测试尚未作为发版候选逐项审核；依赖包 sourcemap 缺失和 localstorage 参数警告保留在日志中。
- 未部署远程 CI/分支保护/定时夜审，未创建自动发布权限。gate 验证记录一致性和文件存在，不能鉴别人工证据真实性；直接 npm publish 仍能绕过，Agent 流程禁止绕过。
- `.codex-tmp` 中证据为本机临时产物，清理后需重跑，不能声称可从此仓库文件单独重现旧结果。

结论：本次新增的开发流程已实跑，产品发布仍被未完成的验收项阻塞。

## 最终复测补充

- 发现并补齐 session-persistence-jsonl 独立根目录；刷新脚本现在在停止进程前检查两个存储根目录。
- SQLite 测试遇到一次临时目录清理 ENOTEMPTY；沿用 openlist 测试的有限重试参数，相关 33 项测试及随后完整 check 均通过，未删减断言。原始失败记录保留在 .codex-tmp/agent-workflow/release-1792253113416/check.log。
- 对旧记录执行 gate，实际得到 Candidate changed 拒绝；最终重新 prepare 成功，新记录因 browser 未测退出 1，符合预期。

