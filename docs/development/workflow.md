# Agent 开发闭环

这套流程参考 [magpie 实践分析](https://x.com/wquguru/status/2109650264601117141)，采用路由式入口、可执行验收与证据化复盘。当前仓库不自动接收任务、不自动夜审，也不替用户授予发布权限；在已授权任务中，Agent 自主执行下面的闭环。证据规则见 [代码与验收标准](standards.md)，环境见 [四环境约定](environments.md)。

## 命令入口

在仓库根目录执行。无需新依赖；跨平台命令使用 Node 标准库，环境刷新限定本机 Windows。

| 命令 | 行为 | 结果 |
| --- | --- | --- |
| `npm run agent:context` | 读取 HEAD、工作区状态、版本、文档和命令入口 | JSON，不修改业务代码 |
| `npm run agent:verify [-- web\|desktop\|all]` | `git diff --check` → 完整 `npm run check` → 刷新环境（默认测试 Web） | 日志放 `.codex-tmp/agent-workflow/verify-*/`，记下通过的候选供发版复用；失败非零退出 |
| `npm run agent:sync [-- web\|desktop\|all]` | 校验链接/端口后刷新环境（默认测试 Web） | `instances.json` 更新所刷新环境的条目；不声称 UI 已验收 |
| `npm run agent:release:prepare` | 同一候选已通过 verify 时直接复用，否则跑 check；用该 build 打包（不重建）；刷新两个环境 | 生成 tgz、指纹和待填写的 `release.json`，不发布 |
| `npm run agent:release:gate` | 检查版本/HEAD/源码/build/包哈希、验收报告条目和文案审核 | 未测、缺报告条目或候选变化均失败，不发布 |
| `npm run agent:retro -- HEAD~5..HEAD` | 汇集指定范围的提交和文件变化 | 本地复盘材料；省略范围默认最近一天 |

直接运行 `npm run build` / `check` 后仍须 `npm run agent:sync`。不在通用 build hook 自动重启，以免依赖安装和 CI 意外影响用户应用。

## 从任务到交付

### 本地与跨平台 CI

本地按开发机器的系统执行 check；无需在同一台 Windows 机器模拟三个系统。
`.github/workflows/test.yml` 在 PR、main 推送及手动触发时分别运行 Windows、Linux、macOS 的锁文件安装、类型检查、Vitest 和构建，Node 24 / pnpm 11.22.0。各任务独立执行，不因另一平台失败而提前取消；详细日志及 JUnit 附件显示跳过项。三平台结果以 CI 对同一 SHA 的运行为准，本地不重复。

CI 不含个人历史语料、外站账号、真实 Electron 窗口或发版安装升级验收。平台限定及权限跳过不能算作跨平台通过。此工作流不发布 npm。

1. **读取**：AGENTS → LESSONS → 子系统文档和相关代码，运行 context。
2. **确定验收**：写结果、边界、调用方和检查项。多阶段任务使用下面的任务模板。
3. **实现**：按 [standards](standards.md) 做回归测试（修 bug 时 red/green）。最小完整改动，不额外加功能。
4. **自动验证**：运行 verify，失败先处理。环境链接不符或端口被他人占用时脚本拒绝继续，不自动修掉别人的环境。
5. **真实验收**：从 `instances.json` 的启动日志找本机登录 URL，用浏览器验证实际交互；截图/日志存任务证据目录。
6. **交付**：审最终 diff，更新需要变化的文档与任务记录，列出未测项。用户已授权提交/PR/合并时继续，否则交付本地变更。
7. **复盘**：有可复用教训才写 LESSONS。

## 发布记录如何填写

一次发版只维护一份验收报告 `docs/testing/releases/<version>-acceptance-report.md`（格式见[发版规程第 8 节](../testing/npm-release-checklist.md#8-记录与发布交接)）。`.codex-tmp/agent-workflow/release.json` 只记状态，并指向报告里的条目编号，不重复写证据：

```json
{
  "checks": {
    "browser": { "status": "PASS", "ref": "B-01" },
    "upgrade": { "status": "N/A", "reason": "设置、存储和引用格式均未变化" }
  },
  "editorialApproval": { "status": "APPROVED", "userMessage": "<用户原话>", "ref": "E-01", "copyDigest": "<prepare 记录的 copyDigest>" }
}
```

- 每次发版必须 PASS：`browser`、`desktop`、`packageContents`、`cleanInstall`、`changeReview`、`readme`、`releaseNotes`、`demos`。
- 按改动适用：`upgrade`（设置/存储/引用格式变化时）、`redGreen`、`breakCheck`、`ci`。可以 PASS，或写明原因的 N/A。
- gate 检查每个 `ref` 都出现在报告中；不判断报告内容是否真实，Agent 不得为了绿灯伪造记录。
- 文案审核绑定 `copyDigest`（两份 README、`docs/release/<version>/`、`images/`），不绑定代码。只改代码后重新 prepare，原审核自动沿用；文字变化则必须重新送审。
- 源码指纹覆盖 Git 跟踪及非忽略的未跟踪文件，另单独检查 `lib/`；`docs/testing/releases/` 的改动不使候选失效。测试后改动代码/依赖则重新 prepare。
- 通过 gate 后，仅在用户已授权发布时发布记录指向的同一份 tgz，明确 dist-tag，核验 registry integrity。直接 `npm publish` 技术上可以绕过 gate，Agent 禁止这么做。

## 多阶段任务模板

保存为 `docs/development/tasks/<slug>.md`，结束后保留结论，避免下个 Agent 重新猜测。

```markdown
# 任务名称
- 用户目标与授权范围：
- 状态：进行中 / 阻塞 / 已完成
- 验收条件：
- 改动边界与相关子系统：
- 用户已有改动及不可覆盖内容：
- 当前候选 HEAD / 未提交内容：
- 已完成及证据：
- 未完成 / NOT_RUN / 阻塞原因：
- 下一步具体动作：
- 最终结论与 LESSONS 链接（如有）：
```

没有自动常驻 agent、定时任务、远程 CI 或分支保护的隐含部署。需要这些能力时按用户授权新增，避免本地脚本对外发布或不断触发重启。

## GitHub Actions 发布

`test.yml` 保持 main push、PR 和手动触发。`release.yml` 仅从 main 手动触发，固定本次触发的 SHA，在 Windows/Linux/macOS 分别执行锁文件安装与完整 `npm run check`。三平台全部通过后，通过 npm-release 环境与 OIDC 发布 Linux 检查后打出的同一 tgz，核验 registry integrity 和 dist-tag（稳定版 latest，预发布 next）。已存在同版本且完整性不同则拒绝，不覆盖版本或自动更改 dist-tag。

发布流程不读取本地验收 JSON、不同步 Desktop、不需要预上传草稿包。人工验收与文案审核仍独立记录。主流程已构建，打包用 --ignore-scripts 避免 prepare 重建；发布 tgz 不重复执行项目的 prepublishOnly。npm Trusted Publisher 必须匹配仓库、release.yml 和 npm-release 环境，本机 npm login 不是前提。手动运行 Release 即执行检查并发布，版本取 package.json；请先提交正确版本与已审核文案。

发布分为 upload → verify → github-release 三个 job。upload 成功表示 npm 已接受上传；verify 立即查询一次，此后每 5 分钟查询，最多 7 次（约 30 分钟，网络请求耗时另计），404/429/5xx/临时网络错误重试，身份或完整性不一致立即失败。超时使用 Actions 的 Re-run failed jobs，只恢复验证，不重跑成功的上传 job；不要选择 Re-run all jobs。旧版把上传和验证合在一个 job 的运行不适用这个重试保证。

npm 版本、完整性与 dist-tag 核验通过后，使用同一提交的 docs/release/<version>/README.md 创建 GitHub Release，并附上同一 artifact 的安装包，命名 dsh-reference-anything-v<version>.tgz。已有 tag 必须指向本次 SHA；稳定版标 latest，预发布标 prerelease。GitHub 步骤失败可单独重跑，不重新发布 npm。artifact 保留 7 天，过期后不能直接恢复失败 job。

### 已上传包的恢复入口

手动运行 **Post npm publish**（post-npm-publish.yml），分支选择 main，run_id 填原 Release 的运行编号（例如 41050564137）。仅接受本仓库 main 上手动触发且已结束的 Release 运行；下载其 npm-candidate，不重建、不上传 npm。使用当前验证工具等待 registry 就绪，成功后从原运行 SHA 读取版本和发布说明、创建 tag/Release 并附上原 tgz。附件名称为 dsh-reference-anything-v<version>.tgz。与正常 Release 共用发布脚本和并发组，防止两个流程并行操作发布。

npm 尚未公开时会等待；超时可重新运行失败 job。原 artifact 过期/缺失、包与源码身份不符或 registry 完整性不符时拒绝发布。该入口不会把 npm 的处理中状态绕过为已发布。

GitHub Release 正文发布前通过 scripts/agent/release-notes.mjs 将 Markdown 图片相对路径转换为原发布 SHA 的 raw.githubusercontent.com 绝对 URL；不改变文案或仓库 README。正常发布与恢复入口共用此转换，避免 Release 页把 demos/*.gif 解析为无效路径。
