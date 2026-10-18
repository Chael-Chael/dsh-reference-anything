# 会话正文可用性过滤

- 用户目标：所有本地 Agent 来源确认没有正文后隐藏；异常不误隐藏；不在输入路径全文解析；测试、构建并刷新 Web/Desktop。
- 范围：Reference Anything 共享发现入口、菜单、模型列表、设置计数；保留 Chat Import npm 0.26.1，无上游修改、无提交或发布。
- 状态：已实现并完成自动检查及 Web 冒烟。
- 入口：`src/conversation-availability.ts`、`vendor/chat-import-reader/availability-worker.mjs`；复用现有只读解析器。
- 行为：首次未检查条目可见；后台逐个检查，下次查询过滤已确认空条目。读取异常、解析丢失、未知结构保留。文件及 SQLite WAL/SHM 指纹变化使结论失效。Claude Desktop 只按精确 CLI ID 查找正文，找不到才隐藏。
- 性能：最多一个隐藏子进程，队列 128、缓存 2000；每项 15 秒，异常冷却 5 分钟。后台文本验证超过 8 MiB 保留 unknown，不限制原有引用读取。SQLite 摘要空消息检测只读查询。没有在每次输入时全文解析。
- 实际修正：首次用 Worker 验证真实大记录时出现 V8 OOM，导致测试宿主退出；已改为独立子进程，限制后台读取预算，异常/退出不影响宿主。修正后 Web 持续可用，Desktop 实际窗口正常。
- 自动证据：`.codex-tmp/agent-workflow/verify-1792254289019/`，1045 passed / 8 skipped，类型检查、build、双环境刷新通过。
- Red/break：隔离副本移除菜单过滤后，`.codex-tmp/availability-red/result.log` 准确捕获 empty 条目挤掉正常结果；工作区实现未回滚。
- 单测：18 项后台检查用例（空结构、损坏/未知、恢复、8 种 SQLite 来源），已有读取测试追加后台检查，验证正文/图片不被误隐藏；菜单与设置计数一致性测试。
- 本机验证：`local_e804b0d8…` 后台确认 empty；`3e7fcb34…` 仍可见。首次入队约 26 ms，随后入队小于 1 ms；这不是全量扫描性能基准。
- Web：3081 实际页面，Claude/Codex 分类并 Enter 插入引用通过；Trae 扫描错误仍提示；小pill标题查询无结果。未向模型发送消息。
- UI 证据：`.codex-tmp/availability-web/reference-inserted.png`、`scan-warning.png`。
- Desktop：重启后实际窗口可访问；用户正在使用，未操作其草稿或发送消息。
- 限制：首次结果可能暂时包含尚未验证的空条目；需再次查询应用后台结论。没有逐条读取本机全部历史会话。未知/超预算来源宁可保留，不猜测为空。网页对话仍按原有在线读取/账号边界，不以本地无缓存判空。
