# 子系统地图

这是定位入口，实际行为以源码和测试为准。改变边界时更新相关行；需要解释复杂不变量时才新增专题文档。

| 子系统 | 源码入口 | 验证入口 | 关键边界 |
| --- | --- | --- | --- |
| 引用注册、URI、读取 | `src/index.ts`（注册表：`registerPlugin`、`resolveMention`、只认用户 @ 的授权 `assertPluginGranted`；旧 `ReferenceSource` 由 `legacy-source.ts` 包装成来源插件）, `reference-source.ts`（插件接口与 SDK `defineReferenceSource`：分页、`next`、搜索、revision、预览、错误规范化）, `uri.ts`, `uri-codec.ts`, `reference-prestep.ts`（发送前授权、插入来源用法与预览）, `tool.ts`（单一 `reference` 工具：路由、授权、预算、文件子项物化与临时文件清理） | `tests/runtime.spec.ts`, `uri.spec.ts`, `reference-prestep.spec.ts`, `tool*.spec.ts`, `example-source.spec.ts` | 只读、只有 @ 授权、编码兼容、超预算报错不截断；文件子项一律给临时路径，≤10 MiB 图片附像素，下载上限 50 MiB、本地不限 |
| 客户端菜单与设置 | `src/client/index.ts`, `source.ts`, `components.tsx`, `styles.ts` | `tests/client-*.spec.*` + Browser Use | 来源覆盖、键盘语义、异步结果、主题 |
| 本地 Agent | `src/sources/local-agent/`（`ids.ts` 可逆 id `<agent>[@位置]:<相对路径>[#会话]` 与扫描位置命名，`reference.ts` 的 `local` 来源插件）, `agent-scan-cache.ts`, `local-reference.ts`（会话加载、范围校验、内嵌图片字节） | `tests/local-agent-*.spec.ts`, `local-reference.spec.ts`, `agent-scan-cache.spec.ts` | 多格式、来源开关与真实路径校验；按名定位扫描位置，找回只认同一会话；同工作目录会话免 @；图片与工具记录是子项 |
| 会话读取和导入 | `src/chat-import-*.ts`, `local-conversation-reader.ts`, `vendor/chat-import-reader/` | `tests/chat-import-*.spec.ts`, `local-conversation-reader.spec.ts`, 合成 fixtures | 导入确认、版本兼容、插件生命周期 |
| 网页会话/OpenCLI | `src/opencli.ts`, `src/web-chat-token*.ts`, `src/sync/`, `src/sources/web-chat/`（`document.ts`：共享 `reference_*` 工具的文档来源）, `opencli-plugin/` | `tests/opencli*.spec.ts`, `web-chat-token*.spec.ts`, `web-chat-document.spec.ts`, `sync.spec.ts`, `provider-*.spec.ts` | 账号范围、认证、增量、超时；token 被拒时只从浏览器重取同一账号，未登录才回退 OpenCLI 页面读取 |
| 云盘/OpenList | `src/sources/cloud-drive/`（启动并持有 `src/openlist/`，同一开关） | `tests/openlist*.spec.ts`, `cloud-drive-source.spec.ts`, `cloud-drive-openlist-lifecycle.spec.ts`, `download-directory.spec.ts` | URL 校验、下载目标、凭据 |
| 宿主/Remote | 核心 `src/host.ts`、`core-remote.ts`（由核心在有 Typert 时挂载）；各来源 `sources/*/remote.ts`；`contract.ts`、`typert.ts`、`remote-mount.ts` | `tests/web.spec.ts`, `client-remote-face.spec.ts`, `runtime.spec.ts` | 一个来源一个 Remote，随其插件挂载；客户端 `composeRemoteFace` 对缺席 Remote 返回失败结果 |
| 第三方来源 SDK | `src/sdk.ts`、`src/client/source-registry.ts`，示例 `examples/reference-source-notes/`；写来源技能 `skills/reference-source-author/SKILL.md` + `src/source-author-skill.ts`（核心注册，设置页「立即尝试」打开预填的新对话） | `tests/example-source.spec.ts`, `client-source-registry.spec.ts`, `source-author-skill.spec.ts` | 只经 `ctx.references` 与 `referenceSources` 接入；见 [接入文档](../development/third-party-source.md) |
| 来源设置 | `src/settings.ts`，各来源 `settings.ts` | `tests/source-settings.spec.ts` | 每个来源自有记录；旧设置一次性迁移，用户保存不被覆盖 |
| 构建/发版/升级 | `build.mjs`, `package.json`, `cordis.patch.yml`, `src/update.ts`, `docs/release/` | `tests/update.spec.ts`, `release-features.spec.mjs`, 发版规程 | npm 文件完整性、SDK、版本 |
| Agent 开发设施 | `scripts/agent/`, `AGENTS.md`, `docs/development/` | `tests/agent-workflow.spec.mjs` | 证据失效、失败退出码、指定环境刷新 |

用 `rg --files tests` 和 `rg <函数名> src tests` 找所有相关调用方，表格不是测试枚举器。完整测试由 `npm run check` 执行。

官方 UI 接管边界与版本差异见 [ui-reference 兼容审计](../development/tasks/native-reference-compatibility.md)。

DeepSeek/Kimi 系统密钥库与后台读取边界见 [token 接入记录](../development/tasks/web-chat-token.md)。
