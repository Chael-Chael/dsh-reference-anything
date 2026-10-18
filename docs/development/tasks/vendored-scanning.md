# Vendored local conversation scanning

- 用户目标：扫描和引用无需安装 Chat Import；导入状态、导入和摘要仍使用 API；提供上游同步脚本，测试/build 后 Web 验收及 Desktop 同步。
- 范围：vendor 只读扫描快照、LocalAgentService/Remote、读取器调用、启动兼容入口、同步脚本/包文件、测试与中英文说明。不提交或发布。
- 保留既有脏工作区；不更改上游 Chat Import 仓库及用户源会话。
- 实现：复用上游 29 个来源扫描描述符及 SQLite 摘要读取器；独立子进程、30 秒缓存；目录/损坏异常保留 warning；现有正文可用性过滤仍生效。模型和菜单共用本地扫描服务。
- 兼容：已有相对路径引用与独立 local-agent 部署保留原读取/发现路径；UI 服务存在时使用 vendored 扫描。旧 runtime 导出保留为空入口，不再自动安装。
- API：按 format/sourcePath/sessionId 精确补充状态，异常/缺失时不显示状态；导入和摘要保持既有确认/归属校验。引用固定读取内置解析器。
- 更新：npm run vendor:sync -- <built-upstream-package>；生成两份快照和共享源哈希，校验补丁锚点、MIT 许可证与写入代码泄漏；正常构建不读取上游安装目录。
- 自动验证：verify-1792301081297 中 typecheck、1054 tests passed / 8 skipped、build 已通过。
- 自动同步脚本：首次等待 Web 就绪超时（启动约 74 秒），后续确认正常 HTTP 401 登录响应和页面可用。Desktop 主进程 54044 已于 13:25:24 重启并保持运行；测试 Web 为隔离 API 测试单独重启至 67092。最新位置已写 instances.json。
- Web PASS：测试 profile 中停用 Chat Import 并重启，Codex/Claude/WorkBuddy 分类均显示正确来源，Enter 均插入引用；API 不在时无导入状态。恢复 Chat Import 后状态重新出现，Tab 打开导入确认页。没有确认导入、生成摘要或发送消息，清空了新草稿，保留原 ColdFinal 会话草稿；恢复测试 profile 插件及原 bundles 顺序。
- Web 证据：`.codex-tmp/vendor-web/standalone-scan.png`、`codex-reference-disabled.png`、`claude-reference-disabled.png`、`import-confirmation.png`。
- 实盘集成：`.codex-tmp/vendor-real-check.log`，内置扫描/读取无插件 Context；Claude 54、Codex 69、WorkBuddy 2、opencode 21，分别成功读取前 3/3/2/3 条样本；Cursor 本机无记录；Trae 保留 TRAE_NO_SESSIONS 警告。这里记录的是原始扫描数，UI 另经正文可用性过滤。
- npm dry-run（ignore-scripts）确认两份 bundle、两个 worker、许可证、哈希清单均包含在包内；见 `.codex-tmp/vendor-pack.json`。
- 未验证：未执行实际导入/摘要生成；本轮 Desktop 仅同步构建/重启，按用户要求未做窗口交互。没有对全部 29 个来源做真实用户数据验收；目录表覆盖 29 来源、自动扫描样例覆盖 8 来源及损坏数据库，原有全来源正文/图片解析测试通过。
- 状态：已完成本地改动、测试/build、Web 验收和 Desktop 同步；未提交、推送或发布。
