# 网页 AI 引用：Token 优先重设计与引用工具统一

状态：调研与修改计划，尚未实施。2026-11-12 用户提出三项要求：网页来源以 token 通道为主；token 失效时先自动拉起页面重新获取，未登录则提醒用户，最后才回退到 OpenCLI 页面读取；把本地 Agent 的引用工具与接口搬到网页来源，让各插件逻辑统一。本文取代 [web-chat-reference.md](web-chat-reference.md) 的预算与流程建议（该文中"OpenCLI 实时获取正文"的前提已不成立）；工具字段仍以[协议契约](reference-protocol-contract.md)为准。

## 实施进度（2026-11-12）

用户于 2026-11-12 指示开始实现。已完成 P0–P2，P3–P6 未开始；未提交、未发布。

- **P0**：新增 `src/reference-documents.ts`（`DocumentSource` 接口）和 `ctx.references.registerDocumentSource`；四个工具按 `ref.source` 分派，本地 Agent 注册为第一个文档来源。原有本地测试全部通过，输出不变（只有一个来源时，list revision 与原来相同）。
- **P1**：`src/sources/web-chat/document.ts`。每次 load 都实时读取（token 优先），规范化为共享文档，revision 基于内容计算；`@` 网页引用在发送时生成内联预览（单条 8 秒上限），不再提示模型去调用 `external_*`；离线备份只在 `offline-mirror` 下、实时读取失败时使用，并带 notice。
- **P2**：`runner.tokenRequest` 收到 `PROVIDER_NOT_LOGGED_IN` 时，按 provider 单飞地从浏览器重新获取一次。只有身份与已保存的 accountScope 一致才写回并重试；账号不同返回 `account_changed`，不保存；未登录时 DeepSeek/Kimi 回退到 OpenCLI 页面读取；密钥库锁定不重取也不回退。
- **测试**：`npm run check` 1252 PASS、7 SKIP；新增 `tests/web-chat-document.spec.ts`（7 项），`tests/web-chat-token-store.spec.ts` 增加 4 项重取测试。
- **真实 Web 验收（agent-browser-test 3081，2026-11-12 20:44）**：
  - DeepSeek token 同步 PASS：124/124，无错误。
  - 从 `@` 菜单插入 "砂纸目数含义"（10 条消息），以仅可查看模式发送，pre-step 预览 PASS。会话日志显示：`ref` 为 `web:deepseek`，带 `conversationId` 和 12 位 account；预览包含最近 4 条正文（messageId 7–10，用户/助手交替），文本与直连读取的原文一致；`next=null`；元数据 `retainedMessages=4, truncated=true`；整个注入块 14,181 字节，在 16 KiB 以内；没有出现 `external_reference_read` 提示。
  - 模型回答核对 BLOCKED：该环境的模型路由是 `magpie / deepseek/deepseek-flash`，不是 DeepSeek 官方账号，返回 401 "api key invalid"；设置页显示官方账号余额为 −¥0.02。按规程不更换提供商，因此 `reference_read` 翻页和回答事实核对都未在真实模型上运行。
  - 模型回答复测（2026-11-13，用户指定模型 `DeepSeek-V4.1-Flash · WorkBuddy`，仅可查看）：提问"按顺序列出用户问过的每一个问题（从第一条开始），并列出最后一个回答里提到的命令"。
    - 注入块与上次相同：14,181 字节，messageId 7–10，`next=null`。
    - 命令部分 PASS：列出的 7 条命令都能在第 10 条原文中找到。
    - 问题列表 FAIL：原对话有 5 个问题，模型只列出 3 个。它把前 3 个问题（砂纸目数、镜片用多少目、直接用细砂）合并成一条，依据是第 8 条回答开头对历史的转述。
    - 模型全程 1 步，没有调用 `reference_read` 往前读。
    - 原因：预览从第 7 条开始，`next=null`。"尾部预览不含更早历史"只写在很长的系统说明里，预览数据本身没有标出前面还有消息。这违反了协议验证要求的第 2 条："尾部预览不得误报完整历史"。本地 Agent 预览也是同一实现，存在同样问题。
    - 会话：`session-be061273-88f6-4363-9a59-5d3fb5f9f0fa`。
    - 进一步排查发现：DeepSeek 的消息由带类型的片段组成，包括 `REQUEST`、`RESPONSE`、`THINK`、`TOOL_SEARCH`、`TOOL_OPEN`。读取脚本把所有片段拼成了正文，所以思考过程也混进了回答。例如第 2 条有 1,571 字思考，正式回答只有 538 字。第 8 条开头对前文的转述就来自思考过程，模型误以为已经知道前面的问题。
- **修复（2026-11-13，用户决定）**：
  - 思考过程默认不引用。DeepSeek 读取脚本按片段类型拆分：`REQUEST`、`RESPONSE` 和不带类型的片段算正文，`THINK` 单独放在 `thinking` 字段，`TOOL_*` 丢弃。设置页新增"引用时包含思考过程"，默认关闭；开启后思考过程以 `<thinking>…</thinking>` 包起来放在回答前面。离线备份只保存正文。
  - 预览新增 `total`（消息总数），位于 `revision` 之后、`items` 之前；系统说明里对应的那句改为：第一条 `messageId` 大于 1 时，先读更早的消息，再回答涉及全部历史的问题。本地与网页共用这段代码。
  - P6 提前：网页对话不再出现在 `external_reference_list` 中；`external_reference_read` 遇到网页对话的 URI 时，提示改用 `reference_read`；两个工具的说明改为只覆盖导出记录、云盘文档和第三方来源。网页来源的 `maxReadTurns` 设置及其 `readLimit` 已删除，设置页中原来的位置换成思考过程开关。`external_*` 工具本身仍保留，因为云盘和第三方来源还在使用（是否迁移见 §9）。
  - 已知缺口：浏览器 DOM 兜底读取（只在接口读取失败时使用）读的是页面上显示的文字，可能仍包含展开的思考过程。Kimi、Qwen、千问、豆包是否也有思考内容混入正文，尚未核实。
  - 测试：`npm run check` 1256 PASS、7 SKIP，build 成功，已执行 `agent:sync -- all`。新增测试覆盖：DeepSeek 片段拆分；默认不含思考、开启后包含；尾部预览的 `total`；网页对话不进入 `external_*`；设置开关的默认值与保存。
  - 真实复测 PASS（3081，WorkBuddy DeepSeek-V4.1-Flash，仅可查看，同一问题，`session-4aaa48e9-c5a8-493d-906c-b2a51ba5890a`）：
    - 注入块从 14,181 字节降到 8,135 字节，10 条消息全部放进预览（`total: 10`，`next: null`），正文里没有思考内容；
    - 5 个问题全部按顺序答对，6 条命令都能在第 10 条正文中找到；
    - 上次答案里多出的 `curl.exe`、`nslookup` 只出现在思考过程中，这次没有再出现；
    - 本轮因为整段都放进了预览，没有调用工具，所以尾部预览加 `total` 的效果只有单元测试覆盖，没有在真实环境验证。
  - 尾部预览真实验证 PASS（2026-11-13 13:14，用户指定对话"2025年MCM可持续旅游管理问题"，16 条消息，正文约 2.1 万字，`session-202b4fc0-9750-4799-b4e0-fbe920513794`）：
    - 预览只放得下第 10–16 条，`total: 16`，`next: null`。
    - 模型自己写道："The reference shows 16 total messages but the listing starts at messageId 10, so I need to read the earlier messages first"。
    - 随后两次 `reference_read`：第一次从头读到第 6 条中间；第二次照抄 `next`（`messageId 6, textOffset 402`），读到第 12 条。两页各 16,384 字节，没有遗漏。
    - 回答核对 PASS：7 个后续问题的顺序和内容与原文一致；题目要点（3 万居民、2023 年 160 万邮轮乘客、最多 7 艘邮轮和 2 万游客、3.75 亿美元、冰川自 2007 年后退约 8 个足球场、25 页、一页备忘录、AI 使用报告）都能在第 1 条原文中找到；正确指出第 16 条只有"超出深度思考最大长度"的提示，最后一个问题没有得到回答。
  - ref 透传与来源命名（2026-11-13，用户决定，不兼容旧名称）：
    - 四个工具的 `ref` 声明只保留 `source`，其他字段由模型照抄，各来源的 `parseRef` 严格校验。
    - 本地来源对模型改名为 `local:<agent>`；内部定位仍用不带前缀的名称。
    - `DocumentSource` 新增 `category`，注册时类别重复即报错。
    - 规则写入[接入第三方来源](../development/third-party-source.md)。
    - `npm run check` 1259 PASS。
  - 真实复测（3081，WorkBuddy Flash，仅可查看）：
    - 本地 Agent（Claude Code 会话，47 条，`session-630879ba…`）：ref 为 `local:claude`，`total: 47`，预览覆盖第 10–47 条，命名 PASS。模型没有往前读，"最初要求"是根据标题（即第 1 条正文）作答的，内容与标题一致，但没有经过读取验证。
    - 网页回归第 1 次（MCM，问"第 3 条和第 5 条消息分别要求做什么"，`session-8afb7a91…`）：模型第一次只传了 `{"source":"web:deepseek"}`，被 `INVALID_ARGUMENT` 拒绝，下一步改传完整 ref，结果正确。这是透传带来的回退：声明只写了 `source`，模型就只填了它。已把 `ref` 说明改为"整个对象连同所有字段照抄，只有 source 不够"，两个来源的报错也改为提示照抄整个 ref。
    - 网页回归第 2 次（修改后，同一问题，`session` 13:40）：模型没有调用任何工具，把问题理解成"第 3、第 5 个用户问题"，并编造了用户消息编号（3、9、11、13、15；实际是 1、3、5……15）。回答 FAIL。修改后的 ref 说明没有被触发，所以没有验证到。
    - 小结：到目前为止 4 次测试中，有 2 次模型没有按 `total` 往前读，其中 1 次因此答错。尾部预览的遵守情况不稳定，还需要另想办法。
  - 设置页开关的浏览器目视检查 NOT_RUN：浏览器面板处于隐藏状态，插件列表不渲染；改为由组件测试覆盖。开关文案等待用户审核。
  - token 失效后自动重取：真实环境 NOT_RUN（需要用户在浏览器退出 DeepSeek）。

与计划的差异：

- 凭据状态暂存在内存中（`credentialStateList()`），P4 设置页需要时再落到 store 表。
- 网页文档来源与本地一样，不再要求每个任务单独授权：读取时检查来源开关、本地索引和账号前缀。`@` 提及仍会写入授权，旧的 `external_reference_read` 继续可用。
- 新契约只暴露图片；网页会话里的非图片附件暂时无法通过新工具读取（P1 已知缺口）。

架构图（archify 生成，位于被 git 忽略的 `.codex-tmp/archify/`）：

- 网页对话引用（修改后）：`web-chat-token-first.html`
- 本地 Agent 引用（统一后）：`local-agent-reference.html`

## 1. 调研：GitHub `magpie-plugin` 标签项目

2026-11-12 用 `gh search repos --topic magpie-plugin` 列出 300 个项目，其中绝大多数是模型网关的供应商、额度、签到插件。下表是与"保存网页登录凭据、直接调用网页端接口"相关的 15 个，均浅克隆后读过源码，没有运行。Magpie 是模型网关，这些插件的目标是"用网页账号发消息"，不是"读取历史会话"。可以借鉴的是凭据的获取、保存、续期和失效处理，不是它们的对话协议。

| 项目 | 平台 | 凭据形态与获取 | 值得借鉴 |
| --- | --- | --- | --- |
| [mu-zi-lee/magpie-deepseekweb2api](https://github.com/mu-zi-lee/magpie-deepseekweb2api) | DeepSeek | 手填 `userToken`，多账号池 | 401/403 或 `signIn: "expired"` 时停用该账号；其他错误按指数退避冷却，上限 10 分钟 |
| [volcanicll/magpie-deepseek-web-auth](https://github.com/volcanicll/magpie-deepseek-web-auth) | DeepSeek | 离线扫描各浏览器 profile 的 Local Storage leveldb，找出 `userToken` 候选，逐个向 DeepSeek 验证 | 先取候选再用身份接口确认；**不采用**离线读其他 profile 文件的做法（见 §1.2） |
| [JohnWangggg/magpie-muse-web](https://github.com/JohnWangggg/magpie-muse-web) | muse.ai | 用临时 profile 弹出可见窗口登录，通过 CDP `Storage.getCookies` 拿到 httpOnly Cookie | 宿主只保存 handle，密钥留在引擎；记录每个 Cookie 的到期时间；`refreshLead` 提前续期；续期被拒才标记 `signIn: "expired"`；登录超时 15 分钟 |
| [guanwenpeng2001-bot/magpie-chatgpt-web](https://github.com/guanwenpeng2001-bot/magpie-chatgpt-web) | ChatGPT | Playwright 持久化 profile；用长期有效的 `next-auth.session-token` 换取短期的 `/api/auth/session` `accessToken` | 两级凭据：长 session 换短 access；把响应里的 `Set-Cookie` 轮换写回；交互场景才回退到浏览器 |
| [mu-zi-lee/magpie-chatgptweb2api](https://github.com/mu-zi-lee/magpie-chatgptweb2api) | ChatGPT | Playwright 隔离 profile，或导入 Cookie | 同上；`/api/auth/session` 是标准续期入口 |
| [mu-zi-lee/magpie-claudeweb2api](https://github.com/mu-zi-lee/magpie-claudeweb2api) | Claude | `sessionKey` Cookie，自动补 `anthropic-device-id` | 只需一个长期 Cookie；错误信息不带响应体、URL 和 Cookie |
| [BUKOWSKIREAL/magpie-gemini-web](https://github.com/BUKOWSKIREAL/magpie-gemini-web) | Gemini | 粘贴 Cookie，或导入浏览器 Cookie；必需 `SID/HSID/SSID/APISID/SAPISID/__Secure-1PSID` | 列出 Gemini 必需的 Cookie 集合，按域名过滤 |
| [weizsw/magpie-venice-web](https://github.com/weizsw/magpie-venice-web) | Venice | Clerk 长 session 换短 JWT；解析 `exp`，到期前 15 秒续期 | 每个账号加锁串行续期；校验 `expectedUid`，换了账号就按 401 处理 |
| [resucdueff/magpie-notion](https://github.com/resucdueff/magpie-notion) | Notion | 读浏览器 Cookie 库（DPAPI/Keychain 解密）或调试端口 | 对 Chrome v20 应用绑定加密的值只报告、不猜测，然后回退到手动粘贴 |
| [mu-zi-lee/magpie-doubao-translate](https://github.com/mu-zi-lee/magpie-doubao-translate) | 豆包 | Cookie 直连 | 与本项目豆包请求模板思路一致 |
| [niyoh120/magpie-dumate-enterprise](https://github.com/niyoh120/magpie-dumate-enterprise) | 百度搭子 | 用 Cookie 换租户 `user_token` | 两级凭据换取 |
| [Betsy20/magpie-Jet-Hub](https://github.com/Betsy20/magpie-Jet-Hub) | 29 家聚合 | CDP 读 Cookie、静默刷新、账号池 | 统一的凭据层抽象（规模大，只参考结构） |
| [Gruu6y/magpie-clean-login](https://github.com/Gruu6y/magpie-clean-login) | 通用 | 每个账号一个独立浏览器身份 | 登录环境隔离 |
| [Sliverkiss/magpie-mimo2api](https://github.com/Sliverkiss/magpie-mimo2api) | 小米 MiMo | 手机号登录换会话 | `signIn: "expired"` 的使用方式 |
| [MYCF711/magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold) | 模板 | — | `HOOKS.md` 记录了宿主契约：`refreshLead`；续期串行化（请求最多等 15 秒）；`expires` 为 0 时不续期；`signIn: expired / kept / renewed` 三态；按账号而不是按供应商标记失败 |

另外查了 `LLM-Red-Team/*-free-api` 系列（Kimi/DeepSeek/Qwen/豆包反代），四个仓库都已返回 404，不作为依据。

### 1.1 归纳出的共同做法

1. **凭据分两级**：长期 session（Cookie 或 refresh 能力）用来换取短期 access token。短期 token 过期时优先用长期 session 静默换新，长期 session 也失效时才需要登录。
2. **主动续期**：记录到期时间（JWT 的 `exp` 或 Cookie 的 `Expires`），提前续期；每个账号同时只允许一次续期，其他请求等它完成。
3. **失效分级**：认证被拒的账号停用，等用户重新登录；限流和 5xx 只冷却后重试；与认证无关的 401 不当作登录失效。
4. **身份核对**：续期或重新获取到的凭据，必须与已保存的账号身份一致，不一致按失效处理，不能悄悄换成另一个账号。
5. **轮换写回**：响应中的 `Set-Cookie` 更新要写回持久存储，否则下次会用到旧值。这些插件大多用独立 profile，自己就是凭据的主人；本项目复用用户浏览器的登录态，主人是浏览器，所以**不照搬**这一条，见 §4.5。
6. **最小暴露**：错误信息不带 URL、响应体或凭据；宿主只看到 handle（本项目已经是 UUID + OS 密钥库，比这些插件的明文 JSON 文件更严格）。

### 1.2 明确不采用

- **离线读取浏览器 profile 文件**（Local Storage leveldb、Cookie 库 + DPAPI）：会读到用户其他 profile 和其他站点的数据，超出"只读当前选中 profile、当前站点"的边界；Chrome v20 应用绑定加密也让这条路越来越不可靠。继续只用 OpenCLI Page API，在用户选中的 profile 里打开当前站点读取。
- **用临时 profile 弹窗让用户重新登录**：本项目的约定是复用用户自己浏览器的登录态，不另建一个登录环境。
- **多账号池与故障切换**：引用场景要求"这条会话属于哪个账号"，不能换一个账号去读。

## 2. 目标与第一性原则

- **一个来源，一条读取链**：token 直连 → 自动重新获取 → 提醒登录 → OpenCLI 页面读取兜底。每次读取都由同一个通道解析器决定走哪条路，同步、@ 预览和工具补读都调用它。
- **一个引用契约**：本地 Agent、网页对话（以及后续的云盘和第三方来源）都用 `ref → revision + items + next`，同一组工具，同一套 pre-hook 预览预算。来源只负责"列出"和"把一条会话加载成规范化文档"，分页、搜索、预算和渲染都在核心实现一次。
- **不新增**：句柄注册表、跨调用的正文缓存、虚拟文件系统、旧参数兼容层。

## 3. 统一引用契约（从本地 Agent 搬过来）

### 3.1 来源接口

把 `src/local-reference.ts` 中与来源无关的部分（`readLocalPage`、搜索、`buildLocalPreview`、`renderLocalData`、预算计量）移到新文件 `src/reference-document.ts`。来源实现一个小接口：

```ts
interface ReferenceDocumentSource {
  readonly id: string                       // 也是 ref.source 的取值或前缀
  readonly refSchema: z.ZodType<ReferenceLocator>   // 来源自有的可读定位，严格校验
  list(input: { query: string; from?: { index: number }; maxItems: number }, signal): Promise<{ items: { ref; title }[]; listRevision: string; notice?: string }>
  load(ref, revision: string | undefined, signal): Promise<ReferenceDocument>  // 每次都重验开关、权限、账号
  image?(ref, revision: string, imageId: number, signal): Promise<ImageBlock>
}
interface ReferenceDocument {
  revision: string                          // 规范化内容的指纹
  messages: { role: 'user' | 'assistant' | 'summary'; text: string; images?: number[]; tools?: number[] }[]
  tools: { messageId?: number; kind: 'call' | 'result' | 'record'; name?: string; text: string }[]
  images: { messageId?: number; name?: string }[]
  notice?: string                           // 来源确实不完整时
}
```

本地 Agent 的 `loadLocalReference` 改为实现这个接口，行为不变。网页对话新增 `WebChatDocumentSource`。`ReferenceSource`（旧的 window 读取接口）保留给尚未迁移的云盘和第三方 SDK 来源。

### 3.2 工具：四个通用工具

| 工具 | 变化 |
| --- | --- |
| `reference_list` | `source` 可以是具体来源（`codex`、`web:deepseek`），也可以是分组（`local`、`web`）；返回的 `ref` 由来源定义 |
| `reference_read` | 参数不变；不支持的 part 返回 `UNSUPPORTED_PART`（网页来源目前没有工具记录） |
| `reference_search` | 不变，对加载后的文档做字面搜索 |
| `reference_image` | 不变，由 `source.image()` 返回真实图片块 |

网页来源的 ref：

```jsonc
{ "source": "web:deepseek", "conversationId": "c-123", "account": "3f9a1c2e" }
```

`account` 是账号范围 hash 的前 8 位，用于发现"当前登录的不是这个账号"，不是凭据。完整 hash 留在本地索引里。

网页来源迁移后，`external_reference_list/read` 只剩云盘和第三方 SDK 来源使用；等它们也迁移后删除（另行排期）。`reference_attachment_read`（非图片附件落盘）在本计划内保持不变；它与 `reference_image` 的合并见[合并方案](reference-attachment-merge.md)。

### 3.3 pre-hook

网页 @ 引用不再走"延后，提示模型调用 external 工具"的路径，而是和本地引用一样：在共享的 `maxTextBytes`（16 KiB）预算内生成最近连续正文的预览，带上 `revision`/`next`。网页读取比本地文件慢，所以 pre-hook 对网页来源设单独的截止时间（建议 8 秒）。超时就给这条引用输出"未加载"的 notice，不阻塞整批引用。

### 3.4 revision 与正文缓存

- revision = 对有效分支、规范化后的 `role/text/图片名` 计算的 SHA-256。不包含获取时间和临时签名 URL。
- 不做跨调用的正文缓存：每次 read/search 都重新 `load`。token 直连单次约百毫秒到 1 秒，可以接受；多页补读时实测总耗时，如果超标，再评估"同一 revision、60 秒、仅内存"的缓存，并单独请用户确认。
- 用户在网页上继续聊天后 revision 会变，返回 `REVISION_CHANGED`，模型从头重读。这与本地文件的行为一致。

## 4. 通道解析与凭据生命周期（网页来源核心）

### 4.1 读取链

```
read(provider, op) ─► CredentialState?
  ├─ connected / expiring ─► TokenClient ──ok──► 返回
  │                              └─ 认证失败(401/403/业务码) ─► renew()
  ├─ renew(): 单飞，同一 provider 只跑一次，其他请求最多等 20s
  │     ├─ 浏览器桥可用 ─► Page API 后台标签打开站点 ─► 抽取凭据 ─► identity()
  │     │       ├─ 同一账号 ─► 写回密钥库，状态 connected ─► 重试原请求一次
  │     │       ├─ 另一个账号 ─► 状态 account_changed，不覆盖，提醒用户
  │     │       └─ 未登录 ─► 状态 needs_login，提醒用户去浏览器登录
  │     └─ 浏览器桥不可用 ─► 状态 needs_login（原因：浏览器未连接）
  └─ 无 token 客户端 / needs_login 且浏览器桥可用 ─► OpenCLI 适配器页面读取（旧路径，标记 channel=browser）
```

- **自动重新获取**是用户这次明确要求的行为，取代了 [token 接入记录](../development/tasks/web-chat-token.md)中"不实现静默续期"的决定。它只复用现有的捕获流程（用户选中的 profile、后台标签、用完关闭），不保存 refresh_token，也不读取浏览器文件。
- **不主动续期**（用户 2026-11-12 决定）：只有请求认证失败时才触发 `renew()`。能解析出到期时间时，只用来在卡片上显示"即将过期"，不据此打开浏览器标签。
- **兜底的边界**：兜底读取必须核对同一个 `accountScope`；浏览器里登录的是另一个账号时，按 `REFERENCE_ACCOUNT_MISMATCH` 失败，不能读出别人的会话。
- **错误分级**（参照 magpie）：认证失败 → 进入 renew；429 → 这个 provider 冷却，指数退避，上限 10 分钟；5xx 和超时 → 原请求重试一次后失败；密钥库锁定 → `keyring_locked`，与登录失效分开提示。

### 4.2 凭据状态

不含任何密钥，存放在 store 的新表 `credential_states` 中（不放进用户可编辑的 settings）：

| 状态 | 含义 | 卡片主操作 |
| --- | --- | --- |
| `connected` | 最近一次 token 请求成功 | 断开 |
| `expiring` | 已知还剩不到 1 天（仅提示） | 立即刷新（用户手动） |
| `renewing` | 正在后台重新获取 | — |
| `needs_login` | 浏览器未登录或浏览器桥不可用 | 打开登录页 / 重新连接 |
| `account_changed` | 浏览器换了账号 | 改用新账号（需确认）/ 保持 |
| `keyring_locked` | 系统密钥库不可用 | 重试 |
| `browser_only` | 该平台还没有 token 客户端 | 无（走 OpenCLI） |

字段：`state, channel, expiresAt?, lastOkAt?, lastError?{code, at}, cooldownUntil?`。

### 4.3 凭据形态统一

密钥库条目的值统一为 `{ kind, accountScope, capturedAt, expiresAt?, secret }`。`kind` 取值：

- `bearer`：DeepSeek、Kimi、Qwen（现有）
- `request-template`：千问、豆包（现有）
- `cookie-session`：ChatGPT、Claude、Grok、Gemini（新增）。必需 Cookie 集合按平台白名单过滤。**不接受 `Set-Cookie` 轮换**：收到轮换就视为本地副本已过期，改为从浏览器重新获取（§4.5）。ChatGPT 额外用 `/api/auth/session` 换短期 `accessToken`，只保存在内存中；这个接口本身是否会触发轮换，需要实测确认。

分片存储（`credentialEntry`）沿用。Cookie 类凭据的权限比只读 token 大，需要在 [NOTICE](../../NOTICE.md) 和设置页说明。

### 4.4 各平台接入顺序

| 平台 | 现状 | 计划 | 风险 |
| --- | --- | --- | --- |
| DeepSeek、Kimi、Qwen、千问、豆包 | token 客户端已有 | 接入通道解析器和自动重新获取 | 低 |
| ChatGPT | 仅 OpenCLI | `cookie-session` + `/api/auth/session`；列表 `/backend-api/conversations`，详情 `/backend-api/conversation/{id}`（按当前节点祖先链取有效分支，复用适配器解析） | 中：Cloudflare 校验和 Cookie 轮换 |
| Claude | 仅 OpenCLI | `sessionKey`，先取组织 ID，再读会话列表和详情 | 中 |
| Grok | 仅 OpenCLI | Cookie 会话；接口需实机抓包确认 | 中高 |
| Gemini | 仅 OpenCLI | Cookie 集合 + 页面 `SNlM0e` token，走 `batchexecute`；`__Secure-1PSIDTS` 需要轮换 | 高：放到最后，继续保留 OpenCLI 兜底 |

每个新平台都单独做真实账号的只读验证；验证通过之前保持 `browser_only`。

### 4.5 账号竞争：不能把用户浏览器挤下线

复用登录态意味着插件和用户的浏览器在共用同一个会话。插件这边的任何操作，都不能让浏览器那边的会话失效。会造成竞争的机制有以下几类，目前都**未实测**：

| 机制 | 怎么会挤掉浏览器 | 设计规则 |
| --- | --- | --- |
| refresh_token 轮换 | 插件用 refresh_token 换新 token 后，服务端作废旧 refresh_token；浏览器下次续期失败，被登出 | 插件**永不使用** refresh_token。这也是 §9 第 2 项默认不保存它的主要理由 |
| Cookie 轮换 | 插件请求收到新的 `Set-Cookie`（如 Gemini 的 `__Secure-1PSIDTS`），旧值被作废，浏览器手里的旧 Cookie 失效 | 浏览器是唯一权威，插件不接受轮换、不写回；收到轮换就当副本过期，从浏览器重新获取。对频繁轮换的平台，改为在页面内执行请求（OpenCLI 后台标签里 `fetch`，凭据不离开浏览器），不复制 Cookie |
| 单会话 / 设备上限 | 平台限制同时在线的会话数或设备数，插件被识别成新设备后挤掉旧会话 | 只复制浏览器现有的凭据，从不发起登录；如果实测某平台把复制使用识别成新设备，该平台退回页面内执行 |
| 风控 | 同一 token 同时从浏览器和 Node（UA、TLS 指纹不同）发出，可能触发异常登录提醒或风控 | 只读接口，低频；请求头尽量与浏览器一致；遇到风控信号（验证码、安全提醒）立即停用该通道并提醒用户 |
| 自动重新获取 | 打开后台标签时，页面自己的脚本可能刷新 token | 这是浏览器自己在续期，不会造成竞争；插件随后读到的就是新值 |

原则：**插件只读取浏览器的凭据，从不主动续期、轮换或登录**。真正的续期只发生在浏览器里，包括插件自动打开的后台标签。

**短时实测（2026-11-12，只读探针 `.codex-tmp/contention/probe.mjs`，10 轮 × 30 秒，报告中只有指纹）**：

| 平台 | 插件直连 | 浏览器之后 | 浏览器 token / Cookie | 服务端向插件下发的 `Set-Cookie` |
| --- | --- | --- | --- | --- |
| DeepSeek | 10/10 | 仍登录 | 均未变化 | `HWWAFSESID`、`HWWAFSESTIME`（华为云防火墙） |
| Qwen | 10/10 | 仍登录 | 均有变化（多半是页面自身刷新，本测试无法完全区分） | `acw_tc`（阿里云防火墙）、`x-ap` |
| 豆包 | 10/10 | 仍登录 | Cookie 有变化 | `bd_sso_hi3jfd`（与 SSO 相关，需长测） |
| Kimi | 10/10 | 仍登录 | 均未变化 | 无 |
| 千问 | 10/10 | 仍登录 | Cookie 有变化（探针检测登录时自己会在页面里导航，多半是这一步引起的） | 无 |

Kimi、千问首轮被误判为未登录：探针等待新标签页加载不足，且千问的跨域身份检查不可靠。改用插件自己的捕获流程判断后重测，即上表结果。

结论：五个平台在 5 分钟内都没有出现挤掉浏览器的情况。24 小时长测、在浏览器退出登录、新设备提醒仍未覆盖，豆包和 Qwen 优先长测。

**用户决定（2026-11-12）**：先实测登录竞争。如果某平台实测会把用户浏览器挤下线，该平台改为插件使用**单独的浏览器 profile** 登录（用户在其中登录一次，插件独占这套会话，和用户日常浏览器互不影响）；此时插件是凭据的主人，Cookie 轮换写回、refresh_token 等做法才可以采用。实测结果记录在本节下方。

## 5. 同步：从正文同步改为元数据同步

- 默认 `historyMode=metadata-only`（现在已是默认值）。同步只拉列表元数据：标题、更新时间、链接、账号范围。正文在引用时实时 `load`。
- 同步分成两条通道：
  - **token 通道**：只包含 `connected`/`expiring` 的平台，默认每 5 分钟一次。
  - **浏览器通道**：保留现在的周期。
  - 两条通道各自维护运行中状态，互不阻塞；删除、清空这类操作要求两条都空闲。
- 打开 @ 菜单时，对 token 平台在后台跑一次只取第一页的增量（5 秒截止），菜单先用本地索引显示。
- 连接成功后，立即对该平台跑一次首次同步。
- `offline-mirror` 改名为"离线备份正文"，默认关闭。开启后，读取链在实时读取失败时，可以回退到本地备份，并输出 notice：`Offline copy from <syncedAt>; the live conversation could not be read.`。

## 6. 设置页重设计（网页对话分区）

从上到下：

1. **账号卡片网格**（主体）：每个平台一张卡片，显示状态徽章（直连 / 即将过期 / 需登录 / 账号已切换 / 仅浏览器）、账号显示名（平台提供的昵称，或 hash 前 8 位）、会话数、上次刷新时间、启用开关。主按钮随状态变化（连接、重新连接、打开登录页、确认切换）；断开放进次要菜单。
2. **刷新设置**：自动刷新列表（token 账号的分钟数）、历史天数、离线备份正文开关。删除 `maxReadTurns`，读取量由全局 `maxTextBytes`/`maxItems` 控制；`detailConcurrency` 移到"高级"里。
3. **浏览器通道（连接与兜底）**：折叠区。放现在的 OpenCLI / 浏览器桥 / 扩展 / 适配器检查清单和 profile 选择。只有在首次连接、自动重新获取或兜底需要时才展开并提示。
4. **存储管理**：保持不变。

文字须经用户审核（AGENTS 发布素材规则）；UI 实现前按 [design.md](../../design.md) 出一张静态稿给用户确认。

## 7. 修改清单

| 阶段 | 范围 | 主要文件 | 完成标准 |
| --- | --- | --- | --- |
| P0 契约抽取 | 把分页、搜索、预览、渲染提取成与来源无关的核心；本地 Agent 改为实现 `ReferenceDocumentSource` | 新 `src/reference-document.ts`；`local-reference.ts`、`local-reference-tools.ts`、`reference-prestep.ts`、`types.ts` | 本地 Agent 的现有测试全部通过，输出逐字节不变 |
| P1 网页文档 | 把 provider 的详情行规范化成 `ReferenceDocument`；计算 revision；提供图片；四工具分派；pre-hook 预览；网页来源不再走 `external_*` | `sources/web-chat/document.ts`（新）、`index.ts`、`attachments.ts`、`tool.ts`、`local-locator.ts` → 通用 locator | 连续补读无漏字；搜索命中可直接用于读取；账号切换后拒绝读取 |
| P2 通道与凭据 | 通道解析器、单飞 renew、状态表、错误分级、兜底读取的账号核对 | 新 `src/web-chat-channel.ts`；`web-chat-token*.ts`；`opencli.ts`（删除 `tokenRequest` 钩子，改为由解析器调用）；`store` | 401 → 自动重新获取 → 重试成功；未登录 → `needs_login` 并提醒；无浏览器 → 兜底失败时错误明确 |
| P3 同步通道 | 元数据同步；两条通道；@ 打开时刷新；连接后首次同步；离线备份回退 | `sync/index.ts`、`sources/web-chat/index.ts` | token 通道不被浏览器通道阻塞；5 分钟周期实测 |
| P4 设置页 | 第 6 节布局与状态徽章 | `client/components.tsx`、`styles.ts`、`locale.ts`、`index.ts` | 浏览器验收截图；文字由用户审核 |
| P5 新平台 | ChatGPT → Claude → Grok → Gemini，逐个接入 `cookie-session` | `web-chat-token.ts` 拆成按平台的客户端 | 每个平台真实只读验证，测试凭据最后删除 |
| P6 清理 | 删除网页来源对 `external_*` 和 `maxReadTurns` 的依赖；更新子系统地图、README、NOTICE | docs、README | `npm run check` 通过，双环境验收 |

P0 → P1 → P2 是串行依赖；P3 和 P4 可以在 P2 之后并行；P5 每个平台相互独立。

## 8. 验证

- **读取链**：用伪造的 fetch 覆盖 200、401、业务认证码、429、5xx、超时、取消；renew 时浏览器的五种情况（同一账号、另一账号、未登录、浏览器桥离线、标签超时）；并发 10 个读取只触发一次 renew。
- **契约**：本地 Agent 输出与重构前逐字节一致；网页文档在中文、emoji、超长消息下补读能还原原文；图片像素确实到达模型（direct 调用和 run_code 两条路径）。
- **安全**：关闭来源后旧 ref 不能读；`account` 不匹配时拒绝；密钥库不可用时不落明文；错误信息里没有 token、Cookie 或 URL 参数；兜底读取不跨账号。
- **账号竞争（逐平台实测）**：插件连续直连读取 24 小时（包括多次自动同步）后，浏览器是否仍然登录、是否收到异常登录或新设备提醒；浏览器和插件同时使用时，两边是否都正常；插件自动重新获取之后，浏览器是否正常；记录每个平台的响应是否带 `Set-Cookie` 轮换；在浏览器里退出登录后，插件手里的副本是否随之失效（服务端是否真正作废会话）。任何平台出现浏览器被挤下线，该平台改用页面内执行或保持 `browser_only`。
- **真实验收**：DeepSeek、Kimi 走完一遍"手动让 token 失效 → 自动重新获取 → 读取成功"；在浏览器里退出登录 → 卡片显示需登录 → 重新登录后恢复；按 [发版规程](../testing/npm-release-checklist.md) 做 Web 验收；macOS/Linux 原生密钥库标记为 NOT_RUN。

## 9. 需要用户拍板

1. ~~**主动续期**~~：已决定（2026-11-12），只在请求失败后重新获取。
2. **refresh_token**：如果 Kimi 等平台的页面里有 refresh_token，是否允许保存到密钥库并用它静默换 access（这样不用打开浏览器）？默认建议不保存，维持"只靠浏览器重新获取"：refresh_token 一般是一次性的，插件用了它，浏览器就会被登出（§4.5）。
3. **Cookie 类凭据**：ChatGPT、Claude、Grok、Gemini 需要保存会话 Cookie，权限比只读 token 大。是否接受？
4. **离线备份正文**：改为默认关闭，已经开启的用户保持原样。可以吗？
5. **`external_*` 工具的后续**：云盘和第三方来源是否也排期迁移到四工具契约（本计划不包含）？
