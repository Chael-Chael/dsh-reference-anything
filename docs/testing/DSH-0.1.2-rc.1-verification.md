# DeepSeek Harness RC1 升级与 alpha 插件验证报告

> 插件更新：已通过 `dsh plugin --profile web add dshmarket@1.41.0 dsh-context@0.41.1` 从 npm 仓库更新两个插件；普通 `dsh web --no-open` 已成功启动，不再需要禁用它们的覆盖配置。`Start-DSH-RC1.ps1` 已改回普通启动。下文旧版本启动失败记录仅供追溯。

> 后续修复（2026-09-03）：当前工作区已将 Skills 迁移至 `ctx.remote.skills.list` 并注入 `remote.skills`；历史授权改用 `session.snapshotEvents()`。DSH 开发依赖固定为 RC1，最低 peer 版本提高到 RC1。`npm run check` 已完整通过：类型检查、772 项测试通过（7 跳过）、构建成功。历史授权测试已改用真实 Session，并覆盖恢复用户引用、工具引用和拒绝未授权访问。下文保留的是修复前的验证记录；其他插件和浏览器桥接问题不属于此次修复范围。

> 修复后页面复测：重启 dsh 并加载本地新构建产物，`@skills:` 正常返回技能列表，点击 academic-interview-coach 后正确插入 `/academic-interview-coach `；未发送给模型，测试草稿已清空。完整检查日志：`.codex-tmp/rc1-verification/repair-check.log`。

验证时间：2026-09-03，Asia/Shanghai。

**结论：dsh 已升级并启动；Reference Anything 0.4.0-alpha.1 的主要引用界面可用，但不能判定为完整兼容 0.1.2-rc.1。Skills、历史引用授权恢复、类型检查和构建存在明确问题。**

## 升级与运行环境

- 官方版本号：`0.1.2-rc.1`。发布说明：https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1
- 执行：`npm install -g @deepseek-ai/dsh@0.1.2-rc.1`，成功退出；升级前为 `0.1.2-alpha.1`，升级后 `dsh --version` 返回 `0.1.2-rc.1`。
- 全局 CLI：`C:\Users\27923\AppData\Roaming\npm\dsh.cmd`。
- Node.js：`v25.6.0`；pnpm：`11.22.0`。
- Web profile：`C:\Users\27923\.dsh\profiles\web`。
- 插件：`dsh-reference-anything@0.4.0-alpha.1`，通过 `link:D:/dsh-reference-anything` 加载工作区已有 `lib` 产物。这次没有替换插件源码或生产构建产物，也没有发布插件。
- 没有升级 `D:\deepseek-harness` 源码检出；当前 PATH 中实际执行的是上述全局 npm CLI。

## 实际页面验证

测试使用现有 Web profile、现有工作区及本地数据；没有向模型提交测试消息。

| 功能 | 结果 | 实测范围 |
| --- | --- | --- |
| Web 启动 | 有条件通过 | 需要本次启动覆盖配置跳过 dshmarket、dsh-context；原始完整 profile 启动失败 |
| Reference Anything 设置页 | 通过读取验证 | 页面正常加载，显示来源开关、候选数量、Agent 统计、OpenList 状态和网页对话管理；未逐项修改设置 |
| `@` 命令 | 通过列表验证 | 返回 compact、export、feedback、goal、permission、plan 等命令；未执行命令 |
| Skills | 不通过 | 技能设置存在，但 `@` 中没有技能分组；代码调用已移除的 `connection.api.skills.list`，RC1 类型检查明确失败 |
| 工作区文件与目录 | 通过列表与导航验证 | 能列目录，点击 docs 后能列出目录下的 Markdown 文件；未发送文件给模型 |
| DSH 会话 | 通过候选列表验证 | 返回已有会话候选；未验证引用后模型读取完整历史 |
| 本地 Agent 对话 | 通过搜索与插入验证 | 返回真实 Codex 历史，点击可插入带平台标识的引用；设置中检测到 Codex 190 条、opencode 10 条 |
| 网页 AI 对话本地索引 | 通过列表验证 | 返回已同步的 ChatGPT 等对话；设置显示 ChatGPT 118、Gemini 8、DeepSeek 2、Grok 14 条 |
| 网页 AI 实时同步/按需远端正文 | 未通过就绪检查，未做实时同步 | OpenCLI v1.8.7、适配器 v0.2.3 可发现，但浏览器桥接守护进程未运行；旧记录中的 Claude/Kimi AUTH_REQUIRED 是历史同步错误，不是本次重新登录测试结果 |
| OpenList/百度网盘 | 通过状态与目录浏览验证 | 异步加载完成后显示 OpenList 运行中、百度网盘可用；从 `@` 根目录进入网盘后返回真实子目录；未下载附件或修改云端文件 |
| 分组展开/折叠 | 未完成 | 看到了展开入口，但进一步点击时候选状态已变化；不计为通过 |
| 历史引用授权恢复 | 不通过 | 使用真实 RC1 Session 的独立复现检查触发 `TypeError: Cannot read properties of undefined (reading 'some')` |

## 自动化验证

1. 原工作区 `npm run check` 在类型检查阶段失败，包含多份 Cordis 类型来源以及旧接口错误；`npm test` 单独运行得到 **41 个文件通过、1 个文件跳过；771 项通过、7 项跳过**。
2. 为排除原工作区依赖混杂，在 `.codex-tmp/rc1-verification/sdk-check` 复制源码和测试，使用独立 pnpm workspace，把 DSH 开发依赖及 peer 约束固定为 `0.1.2-rc.1`。未改动主工作区 package.json / pnpm-lock.yaml。
3. RC1 隔离环境运行原有测试：仍为 **771 项通过、7 项跳过**。跳过项不能算通过；测试包含模拟来源、模拟 UI 和模拟 Session，不等同于全部真实账户端到端验证。
4. RC1 隔离环境 `npm run typecheck`（通过 `npm run check` 调用）失败；`npm run build` 单独执行也失败。
5. 新增仅用于验证的 `tests/rc1-compat.spec.ts`，使用 RC1 的 `Session.create()`，要求未授权引用返回插件的权限错误。实际返回 TypeError，**1 项失败**，证明现有测试的成功不足以覆盖 RC1 兼容性。

## 定位到的问题

### Reference Anything

- `src/client/index.ts:265`：`ConnectionHandle.api` 已不存在。RC1 官方技能客户端使用 `ctx.remote.skills.list(...)`。需要迁移调用方式并声明相应依赖。
- `src/index.ts:165`：`Session.events` 已不存在，RC1 提供 `snapshotEvents()`。`assertSessionGranted()` 的两个调用点位于 `src/tool.ts:279`、`src/tool.ts:593`，涉及正文和附件读取。当前会话已有内存 grant 时会绕过这段代码，所以新插入引用成功不代表恢复旧会话后仍能读取。
- `tests/local-agent-source.spec.ts` 使用包含 `events` 的对象并强转为 Session，掩盖了真实 API 变化。新增真实 Session 检查已复现异常。
- `tests/client-manage.spec.tsx:70,512,531`：设置槽位测试仍传入 RC1 类型已不接受的 `useSessions` 等属性。属于测试接口迁移问题。

### 其他已安装插件

| 插件 | 问题 | 本次处理 |
| --- | --- | --- |
| dshmarket 1.35.0 | 导入 `dsh-settings.installSettingsSection` 失败，阻止启动 | 仅启动覆盖配置禁用 `dsh-market` |
| dsh-context 0.36.0 | 导入 `dsh-settings.settingsNamespace` 失败，阻止启动 | 仅启动覆盖配置禁用 `dsh-context` |
| 本地 dsh-token-rain | `conversation.input.right` 插槽报 `.map` on undefined；其构建代码仍读取 `snapshot.runningCalls` | 保持原加载状态；挂件故障不阻止主界面，未修改该项目 |

## 供本人测试

服务地址：**http://127.0.0.1:3080/**。已登录的测试页面会留在 Codex 浏览器中；新浏览器若要求认证，请使用启动终端输出的一次性登录链接。

当前进程在回环地址监听，不开放局域网。启动使用：

```powershell
dsh --profile web --patch D:\dsh-reference-anything\.codex-tmp\rc1-verification\compat.patch.yml --host 127.0.0.1 --port 3080 --no-open
```

需要重新启动时，可执行同目录的 `Start-DSH-RC1.ps1`；它会保留当前工作目录并用同一覆盖配置启动、自动打开浏览器。若 3080 已有当前服务，先使用现有页面，不要重复启动。

**直接执行不带覆盖配置的 `dsh web` 仍可能被上述两个旧插件阻塞。** 原 profile 的 package.json、锁文件未修改；启动覆盖文件只包含两个禁用项。

建议亲测顺序：输入 `@` → 搜索文件/本地 Agent 对话并插入 → 进入 `@drive:` 网盘目录 → 打开 Reference Anything 设置。Skills 和旧会话授权恢复属于已知失败项；网页远端同步需先恢复桥接服务及对应站点登录。

## 本地证据与复现

证据目录：`D:\dsh-reference-anything\.codex-tmp\rc1-verification`。

- `workspace-check.log`、`tests-before.log`：原环境检查。
- `rc1-sdk-check.log`、`rc1-tests.log`、`rc1-build.log`：固定 RC1 SDK 的检查。
- `rc1-regression.log`：真实 Session 失败结果。
- `sdk-check/tests/rc1-compat.spec.ts`：最小复现测试。
- `dsh.stderr.log`：完整 profile 首次启动失败堆栈。
- `profile-package.before.json`、`profile-lock.before.yaml`：profile 元数据备份。
- `compat.patch.yml`：当前服务使用的两个禁用项。

复现 Session 问题：

```powershell
Set-Location D:\dsh-reference-anything\.codex-tmp\rc1-verification\sdk-check
node node_modules\vitest\vitest.mjs run tests/rc1-compat.spec.ts
```

本次交付是升级、验证及报告；已确认的不兼容点没有被静默改写为新的插件版本。
