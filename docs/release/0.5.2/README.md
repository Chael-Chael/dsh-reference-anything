[中文](#cn-052) | [English](#en-052)

<h3 id="cn-052">新增功能</h3>

本版本基于 v0.5.1，扩展本地会话来源，修复功能卡 GIF 加载开销和官方引用前缀兼容问题。

- 新增 oh-my-pi、Copilot VS Code、Copilot CLI、豆包桌面版的扫描和只读引用，内置来源增至 33 种。输入 `@omp:`、`@copilot-vscode:`、`@copilot-cli:` 或 `@doubao:` 搜索并按 Enter 插入引用；扫描和引用无需安装 Chat Import。
- 豆包仅支持本地已缓存正文的对话；缺少的对话可先在豆包中打开后刷新，不会自动下载云端历史。

![四种新增来源的只读引用；使用虚构演示数据](demos/new-local-sources.gif)

### 体验优化

- 功能卡 GIF 改为打开当前卡片时按需访问远程地址，不再内联到客户端 JavaScript 或随 npm 包重复分发。首次观看需要网络；下载失败时可重试，网络不可达时不保证离线展示。

### 问题修复

- 官方 `ui-reference` 启用时，`@file:`、`@session:` 及对应自定义别名仍可限定搜索类别，并调用官方搜索接口；普通 `@` 查询继续由官方来源处理。

### 其他变更

- 内置扫描器与解析器更新至 Chat Import 0.26.3。导入功能需要安装并启用 0.26.3 或更新兼容版本，旧版会显示升级提示。
- 发布说明、功能卡与演示素材统一归档到 `docs/release/`。

<h3 id="en-052">New Features</h3>

Based on v0.5.1, this release adds local conversation sources and fixes feature-card GIF overhead and official reference prefix compatibility.

- Add scanning and read-only references for oh-my-pi, Copilot VS Code, Copilot CLI and Doubao Desktop, bringing the bundled catalog to 33 formats. Search with `@omp:`, `@copilot-vscode:`, `@copilot-cli:` or `@doubao:`, then press Enter to insert a reference. Scanning and references do not require Chat Import.
- Doubao supports only conversations with locally cached bodies. Open a missing conversation in Doubao and refresh; cloud history is not downloaded automatically.

![Read-only references from four new sources; synthetic demo data](demos/new-local-sources.gif)

### Improvements

- Load feature-card GIFs from remote URLs only when their card is opened, instead of embedding them in client JavaScript or duplicating them in the npm package. First viewing requires a network connection. Failed downloads can be retried; offline display is not guaranteed.

### Bug Fixes

- Keep `@file:`, `@session:` and their custom aliases working when the official `ui-reference` plugin is enabled, using official search APIs. Unscoped `@` queries remain handled by the official sources.

### Chores

- Update bundled scanners and parsers to Chat Import 0.26.3. Importing requires an installed and enabled 0.26.3 or compatible newer version; older installations show an upgrade prompt.
- Consolidate release notes, feature cards and demo assets under `docs/release/`.

Full Changelog: [v0.5.1...v0.5.2](https://github.com/Chael-Chael/dsh-reference-anything/compare/v0.5.1...v0.5.2)
