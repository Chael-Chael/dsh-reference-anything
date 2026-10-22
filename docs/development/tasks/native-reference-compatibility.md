# 禁用官方 ui-reference 后的兼容审计

后续共存修复见 [Issue #13：原生引用注册归属](issue-13-reference-ownership.md)：默认继续由 RA 接管，显式启用官方插件时让出原生注册并隐藏重复候选。

日期：2026-10-19（Asia/Shanghai）。用户选择方案 A：保留 bundle 对 `ui-reference` 的禁用，在 RA 内补齐兼容能力。没有合并 PR #12，没有升级 Desktop 或发布包。

## 审计基线与范围

- 官方仓库拉取到独立的 `.codex-tmp/upstream-deepseek-harness`，commit `687f282e8625c6b8d11ff58211a90524be2e4317`，`ui-reference` 版本 `0.2.1-rc.2`。
- 本机已安装的 `ui-reference` 为 `0.1.2-alpha.1`；旧包不能代表最新版。此前关于官方插件不负责文件正文规则的判断仅适用于旧实现，对最新版已撤回。
- 核对官方插件的全部 `apply` 注册项、原生 drop/paste 调用方、输入序列化与预览分派、消息渲染、文件/会话服务及 RA 对应实现。官方 Host 端 `ui-reference/src/index.ts` 的 `apply()` 为空。
- 影响范围：`src/client/index.ts`、`native-reference-text.tsx`、`locale.ts`、`styles.ts`、客户端回归测试、patch 注释与第三方声明；无需新增依赖、Remote 或 Host 读取实现。

## 逐项结论

上游路径参照 [固定版本源码](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)；表中 `ui-*` 位于 `packages/client/`，`util/` 位于 `packages/`。

| 官方职责 | 禁用后的结论与处理 | 源码依据 |
| --- | --- | --- |
| 原生文件/目录拖放、剪贴板文件的 `source: 'reference'` 序列化 | **确认缺失并修复**。常驻注册同名无候选 codec，原样保留 ref，独立于 RA 文件菜单开关 | `ui-conversation/src/client/apply.ts:511`；`ui-input-trigger/src/client/controller.ts:346`；`ui-reference/src/client/index.ts` 的 codec |
| 原生 chip 复制、恢复的官方 session chip | 同一 codec 的 `clipboardText`、`serialize` 原样保留文件、带空格路径、目录和 canonical session mention；回归测试覆盖 | `ui-reference/src/client/index.ts` 的 codec；RA `client-plugin-toggle.spec.ts` |
| 输入框中点击文件打开预览 | **随原 owner 一并丢失，已补齐**。复用现有 `createFileSource.openReference`，使用引用所属 session 的文件地址；目录保持官方的不可点击语义 | 官方 `openReference`、`util/workspace-path/src/index.ts:fileAddressFor`；RA `source.ts` |
| 新版已发送消息中的文件/目录识别与卡片 | **额外确认缺失并修复**。移植上游两条文本规则与两个 slot；旧宿主无 `userText` API 时不注册，保留其原有渲染 | `ui-reference/src/client/index.ts:59`、`user-text-rules.ts`、`FileReference.tsx` |
| 新版消息文件卡片打开失败反馈 | **额外确认缺失并修复**。保留官方同步导航异常的局部提示、关闭和重试；不把异步文件读取失败混为同一错误 | `ui-reference/src/client/FileReference.tsx` |
| 原生文件/目录输入 chip 图标 | **实测发现 RA 误覆盖，已修复**。旧宿主只暴露 owner `reference`，不能据此推断为会话。缺少 appearance 时保留官方图标；明确 session 类型仍保留 RA 的 DSH 图标 | RA `styles.ts:projectComposerChips`；`client-styles.spec.ts` 的 red/green |
| 文件/会话候选、目录钻取及面包屑、带引号路径 | RA 已有对应来源、`header`/`onPick` 和官方 `formatFileMention`，无需恢复重复官方菜单 | RA `source.ts:createFileSource`；`index.ts:referenceCandidates` |
| 会话候选、子会话分组、取消和等待 session 打开 | RA 已有实现。样式、描述文案和排序属于 RA 的产品呈现，不宣称逐字复制官方菜单 | RA `source.ts:createSessionSource`、`index.ts:referenceCandidates` |
| 已发送消息中的 session 卡片 | 仍由 `ui-conversation` 注册，**未随 ui-reference 丢失**，不重复移植 | `ui-conversation/src/client/apply.ts:162,184` |
| 文件/会话实际读取、沙箱、附件上传 | 属于独立 Host 服务及 `ui-conversation`，**未因禁用这个纯 UI 插件而删除**。原生图片通常走附件分支，不能把本次故障泛化成所有图片上传失败 | `ui-reference/src/index.ts`；`ui-conversation/src/client/apply.ts:addFiles` |
| 禁用 RA 后恢复官方插件 | 新注册 codec 使用 effect disposer；新规则与 slots 由插件生命周期管理。测试确认 native owner 随 RA 释放，避免遗留占名 | RA `client-plugin-toggle.spec.ts`、`client-native-reference-text.spec.tsx` |

普通 `text/plain` 路径粘贴与剪贴板携带 `File` 是不同分支。本次确认会产生原生 reference chip 的是后者及 Desktop 路径拖入；没有把“任意粘贴路径必定报错”写成事实。

## 验证与证据边界

- 自动化：最终 `npm run check` 成功，类型检查、1130 项测试通过（8 skipped）、build 完成。日志 `.codex-tmp/native-reference/final-check.log`。
- 证据绑定本次 22:28 的构建及随后 Web 复测。结束检查发现并行工作于 22:33 修改 `menu-opening.ts`、其测试并再次 build；本任务未改动这些文件，也不把本次结果冒充并行改动后的完整验收。Git HEAD 仍为 `1b8cf3e1dc09b5dbf9801c6ceb1c0f85618c45ed`，所有本次修复保持未提交。
- 原生 owner 回归：旧代码因缺少 `reference` 注册失败；新增覆盖序列化、复制、预览、隐藏文件菜单时仍保留 codec、插件卸载释放 owner。
- 图标回归：3 个旧实现测试均因实际 `session` 覆盖失败，修复后通过。red 日志 `.codex-tmp/native-reference/icon-red.log`。
- 上游解析一致性：对固定版本源码及 RA 的两个 matcher 运行 9 条输入、406 个偏移组合，结果一致。`.codex-tmp/native-reference/upstream-parity.json`。这不等于新版宿主完整 UI 验收。
- 解析器 break check：在内存隔离副本中反转文件/目录判别，两个对应断言均检出差异；没有修改工作区实现。`.codex-tmp/native-reference/parser-break-check.json`。
- 新版消息组件：单测覆盖规则/slot 注册与释放、引用所属 session、旧宿主跳过、导航失败弹窗、重试、不可交互摘要与目录。当前安装包没有新版 `ReferenceChip`，组件单测使用该组件的契约替身。
- Web：`agent-browser-test`（127.0.0.1:3081），模拟 Desktop 的 `__DSH_HOST_PATHS__` 桥接及剪贴板目录标记，真实执行宿主的 drop/paste → reference chip → codec → 发送 → 官方账号模型读取。不是操作系统级 Desktop 拖放证据。
- 官方会话 `session-fb883303-e99d-4f7a-913b-69fe450bd12c`：`deepseek-account / deepseek-flash`。首轮 `user/message seq13` 保留带引号路径，`tool/result seq26` 返回测试文件标记，`assistant/message seq33` 回答一致，`turn/end seq35` completed；第二轮 `seq40` 同时保留文件/目录 mention，`seq45/46` 为两次成功读取，`seq50` 返回两个正确标记，`seq52` completed。重试模型请求后均自行成功，没有更换 provider。
- 最终图标补丁构建后仅刷新 Web，重新核对原生图标、文件预览，并以改写后的测试文件验证读取：第三轮 `seq60` 为原生文件/目录 mention，`seq75/76` 成功读取新标记，`seq83` 回答 `NATIVE_FINAL_FILE_7F3A` / `NATIVE_FINAL_DIR_9B2C`，`seq85` completed。菜单仅有 RA 的文件/会话分组，没有 `reference` 候选；结束清空草稿。脱敏证据 `.codex-tmp/native-reference/web-evidence.json`；截图 `final-native-draft.png`、`final-native-preview.png`、`final-native-send.png` 位于同目录。
- `/export` 的浏览器下载保存曾 canceled，使用同一已认证浏览器的官方导出 URL 重取，HTTP 200；没有绕过认证。原始导出清理 **BLOCKED**：自动审批先拒绝限定目录清理，随后也拒绝逐个指定文件的非递归删除，仅返回 `blocked by policy`。暂保留 `.codex-tmp/native-reference/session.zip`、`session-final.zip`、`session-export/session.v4.jsonl`、`session-final-export/session.v4.jsonl`，均为本次测试会话；脱敏定位另存于本报告及 `web-evidence.json`。未删除 DSH 原始 sessions。
- Desktop：**NOT_RUN / 用户明确要求暂不重启**。没有执行会自动重启 Desktop 的 `agent:verify`/`agent:sync`，改为完整 check 加 Web 单环境刷新；不声明完成 Desktop 验收。
- 最新 `0.2.1-rc.2` 完整宿主 UI：**NOT_RUN**。本轮拉取源码进行对照、兼容实现及规则测试，没有替换用户安装版本。

完整发版回归仍按发版清单执行，本报告只覆盖此次兼容修复，不作 npm 放行依据。
