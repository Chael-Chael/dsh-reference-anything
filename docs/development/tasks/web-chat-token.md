# DeepSeek / Kimi token 接入

2026-10-21：用户授权使用 Node 绑定 `@napi-rs/keyring@2.1.2`；共享目录出现并发覆盖后，用户明确选择独立 worktree 继续。当时已三方合并回主目录；验证记录为当时结果。

2026-10-23：随 `codex/main-after-v0.5.0` 合并回 main；已发布的 0.5.1 包不包含此功能。合并后的验证边界见本地 `.codex-tmp/merge-backup-20261023/README.md`。

## 实现边界

- 首次连接使用 OpenCLI 2.0.0 的公开 Page API，普通 browser surface 下创建并关闭自己的标签页。适配器容器可能保留旧登录快照，不用它捕获当前用户凭据。
- token 只通过进程内结果传递，存入 OS keyring。设置中仅保存随机 UUID 引用；通用 settingsUpdate 不能更改此引用。不同新建 profile 的连接生成独立条目。
- Windows Credential Manager / macOS Keychain；Linux 显式指定 Secret Service，禁止静默降级为内核临时 keyring 或明文文件。固定 npm 版本及其平台二进制版本；主目录 pnpm-lock.yaml 同步锁定绑定及各平台原生包与 integrity。
- Host 复用浏览器适配器的分页与消息解析脚本，禁止浏览器 DOM 降级；只向平台的固定 HTTPS origin 发送 Bearer token，拒绝重定向及外域附件，限时与限流、限制响应体积。
- 每次先验证远端身份与已保存账号 hash；正文/附件同时校验引用账号。已连接 token 不可用时明确失败，不自动改用浏览器的其他账号。
- 删除凭据会中止该来源正在进行的 token 请求，删除密钥库条目，保留历史索引。token 过期需要用户重新连接；不保存 refresh_token、不实现静默续期。
- 密钥库保护静态存储，进程使用时仍有明文 token，不能保证防御同用户恶意程序。卸载插件前可在来源卡片删除已存凭据；复制 profile 配置不会迁移 OS keyring。

## 验证

- Windows 系统密钥库合成值读写删除 PASS；真实账号测试凭据最终均删除。
- DeepSeek 真实只读后台枚举 121 个去重会话，抽取一会话 2 条消息 PASS。
- Kimi 初测发现 adapter surface 旧 token；普通 browser surface 返回已登录身份。修正后真实只读后台枚举 70 个会话，抽取一会话 2 条消息 PASS；两家测试凭据均已删除，脱敏报告见本地 `.codex-tmp/token-real-report.json`。
- 自动化覆盖分页重叠、分页损坏、401/403/429、业务认证失败、跨账号、跨源附件、响应限额、取消、密钥库失败无明文降级；移除账号校验后回归测试失败，break check PASS。
- 原 agent-browser-test 3081 与 Desktop 未改动；独立 UI 验收 profile 为 agent-browser-test-token，端口 3082，存储/会话目录独立。macOS/Linux 原生密钥库未实机验证。

## 复盘

公开浏览器 API 与适配器隔离环境并不必然共享最新登录凭据。账号捕获需核对 HTTP 身份结果，不能只检查 localStorage 中存在 token；新增 capture 测试约束使用普通 browser surface 并清理自己创建的标签页。

最终 `agent:verify` 的 typecheck、1167 项测试、build PASS（8 项原有跳过）；标准环境刷新因 3081 绑定主目录而 BLOCKED，未改动其链接。已手动刷新隔离 profile agent-browser-test-token。

最终完整检查更新：`npm run check` 1168 PASS、8 SKIP；UI 间距调整后 build 与 124 项相关测试 PASS。包文件检查 PASS：包含两个共享解析脚本及 Host token 模块，不包含测试脚本/凭据。真实 3082 设置页连接、同步、删除测试凭据均 PASS，DeepSeek 121/121、Kimi 70/70；删除凭据后保留索引且恢复“连接账号”状态。截图 `.codex-tmp/token-ui.png`。

## 主目录合并复验（2026-10-21）

- 在主目录 HEAD `5bb263e` 上执行三方合并，保留另一任务的工作区排序、扫描持久化等改动；无重置、覆盖整文件或改写提交。重叠文件仅合入 token 差异，其余文件 hash 与 HEAD 一致。
- `npm run agent:verify`：1175 PASS、8 SKIP，typecheck/build 与 3081 环境刷新 PASS。Desktop 按已解除本地链接的环境约定跳过。日志 `.codex-tmp/agent-workflow/verify-1792551996631/`。
- 离线解析初次遗漏 keyring 原生可选依赖，真实密钥库测试发现加载失败。已根据 npm 包锁中的完整平台依赖与 integrity 补齐 pnpm 锁，冻结锁安装及 789 项供应链策略检查 PASS；主目录原生 keyring 重新加载成功。
- 主目录编译产物真实验证：两家捕获、Windows 密钥库保存读取、后台枚举及正文读取均 PASS；DeepSeek 121、Kimi 70 个会话，各抽取 2 条消息；临时凭据清理 PASS。报告 `.codex-tmp/token-real-report.json`。
- 3081 真实设置页：连接、同步（DeepSeek 121/121、Kimi 70/70）、删除测试凭据 PASS；本地历史索引保留（Kimi 71 条包含原有记录），未执行历史清除或导入。截图 `.codex-tmp/tasks/token-merge/ui.png`。macOS/Linux 原生运行及 Desktop UI 未验证。
