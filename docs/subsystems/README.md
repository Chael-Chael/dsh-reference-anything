# 子系统地图

这是定位入口，实际行为以源码和测试为准。改变边界时更新相关行；需要解释复杂不变量时才新增专题文档。

| 子系统 | 源码入口 | 验证入口 | 关键边界 |
| --- | --- | --- | --- |
| 引用注册、URI、读取 | `src/index.ts`, `uri.ts`, `uri-codec.ts`, `reference.ts`, `tool.ts` | `tests/runtime.spec.ts`, `uri.spec.ts`, `mention.spec.ts`, `tool*.spec.ts` | 只读、权限、编码兼容、输出限额 |
| 客户端菜单与设置 | `src/client/index.ts`, `source.ts`, `components.tsx`, `styles.ts` | `tests/client-*.spec.*` + Browser Use | 来源覆盖、键盘语义、异步结果、主题 |
| 本地 Agent | `src/sources/local-agent/`, `agent-scan-cache.ts`, `local-reference.ts`, `local-reference-tools.ts` | `tests/local-agent-*.spec.ts`, `local-reference.spec.ts`, `agent-scan-cache.spec.ts` | 多格式、来源开关与真实路径校验；本地 ref/revision/part/from/maxItems → items/next，搜索 hits.position；next 保留消息范围，长文本按码点补读；附属记录只保留可靠关联 |
| 会话读取和导入 | `src/chat-import-*.ts`, `local-conversation-reader.ts`, `vendor/chat-import-reader/` | `tests/chat-import-*.spec.ts`, `local-conversation-reader.spec.ts`, 合成 fixtures | 导入确认、版本兼容、插件生命周期 |
| 网页会话/OpenCLI | `src/opencli.ts`, `src/sync/`, `src/sources/web-chat/`, `opencli-plugin/` | `tests/opencli*.spec.ts`, `sync.spec.ts`, `provider-*.spec.ts` | 账号范围、认证、增量、超时 |
| 云盘/OpenList | `src/openlist/`, `src/sources/cloud-drive/` | `tests/openlist*.spec.ts`, `cloud-drive-source.spec.ts`, `download-directory.spec.ts` | URL 校验、下载目标、凭据 |
| 宿主/Remote | `src/host.ts`, `web.ts`, `contract.ts`, `typert.ts` | `tests/web.spec.ts`, `runtime.spec.ts` | 服务契约、不同 profile |
| 构建/发版/升级 | `build.mjs`, `package.json`, `cordis.patch.yml`, `src/update.ts`, `release-notes/` | `tests/update.spec.ts`, `release-features.spec.mjs`, 发版规程 | npm 文件完整性、SDK、版本 |
| Agent 开发设施 | `scripts/agent/`, `AGENTS.md`, `docs/development/` | `tests/agent-workflow.spec.mjs` | 证据失效、失败退出码、指定环境刷新 |

用 `rg --files tests` 和 `rg <函数名> src tests` 找所有相关调用方，表格不是测试枚举器。完整测试由 `npm run check` 执行。

官方 UI 接管边界与版本差异见 [ui-reference 兼容审计](../development/tasks/native-reference-compatibility.md)。
