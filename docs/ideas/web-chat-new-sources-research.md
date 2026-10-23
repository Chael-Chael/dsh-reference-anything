# 豆包、千问国内版、Qwen 国际版：登录与历史读取调研

日期：2026-10-20（Asia/Shanghai）。范围：用户要求仅调研，凭据存储由另一个会话实现。本次没有接入生产适配器，没有发送消息、导入对话或保存 token/Cookie。

## 结论与建议顺序

| 顺序 | 独立来源 | 已实测的后台读取 | 尚未证明 |
| --- | --- | --- | --- |
| 1 | `qwen` — `chat.qwen.ai` | 仅 access token；账号、列表第 1 页 7 条、第 2 页空列表、一个正文样本均 HTTP 200 / success=true | token 过期刷新、项目/置顶/归档全集、长会话分页 |
| 2 | `qianwen` — `www.qianwen.com` | Cookie + 页面请求头；列表 41 条、会话信息和一个消息批次均 HTTP 200 / code=0 / success=true；next_token 续页成功但没有 data 字段 | 最小凭据集合、服务器账号身份校验入口、长会话与全部特殊来源 |
| 3 | `doubao` — `www.doubao.com` | Cookie + 页面请求头；列表首屏 20 条、会话信息、一个含 3 条消息的正文样本均 HTTP 200 / status_code=0 | 列表续页失败，不能宣称完整历史；长期凭据有效性与复杂内容解析 |

三者均可使用 OpenCLI 读取已有浏览器登录态，再由 Host 独立 HTTP 请求。只有 Qwen 本次证明了 **不携带 Cookie 的 access-token-only 请求**；另外两站不能简化成一个 `usertoken`。

Qwen 的请求在关闭本次创建的标签页后发出，但没有关闭用户整个浏览器。豆包、千问的 Node 请求没有通过页面 fetch 执行，测试时浏览器仍开着。以上是短时间探测，不是长期无人值守稳定性验收。

## 登录与账号范围

初次连接应打开各自官网，让用户在官网完成登录，OpenCLI 只复用该浏览器 profile。三个网站此次均已有账号和历史记录；没有退出账号或重新测试短信、扫码、第三方登录流程。

- **Qwen**：当前官网前端版本 `0.3.20`。access token 可从 `localStorage.qwen_access_token_state` 的 `token` 读取，兼容键为 `localStorage.token`；状态中还有 `expiresAt`。当前 Cookie 中有 HttpOnly `refresh_token`，没有 OpenCLI 旧实现所期待的 `token` Cookie。`GET https://auth.qwen.ai/api/v2/auths/` 携带 Bearer token 返回 `data.id`，可用于账号范围校验。
- **千问国内版**：观测到 HttpOnly 的 `tongyi_sso_ticket`、`tongyi_sso_ticket_hash`、`tongyi_guest_ticket`，以及 `XSRF-TOKEN`、`b-user-id` 等。API 请求另带 `X-XSRF-TOKEN`、`X-DeviceId`、`X-Platform`、`x-user-id`。本次复用原请求头和按 API 域过滤的 Cookie；没有逐项消融，不能断言这些字段全部必需。`b-user-id` 是设备侧标识，不能直接充当已验证的账号 ID。
- **豆包**：观测到 HttpOnly 的 `sessionid`、`sessionid_ss`、`sid_tt`、`sid_guard` 等，以及新版账号相关 Cookie；本次未缩减集合。`passport_csrf_token` 的存在不能证明登录，OpenCLI 自身源码也指出匿名会话会有该 Cookie。成功的 IM 响应包含 `downlink_body.*.user_id`，适配器应按服务器身份隔离数据，不以昵称或本地缓存作为身份凭证。

不要将凭据发送给模型、暴露到 RPC 返回或诊断日志。HttpOnly 表示页面 JS 不能读取，不表示经用户授权的浏览器扩展无法读取；本次使用 OpenCLI `Page.getCookies({url})`，没有读取浏览器磁盘数据库。

## Qwen 国际版

官网公开前端显示 API 基址为站点 `/api/v2`，账号服务为 `https://auth.qwen.ai/api/v2/`。

| 用途 | 请求 |
| --- | --- |
| 校验账号 | `GET https://auth.qwen.ai/api/v2/auths/` |
| 普通历史列表 | `GET https://chat.qwen.ai/api/v2/chats/?page=1&exclude_project=true` |
| 下一页 | 相同请求，`page=2` |
| 会话正文 | `GET https://chat.qwen.ai/api/v2/chats/{id}` |

实测请求头：`Authorization: Bearer <access_token>`、`Accept: application/json`、`Version: 0.3.20`、`source: web`，未携带 Cookie。未进行最小请求头消融。

列表在 `data[]`；正文在 `data.chat`，存在 `messages[]` 和 `history.messages` 图结构、`currentId`、`currentResponseIds`、`pagination`。样本 `messages[]` 有 2 条，图结构有 3 个节点：不能把所有图节点直接拼成当前分支。

公开前端还存在 `/chats/pinned`、项目列表及正文 `cursor/direction/limit` 参数，本次未完整测试。`exclude_project=true` 明确不是所有项目会话的全集。

前端的刷新入口是 `GET https://auth.qwen.ai/api/v2/auths/refresh`，使用跨域 Cookie；本次仅观察到官网调用及源码，不主动调用刷新接口。未来若只保存 access token，应在过期时要求重新连接；若要自动刷新，需要另行处理 refresh token 生命周期。

## 千问国内版

API 域：`https://chat2-api.qianwen.com`；官网前端版本 `4.10.7`。

| 用途 | 请求 | 主要结构 |
| --- | --- | --- |
| 历史列表 | `POST /api/v2/session/page/list` | 请求体：`limit`, `next_token`, `sort_field`, `need_filter_tag`；响应：`data.list`, `data.have_next_page`, `data.next_token` |
| 置顶 / 分组 | `POST /api/v1/session/top/list`、`POST /api/v1/session/group/list` | 已观察官网请求，未做全集验收 |
| 会话信息 | `POST /api/v1/session/get` | 请求体 `session_id` |
| 消息批次 | `GET /api/v1/session/msg/list` | 响应 `data.list[]`、`data.have_next_page` |

沿用官网请求中的设备、版本、语言等查询参数与请求头；不能将网站 Cookie 不加筛选地发送到其他域。

实测第一页 41 条且 `have_next_page=true`。将返回的 `next_token` 用于下一页，得到 HTTP 200、code=0、success=true，但没有 `data` 字段。解析器需要区分成功的空响应、认证错误和结构变化，不能仅看 HTTP 200。未验证更大账号的多页历史。

消息列表的一行是一个请求/回答批次，不是单条聊天消息：样本含 1 个批次、1 个 `request_messages` 元素、5 个 `response_messages` 元素。应按 `mime_type`、`content`、`meta_data` 等解析文本和非文本块，不能把 5 个回答块当作 5 轮 assistant 消息。长会话的游标、分支、附件未验收。

## 豆包

此次官网实际历史读取走 `www.doubao.com` 的 IM JSON 协议：

| 用途 | 请求 | 主要结构 |
| --- | --- | --- |
| 最近会话 | `POST /im/chain/recent_conv` | `uplink_body.pull_recent_conv_chain_uplink_body`；响应同名 downlink 中 `cells[]`, `next_conv_version`, `has_more` |
| 会话信息 | `POST /im/conversation/info` | `uplink_body.get_conv_info_uplink_body` |
| 会话正文 | `POST /im/chain/single` | **官网字段拼写为** `pull_singe_chain_uplink_body` / `pull_singe_chain_downlink_body` |
| 批量元数据 | `POST /im/conversation/batch_get` | `batch_get_conv_info_uplink_body` |

请求 envelope 包含 `cmd`、`sequence_id`、`channel`、`version`，请求头含 `Agw-Js-Conv` 等。首屏参数还区分项目、设备、归档、置顶等过滤条件。

正文请求包含 `conversation_id`、`anchor_index`、`conversation_type`、`direction`、`limit`、`option` 等。响应消息包含 `content`、`thinking_content`、`content_block`、`index_in_conv`，并有 `has_more`、`msg_cursor`、`regen_messages`。本次正文样本返回 3 条；非文本内容、重新生成分支和旧消息翻页仍需专门适配。

**续页未通过**：将返回的 `next_conv_version` 填回首屏请求的 `conv_version`，得到 HTTP 200 / `status_code=712010702`。尚未确定是游标类型、direction、其他参数还是请求时效问题。必须先捕获官网真实下一页请求并核对，不能按猜测继续全量扫描。

官网部分其他请求包含 `msToken`、`a_bogus`；此次成功复现的 IM 请求 URL 没有这两个参数。不能因此声称豆包所有接口不需要签名，也不应把 `msToken` 当成已验证的账号登录 token。

## OpenCLI 2.0.0 的复用边界

本机已安装包源码提供重要参考，但不能直接调用其命令作为完整历史适配器：

- `clis/qwen/auth.js` 校验 `chat.qwen.ai` 的 `token` Cookie 与旧 `/api/v1/auths/`；`clis/qwen/history.js`、`detail.js` 却操作 `www.qianwen.com`。两站必须拆成独立 provider。
- 国内版 `getSessionListFromApi` 仍发送 `page_num/page_size/page_no`，与此次官网的 `limit/next_token` 不同；其 `detail` 读取可见 DOM。
- `clis/doubao/history.js` 读取侧栏已加载条目，`detail.js` 读取已渲染消息；不能据此宣称所有历史和全部正文已覆盖。

建议复用 OpenCLI 的浏览器连接、临时页和登录态获取；分别实现三个 provider 的身份、列表、正文及分页解析。连接失败或账号变更必须显式返回错误，不切换到另一个登录账号。

## 证据与限制

- 官网公开源码：[Qwen 0.3.20 main.js](https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.20/js/main.js)。
- 本地 OpenCLI 2.0.0：`node_modules/@jackwener/opencli/clis/{qwen,doubao}/`。
- 脱敏实测报告：`.codex-tmp/qwen-host-read-report.json`、`new-chat-api-probe.json`、`new-chat-detail-probe.json`、`qianwen-pagination-probe.json`。仅保存返回结构、计数、状态；没有 token、Cookie 或正文内容。
- 本会话早先的 token 接入草稿已撤销；未改动其他会话的代码，没有新增依赖锁文件差异。
- 未执行生产 build、UI 接入验收或跨平台存储测试，因为当前范围仅为调研。未证明自动续期、完整历史、完整多模态或长期稳定运行。
