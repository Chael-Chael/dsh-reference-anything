# 后续方案与待办

此清单记录后续评估项，不代表授权立即实施。

- [ ] **功能卡媒体迁移到 DSH 官方跨端资源通道**（Issue #15）：待 DSH 0.2.2 正式版发布后核实 Web/Desktop API、格式白名单及最低宿主版本；将当前 GitHub 固定提交 URL 替换为官方资源地址。若正式版仍不支持 GIF，先评估受支持的媒体格式，不直接假定 GIF 可用。保留当前卡片按需加载、失败提示与重试；验证离线展示、关闭/翻页释放、包体大小及运行时内存，对旧宿主明确兼容策略。当前实现和验证见 [任务记录](../development/tasks/issue-15-release-media.md)，媒体构建入口为 `scripts/release-features.mjs`。
- [引用协议重设计](reference-protocol-redesign.md)及[协议契约](reference-protocol-contract.md)。
- [网页 AI 引用改进](web-chat-reference.md)。
