# Agent 开发闭环

这套流程参考 [magpie 实践分析](https://x.com/wquguru/status/2109650264601117141)，采用路由式入口、可执行验收与证据化复盘。当前仓库不自动接收任务、不自动夜审，也不替用户授予发布权限；在已授权任务中，Agent 自主执行下面的闭环。

## 命令入口

在仓库根目录执行。无需新依赖；跨平台命令使用 Node 标准库，双环境刷新限定本机 Windows。

| 命令 | 行为 | 结果 |
| --- | --- | --- |
| `npm run agent:context` | 读取 HEAD、工作区状态、版本、文档和命令入口 | JSON，不修改业务代码 |
| `npm run agent:verify` | `git diff --check` → 完整 `npm run check` → 两环境进程刷新 | 日志放 `.codex-tmp/agent-workflow/verify-*/`，失败非零退出 |
| `npm run agent:sync` | 校验两端链接/端口后刷新测试 Web 和 Desktop | `instances.json` 指向新日志；不声称 UI 已验收 |
| `npm run agent:release:prepare` | 完整检查、刷新、实际 npm pack、再次刷新 | 生成 tgz、内容指纹和待填写 `release.json`，不发布 |
| `npm run agent:release:gate` | 检查版本/HEAD/源码/build/包哈希，以及手工验收和证据文件 | 未测、缺证据或候选变化均失败，不发布 |
| `npm run agent:retro -- HEAD~5..HEAD` | 汇集指定范围的提交和文件变化 | 本地复盘材料；省略范围默认最近一天 |

直接运行 `npm run build` / `check` / `npm pack` 仍须随后 `npm run agent:sync`。不在通用 build hook 自动重启桌面，以免依赖安装和 CI 意外影响用户应用。

## 从任务到交付

### 本地与跨平台 CI

本地按开发机器的系统执行 check；无需在同一台 Windows 机器模拟三个系统。
`.github/workflows/test.yml` 在 PR、main 推送及手动触发时分别运行 Windows、Linux、macOS 的锁文件安装、类型检查、Vitest 和构建，Node 24 / pnpm 11.22.0。各任务独立执行，不因另一平台失败而提前取消；详细日志及 JUnit 附件显示跳过项。

CI 不含个人历史语料、外站账号、真实 Electron 窗口或发版安装升级验收。真实语料和 Desktop CLI 测试仍须在具备数据/程序的本机显式启用。平台限定及权限跳过不能算作跨平台通过；发布时核对本次提交的三项任务结果。此工作流不发布 npm。

1. **读取**：AGENTS → LESSONS → 子系统文档和相关代码。运行 context，识别用户改动与环境。
2. **确定验收**：写结果、边界、调用方和检查项。多阶段任务使用下面任务模板，小任务不强行建文件。
3. **复现/实现**：按 standards 做 red/green，必要时 break check。最小完整改动，不额外加功能。
4. **自动验证**：运行 verify；检查日志，失败先处理。环境链接不符或端口被他人占用时脚本拒绝继续，不自动修掉别人的环境。
5. **真实验收**：从 `instances.json` 找启动日志中的本机登录 URL，用 Browser Use 验证实际交互；截图/日志保存在任务证据目录。Desktop 做窗口验收。脚本只检测 Web HTTP 200 / 未登录时的 401 和 Desktop 进程存在。
6. **自审与交付**：审最终 diff、旧数据兼容、未测项；更新需要改变的文档与任务记录。用户已授权提交/PR/合并时继续执行，否则交付本地变更。
7. **复盘**：有可复用教训才写 LESSONS，保留证据。不要为每个小改动造一条“经验”。

任何实际功能验收失败，先按 [官方 Session Log 诊断](../testing/session-log-diagnosis.md) 定位首个异常事件，再修复并复测；禁止靠反复发送直到偶然成功来覆盖失败。

## 发布记录如何填写

先按 [发布素材与用户审稿](release-materials.md) 完成 README、发布说明和 GIF，再核对候选版本并运行 prepare。完成技术验收后将最终文字交用户审核，通过后执行 gate。主记录为 `.codex-tmp/agent-workflow/release.json`；每次 prepare 的初始副本保存在对应 `release-*/`，旧日志和包不覆盖。

按清单完成验收后，逐项填写 `checks`：

```json
{
  "status": "PASS",
  "summary": "测试样例先取消不导入，再确认成功；重复导入按设计去重。",
  "evidence": ["docs/testing/releases/0.4.4-20261017-01.md", ".codex-tmp/release-check/0.4.4/import.png"]
}
```

- `browser`、`desktop`、`packageContents`、`cleanInstall`、`upgrade`、`changeReview` 必须 PASS。首次发布的 upgrade 在报告中记录确无旧版，并完成首次安装，不能空着。
- `readme`、`releaseNotes`、`demos` 也必须 PASS；无需改动/无需新增 GIF 时记录评估原因。`editorialApproval` 必须为用户明确批准的 APPROVED，附回复证据，并匹配候选源码和包哈希；具体字段见审稿流程。旧记录缺这些项时不放行。
- `redGreen`、`breakCheck`、`ci` 可 PASS 或有理由的 N/A。CI 已配置/涉及 PR 时不能以 N/A 隐藏失败；标准文档规定何时适用。
- `changeReview` 的证据必须列出发版清单中的受影响回归项及未测项；browser 证据逐来源覆盖，不能一句“测试通过”。
- `browser` PASS 还要求发版规程 4.5 的真实来源端到端测试：用户已授权使用其 DeepSeek 官方账号模型额度，实际发送引用、检查读取轨迹并对照原文核验回答。普通 UI 冒烟不能代替此项。
- 路径可以相对仓库根目录，证据必须是本地文件；外部 CI/PR 结果可在报告中保存链接、当前 SHA 与结果。
- gate 只能验证状态、文件存在和候选一致性，无法判断截图/手工陈述是否真实。Agent 必须实际执行，不得为了绿灯伪造记录。
- 源码指纹覆盖 Git 跟踪及非忽略的未跟踪文件，另单独检查 `lib/`。`docs/testing/releases/` 与忽略目录中的证据不使候选失效；测试后改动代码/依赖/其他文档则重新 prepare。
- 通过 gate 后，仅在用户已授权发布时发布记录指向的同一份 tgz，明确 dist-tag，核验 registry integrity。这里没有自动 publish 命令，`prepublishOnly` 保留既有 check；直接 npm publish 技术上仍可绕过手工证据门槛，Agent 禁止这么做。

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
