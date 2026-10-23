# 待实现功能记录

记录日期：2026-10-20（Asia/Shanghai）。

状态：功能规划记录；各项进度分别标注，不自动启动开发。

1. **DSH 网页端记录访问**：使用 DSH 的 user token，在后台访问 DSH 网页端记录。
   - 2026-10-20 只读探测：针对 DeepSeek Chat（`chat.deepseek.com`）历史，使用本机官方账号存储中的 Platform grant，独立 Node 进程内存加载，未通过运行中 Host RPC 取得 token。agent-browser-test（3081）已确认运行，profile 无账号/凭据覆盖配置。Platform `/auth-api/v0/users/current` 使用 `x-dsh-auth-token` 返回 HTTP 200、code=0、biz_code=0；Chat `/api/v0/chat_session/fetch_page?count=1&lte_cursor.pinned=false` 分别使用 `Authorization: Bearer` 和 `x-dsh-auth-token`，均返回 HTTP 200、code=40003。当前直接复用路径失败，不能以 DSH 已登录推断网页历史可读。未读取正文、未发送消息、未改凭据或登录状态；未验证凭据交换接口及网页 userToken 路径。本结论不涉及 DSH 宿主自身会话。
2. **会话检查与重新扫描**：2026-10-20 已授权并实现来源卡片手动重扫与索引错误详情，内置扫描/解析快照更新到 Chat Import 0.26.2，新增 omp 来源；验收进度见本地 `.codex-tmp/tasks/agent-rescan.md`。这里检查来源发现与索引错误，不是全部正文完整性验证。
3. **GitHub 自动发布 npm**：通过 GitHub CI 自动发布 npm 包。
4. **Chat Import 合作**：向 chat import 仓库提出合作。
5. **按项目筛选与引用本地 Agent 对话**：支持根据项目筛选本地 Agent 对话，也支持通过 `@` 一次引用整个项目下的所有本地 Agent 对话。
