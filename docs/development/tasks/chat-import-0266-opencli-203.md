# Chat Import 0.26.6 与 OpenCLI 2.0.3 适配

- 用户目标（2026-11-14）：同步 Chat Import 0.26.6，接入其新增来源；OpenCLI 升到 2.0.3；刷新最低版本。
- 状态：代码完成，自动化通过；宿主菜单与真实数据验收 NOT_RUN。

## 改动
- `vendor/chat-import-reader/` 由 `npm run vendor:sync -- <dsh-chat-import@0.26.6 解包目录>` 重新生成（36 种格式）。上游变化：Codex `rollout-*.jsonl.zst` 压缩会话可扫描/读取、Codex 分页链按 thread 合并、WorkBuddy `~/.workbuddy-ai` 新根、Cursor 工作区登记册、新增 codebuddy / codearts / opencowork。
- `scripts/vendor-chat-import-reader.mjs` 新增补丁：上游 `lib/convert/buddy-family.mjs` 对 const 解构的 `skipped` 自增（esbuild 拒绝构建，运行时会抛 TypeError），改为可变计数。上游修复后删除该补丁（`replace` 不匹配会直接报错提醒）。
- 新来源：`src/wire.ts` 的 `IMPORT_ONLY_AGENTS` 与标签（CodeBuddy Code / CodeArts / openCoWork），图标取自上游 0.26.6 `assets/agents/`（MIT，见 `images/agents/README.md`），菜单码位 ``–``。
- 版本：Chat Import 导入最低 `0.26.6`（`src/chat-import-compatibility.ts` 与提示文案）；`MIN_OPENCLI_VERSION` 与插件 peer/opencli 声明 `>=2.0.3`，devDependency `2.0.3`；`opencli-plugin` 版本 0.2.6（仅 manifest 变化），`MIN_ADAPTER_VERSION` 保持 0.2.5（适配器命令未变，不强制重装）。

## 证据
- `pnpm typecheck` 通过；`vitest run` 1229 passed / 7 skipped（来源数断言 33→36）。
- 本机 scanner smoke：codex 81 条（本机无 `.zst`），codebuddy / codearts / opencowork 0 条（本机无数据）。

## 未测
- 新来源与 `.zst` Codex 会话的真实数据读取、@ 菜单、导入确认；agent-browser-test 环境中 dsh-chat-import 尚未升级到 0.26.6；OpenCLI 2.0.3 + 扩展 1.0.27 真实网页抓取。
- 新来源暂无合成 fixture（npm 包不含上游 test/_support）。
