# Chat Import 0.26.3 来源集成

- 用户目标：升级 Agent 测试环境的 Chat Import，并将新增来源的扫描、只读引用集成到 Reference Anything。没有发布、推送或修改日常 Desktop 授权。
- 状态：实现完成；自动化及隔离 Web / Electron 菜单验收通过。不是完整发版验收。
- 当前工作树：`codex-issue-14-remote-boot`，保留既有 GIF、OMP、前缀兼容及发布素材整理改动；主目录未修改。
- 范围：内置解析/扫描快照升级至 0.26.3；Copilot VS Code、Copilot CLI、Doubao 的来源枚举、图标、配置及前缀；Chat Import 导入最低版本 0.26.3。扫描和引用仍无需安装 Chat Import。
- 安全与性能：只保留上游 preview/discovery；没有接入删除、回收站、隐藏等功能。豆包只接受具体 IndexedDB 库目录进行引用，拒绝目录中的非普通文件，按会话 ID 选择正文，记录子文件版本；背景可读性探测超过 8 MiB 保持 unknown。
- 测试：见累计报告 `docs/testing/releases/0.5.1-issue15-20261029.md` 最新节及 `.codex-tmp/chat-import-0263/`。
- 环境：agent-browser-test 的 package.json、pnpm-lock.yaml 与安装文件均为 0.26.3；旧插件保留在该 profile 的 `.plugin-manager/chat-import-0.26.2-before-0263`。隔离 Electron 使用本任务的 desktop-home，不修改日常 Desktop。
- 限制：豆包只有本地缓存正文，不能从服务端补齐。新来源实际产品账号的完整端到端模型回答、真实导入确认、跨平台及大库性能 NOT_RUN。标准 agent:verify 的日常 Desktop 同步因链接指向主目录而 BLOCKED，未绕过保护。
