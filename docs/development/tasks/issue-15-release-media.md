# Issue 15：功能介绍媒体与选择性移植

最新累计结果见 [2026-10-29 验收报告](../../testing/releases/0.5.1-issue15-20261029.md)：已补测实际包干净安装/升级、OMP 导入与持久化、隔离 Electron 功能卡及基础引用；下方 NOT_RUN 为此前阶段记录，以累计报告为准。

## 范围与实现

- 用户授权：以发布版 0.5.1（e0311d2）为基线，修复 GIF 内联，引入文件/素材整理、OMP 与解析器更新；不合并整个 main，不发布。
- 已引入：ed289ee 的发布素材迁移部分（docs/release），297c5c3 的 OMP、图标、0.26.2 解析器与导入兼容部分。未引入扫描 UI、扫描持久化、Token 连接、CI 发布流程。
- GIF：构建不再编码图片，只生成 GitHub 固定提交 c0c8ad5ec72b4e8fa0cd97a7721ff3e62e735586 的 HTTPS URL。保留路径边界、格式和 alt 校验；npm 仅携带发布文字与 JSON，图片仍保存在 Git 仓库。
- 当前卡片显示时才挂载图片，关闭/翻页卸载旧图片；加载失败提供中英文提示及重试，文字和导航不依赖图片请求。保留首次打开插件设置自动显示介绍的行为。
- 未增加 Remote 方法。未来待 DSH 0.2.2 正式版再评估官方资源通道；此次不提前依赖 alpha 接口。

## 2026-10-28 验证

| 检查 | 结果 | 证据/限制 |
| --- | --- | --- |
| 定向媒体与弹窗测试 | PASS，17 项 | URL 编码、越界拒绝、当前图片、失败重试、翻页和卸载 |
| 类型检查、完整测试、构建 | PASS，1163 passed / 8 skipped，62 files passed / 2 skipped | `.codex-tmp/agent-workflow/verify-1793198380999/check.log` |
| 双环境同步 | BLOCKED | 同目录 `sync.log`；Web profile 链接 D:/dsh-reference-anything，Desktop 包也未链接本工作树。未更改现有配置或停止进程 |
| 远程媒体 | PASS，10/10 HTTP 200 且 SHA-256 与本地一致 | `.codex-tmp/issue-15/remote-media-validation.json`；Node 网络请求，不是浏览器验收 |
| npm 包内容 | PASS | `.codex-tmp/issue-15/pack.json`、`package-validation.json`；0 个 GIF，0 个内联 GIF，保留发布 MD/JSON |
| 真实 Web 功能卡 UI | PASS（本轮补测） | 见下方独立存储测试；不代表全部插件功能验收 |
| Desktop UI | NOT_RUN | Desktop 未改动，Web 结果不替代 Electron 验收 |
| 真实 OMP 导入、干净安装/升级、运行时内存对照 | NOT_RUN | 自动化解析/兼容测试不替代真实 DSH 操作 |

官方 0.5.1 客户端为 34,825,059 bytes，本次构建为 2,889,956 bytes，减少约 91.7%。npm 包约 2.62 MiB，解压约 5.45 MiB；最终精确数据见 pack.json。这些是文件大小，不是渲染进程内存测量。最终包见 `.codex-tmp/issue-15/dsh-reference-anything-0.5.1.tgz`，仅供本地验证，版本尚未提升，不可当成已发布的新版本。

已知风险：GitHub 图片受网络影响；图片实际播放仍有解码内存，浏览器可保留缓存。未宣称原报告的全部内存增量均由 GIF 引起。依赖包缺少 source map 等现有告警未影响本次 check 通过。

## 同日补测：真实 Web 功能卡

- 用户授权使用 Agent 环境后，临时将 `agent-browser-test` 的包链接切到本工作树；结束已恢复原 `D:/dsh-reference-anything` 链接并停止本次进程。Desktop、用户亲测环境和主目录代码未改动。
- 首次尝试发现原测试存储含 main 新增的 qwen provider，0.5.1 schema 拒绝该记录，导致 referenceChatHistory 不可用和 browse 404。未修改原数据；通过 `--patch` 覆盖到本工作树的独立 storage/session 目录后启动成功。
- DSH CLI 0.2.1-rc.2 + Playwright/Edge headless 实际加载宿主页面；合并插件响应包含本地 `lib/client.js` 的完整字节，避免误测其他分支。
- PASS：首页无 GIF 请求；5 张 GIF 逐页成功解码（960×600）；第 6 页纯文字；一次仅挂载一张图片且未预取后续卡片；关闭卸载、重开回到第一页。
- PASS：拦截远程图片请求模拟网络失败后，文字和翻页仍可用；解除拦截并点击重试后恢复图片。页面无未捕获异常。已查看正常与失败状态截图。
- 证据：`.codex-tmp/issue-15/web-ui-validation.json`、`web-card-1.png` 至 `web-card-6.png`、`web-image-failed.png`、`test-web-ui.mjs`。临时浏览器认证状态和含登录 URL 的 stdout 已清理。
- 初次自动化脚本误把宿主合并的全部插件响应与单个 client.js 比较，断言失败；改为检查响应包含完整本地字节后整套复测通过。原失败记录保留为 `web-ui-validation-initial-assertion.json`。
- 宿主账号余额请求有 HTTP 403；此次不使用账号模型额度，不将账号/对话端到端标为通过。
- 后续官方媒体通道迁移已加入 [Ideas 清单](../../ideas/README.md)。

未提交、未推送、未发布。主目录未提交开发内容未动。完整验收尚未完成：Desktop、干净安装/升级、真实 OMP 导入及内存对照仍未验证。
