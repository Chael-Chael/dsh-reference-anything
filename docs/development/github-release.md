# GitHub Actions 发布

入口：`.github/workflows/release.yml`。日常 push、PR 和推送标签都不自动发布。显式运行工作流，`publish=false`（默认）只检查；用户确认本版本发布后才使用 `publish=true`。

## 一次性接入

1. 将工作流、脚本及测试合入并推送到 `main`。本地实现不等于获得提交、推送或发版授权。
2. 在 GitHub 仓库 Settings → Environments 创建 `npm-release`，添加维护者为 required reviewer，限制 deployment branch 为 `main`。单人维护时不要启用 prevent self-review，否则自己触发的发布无法批准。不配置 reviewer 时仅有 environment 名称并不产生审批保护。
3. 在 npm 的 `dsh-reference-anything` 包 Settings → Trusted Publisher 中选择 GitHub Actions：

   | 字段 | 值 |
   | --- | --- |
   | Organization or user | `Chael-Chael` |
   | Repository | `dsh-reference-anything` |
   | Workflow filename | `release.yml` |
   | Environment name | `npm-release` |

   允许直接 `npm publish`。无需添加 `NPM_TOKEN`；工作流使用短期 OIDC 身份。GitHub 的 `contents: write` 用于下载草稿资源和公开 Release，`id-token: write` 仅授予正式发布 job。现有 token 不自动撤销。

参考：[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)、[GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)。

## 每版操作

由 Agent 操作，用户在聊天中审稿并明确批准发布。版本号以下以 `0.6.0` 为例，不能直接拿示例发布。

1. 将最终源码和 `docs/release-v0.6.0.md`（UTF-8、LF）提交，确认工作区干净；文案先按现有模板完成。候选提交须为启动工作流时的 main HEAD，确保 provenance 指向该候选提交。验收期间冻结该版本提交，后续变更需要重新准备。
2. 按[发版规程](../testing/npm-release-checklist.md)执行 prepare、全部真实验收、用户最终文字审核和 gate。审批记录、完整报告和私人日志保留本地。
3. 执行 `node scripts/agent/release-ci.mjs export`。它重新执行 gate，并导出到 `.codex-tmp/agent-workflow/ci-0.6.0/`：
   - `candidate.tgz`：已验收的原包，不重建。
   - `release-notes.md`：审核后的原文，不生成或改写。
   - `release-manifest.json`：版本、提交、哈希及门禁结果，不含用户原话、私人证据和本机路径。

   已存在的导出目录不会覆盖；候选改变后，先将旧目录改名留档再重新导出。导出失败不得上传残缺内容。
4. 获得对应远端操作授权后，推送候选提交和精确 tag，创建草稿并上传以上三个文件。先查 tag/Release 是否存在；已有 tag 必须指向候选 SHA，不移动旧 tag。恢复已有草稿时不覆盖已上传资产，先比对哈希。

   ```powershell
   git push origin main
   git tag v0.6.0 <候选完整SHA>
   git push origin refs/tags/v0.6.0
   gh release create v0.6.0 --verify-tag --draft --title v0.6.0 --notes-file .codex-tmp/agent-workflow/ci-0.6.0/release-notes.md
   gh release upload v0.6.0 .codex-tmp/agent-workflow/ci-0.6.0/candidate.tgz .codex-tmp/agent-workflow/ci-0.6.0/release-notes.md .codex-tmp/agent-workflow/ci-0.6.0/release-manifest.json
   gh workflow run release.yml --ref main -f tag=v0.6.0 -f publish=false
   ```

5. 检查当前候选的演练结果；用户已明确授权发布本版本后：

   ```powershell
   gh workflow run release.yml --ref main -f tag=v0.6.0 -f publish=true
   ```

   等待 `npm-release` 环境批准后上传 npm，回查包完整性与 dist-tag，再公开 GitHub Release。正式版使用 `latest`，带预发布后缀的版本使用 `next` 并标记 GitHub prerelease。正文原文来自校验过的文件。

## 门禁与恢复

- CI 使用仓库现有 pnpm 锁文件执行 `pnpm install --frozen-lockfile` 和完整 `npm run check`。这些检查产生的 build 不用于发布，不替代本地真实 Web、Desktop、干净安装和升级验收。CI 不启动本机 profile。
- 下载资源先校验版本、提交、审核状态、包 SHA-256/SHA-512、包内 name/version，以及正文与该提交文件完全一致。验证 job 将三份文件保存为本次运行 artifact；发布 job 使用该 artifact 并再次校验，避免等待批准时草稿资产变化。
- 清单是通过本地 gate 导出的交接记录，不是用户身份的数字签名。真正的授权依赖维护者权限、直接用户批准和 GitHub environment reviewer；不得手写清单代替验收。
- npm 查询只有 404 视为版本不存在；鉴权、限流、服务错误和网络异常直接阻塞。已有版本只有 integrity 相同才可跳过上传。
- npm 上传命令失败时先回查 registry，处理上传成功但客户端未收到响应的情况；不会循环重复 publish。npm 已成功、GitHub 失败时重跑同一次运行，可补齐 Release。
- dist-tag 不符合预期时停止，不自动修改或将旧版本重新设成 latest。排查后按单独授权修复。
- npm 与 GitHub 不存在跨平台原子事务：npm 成功后 Release 仍可能失败，此时 npm 版本已经公开，不应自动删包或递增版本。
- 不上传原始 `release.json`、审稿对话、截图、Session Log 或私人会话。三个发布资源会随 Release 公开，上传前按实际 npm 包清单检查泄露和漏文件。
- 仅实现工作流、通过本地单测或演练，都不能报告“已发布”。必须报告远端 run 结果、npm integrity/dist-tag 和 GitHub Release 可见状态。
