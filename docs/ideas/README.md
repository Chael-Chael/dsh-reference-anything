# 后续方案与待办

此清单记录后续评估项，不代表授权立即实施。

- [ ] **功能卡媒体迁移到 DSH 官方跨端资源通道**（Issue #15）：待 DSH 0.2.2 正式版发布后核实 Web/Desktop API、格式白名单及最低宿主版本；将当前 GitHub 固定提交 URL 替换为官方资源地址。若正式版仍不支持 GIF，先评估受支持的媒体格式，不直接假定 GIF 可用。保留当前卡片按需加载、失败提示与重试；验证离线展示、关闭/翻页释放、包体大小及运行时内存，对旧宿主明确兼容策略。当前实现和验证见 [任务记录](../development/tasks/issue-15-release-media.md)，媒体构建入口为 `scripts/release-features.mjs`。
- [单一 reference 工具：最终设计](reference-single-tool.md)（2026-11-14 用户提出并定稿；同日已在工作区实施，typecheck 与 vitest 通过，真实 Web/Desktop 验收未做；取代协议契约的工具字段）。
- [引用协议重设计](reference-protocol-redesign.md)及[协议契约](reference-protocol-contract.md)。
- [网页 AI 引用改进](web-chat-reference.md)。
- [网页 AI 引用：Token 优先重设计与引用工具统一](web-chat-token-first.md)（2026-11-12 修改计划，待用户拍板后实施；取代上一项的流程与预算建议）。
- [合并 reference_image 与 reference_attachment_read](reference-attachment-merge.md)（2026-11-13 用户定方向：沿用 reference_image 结构改名 reference_attachment，一律返回 localPath，下载上限 50 MiB；2026-11-13 已实施，见[统一任务](../development/tasks/reference-attachment-unify.md)）。
