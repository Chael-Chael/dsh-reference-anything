# 单一 reference 工具：最终设计（修订稿）

状态：2026-11-14 用户提出单工具设计并认可方向，本文是 Agent 按审查意见修订后的版本。已定：D1 保留预览、D2 只有 @ 授权、D3 同工作目录本地会话免授权、D4 本地 id 用可逆明文编码、source 只取插件类别（第 1 节）、SDK 名为 `defineReferenceSource`。**2026-11-14 用户说开始，已在工作区实施（未提交）**：typecheck 与全量 vitest 通过；真实 Web/Desktop 验收未做（第 10 节）。实施中的补充见第 11 节。未授权提交、推送或发布。
取代：[协议契约](reference-protocol-contract.md)中的工具字段与 `reference_*` 四工具划分；该契约的安全、预算、不可信与 pre-hook 原则继续有效。

## 0. 相对用户草案的修订

| # | 草案写法 | 问题 | 修订 |
| --- | --- | --- | --- |
| R1 | 宿主"超预算就截断并补上 next"，同时"不解析 args" | 不懂位置就无法生成正确的 next；各插件各写一套分页，续读不漏字无法保证 | 宿主把预算传给插件，插件必须自己装入并给 next；宿主只校验，超了报 `BUDGET_EXCEEDED`。SDK 提供默认实现，作者只写 `load` |
| R2 | revision 绑在 id 背后 | 被 @ 的进行中会话每多一条消息，旧 id 就永远失效 | id 只表示对象且长期稳定；revision 藏进 `next` 与搜索命中的不透明位置里。从头读永不因版本失败，只有旧位置续读才报 `REVISION_CHANGED` |
| R3 | 插件发放短 id 并维护映射 | 映射若只在内存，重启或历史回放后旧 @ 全部失效 | id 必须跨重启有效。2026-11-14 用户选定：用可逆明文编码，不建登记表（第 1 节） |
| R4 | 未 @ 的范围里 list/search 只返回元数据 | search 命中本身带原文片段 | 未授权范围只允许 list 与"只返回 id + 标题"的来源级 search；带片段的 search 与 read 只在已授权 id 内 |
| R5 | 输出把关过滤本机路径；`as: file` 返回文件 | 模型用文件需要路径 | 宿主生成的临时文件路径放行；来源内部路径、URL、token 一律不出现在结果里 |
| R6 | `describe()` 供模型学习用法 | 若写进工具描述，提示词仍随插件数量膨胀 | 通用参数在工具 schema 中统一定义；`describe()` 只写本来源特有部分，只出现在 @ 引导与 list 结果的来源说明里 |
| R7 | @ 时只给 id + 标题 + 规模 + 示例 | 去掉了现有的正文自动预览，每次提问多一次 read | 列为决定项 D1，建议保留有界预览 |

## 1. 核心抽象

- **source**：任何能寻址、能产出内容的东西（会话、文件、文档、图片集、网页、数据库），不预设是文本、对话还是树。**source 只是基础类别，等于插件，也是宿主唯一的路由键**（2026-11-14 用户决定）：`local`、`web`、`drive`、`plugin`，第三方用自己的插件名（如 `notes`）。具体是哪个 Agent、哪个网站、哪个扫描位置，全部放进 id。不再有 `<类别>:<名称>` 规则、前缀匹配或 `category/owns/matchesFilter`。
- **ref**：只有 `{ source, id }`。`id` 由插件发放，长期稳定（R3），对宿主不透明。附件、子项也是 ref。授权键 `source:id` 全局唯一。
- **revision**：插件内部概念，模型看不到；只编码在 `next` 与命中位置里（R2）。
- **位置凭证**：`next` 与命中里的 `args` 都是"原样传回即可"的对象，模型不计算、不拼接。

### id 编码（内置来源）

可逆明文编码，不建登记表；不含用户名与绝对路径。

| source | id | 说明 |
| --- | --- | --- |
| `local` | `codex:2026/11/13/rollout-….jsonl` | `<agent>:<相对路径>`，相对该 Agent 的默认扫描位置；沿用现有 `referenceId(kind, relPath)` |
| `local` | `kimi@kimi-code:2026/11/13/abc.jsonl` | 非默认扫描位置用 `@<位置名>`；Agent 名不含 `@`，解析无歧义 |
| `local` | `codex@custom:2026/11/13/rollout-….jsonl` | 设置页自定义目录固定名 `custom` |
| `local` | `opencode:opencode.db#ses_abc123` | 数据库来源用 `#` 接会话号（现有 `splitSession`） |
| `web` | `deepseek:<conversationId>` | 账号归属由插件按本地记录校验，不进 id |
| `drive` | 现有 `encodeDriveId` 结果 | 不变 |

本地扫描位置命名：

| 扫描位置 | 名字 |
| --- | --- |
| 默认位置只有一个 | 省略 |
| 默认位置有多个 | adapter 写死，如 `kimi-code`、`archived`，跨机器一致 |
| 设置页自定义目录 | `custom` |
| 部署 `extraRoots` | 配置的 `name`，未写则 `extra-1`、`extra-2`… |

- 用名字不用序号：改设置不让旧引用错位；自定义目录换路径后 `custom:` 引用跟着走。
- 只在指名的位置里找，不再"第一个命中就用"；指名位置不再配置时报清楚的错。
- 同一文件能从多个位置找到时，按"默认 > 自定义 > extraRoots"固定选一个发 id，保证 @、list、search 给出同一 id。
- 指名位置找不到时可到同一 Agent 的其他位置找回，但只接受身份一致的文件（文件内 sessionId 或文件名 UUID 对得上；数据库按 `#会话号` 查行），否则 `NOT_FOUND`。
- 每次读取由 id 解析出 Agent，再检查该 Agent 的开关与允许目录（realpath 不越界）。
- 依据：官方 DSH 0.2.0-rc.2 的 @session URI 也是可逆编码（`dsh-session:` + base64url(JSON(sessionId))，解码后要求重新编码完全一致）。官方 sessionId 是自己生成的随机 UUID；我们引用的是其他客户端的会话，没有官方那样的登记库，所以编码相对路径。

## 2. 三个动作

| op | 回答的问题 | 范围 | 返回 |
| --- | --- | --- | --- |
| list | 有哪些对象/子项 | 不填 id = 整个来源；填 id = 该对象的子项（附件、分卷等） | `items: [{ source, id, title, kind?, size?, updatedAt? }]`，`next` |
| search | 哪里提到 X | 不填 id = 来源级（只返回 id + 标题）；填 id = 对象内（带片段） | `hits: [{ source, id, args, excerpt? }]`，`next`；`args` 原样交给 read 即定位到命中处 |
| read | 这个 id 的内容 | 必须填 id | 按 `as`：`text` → `{ content: [{ role?, text }], next }`；`image` → 像素 + 临时路径；`file` → 临时路径 + 类型 + 大小 |

- 插件不必支持全部 op，但至少支持 read；未支持的由宿主统一报 `UNSUPPORTED_OP`。
- `role` 可选，取值固定 `user / assistant / summary / document`，第三方不能扩展；无角色的内容不带此字段。
- 原 `reference_attachment`、`reference_image` 的能力 = list(id) 列出子项 + read(子 id, `as: image|file`)。
- 没有 resolve：@ 时插件直接给 id。

## 3. 统一工具外壳

模型只看到一个工具：

```ts
reference({ source, id?, op: 'list' | 'search' | 'read', args? })
```

通用参数由工具 schema 统一声明（R6），插件可以在 `describe()` 中扩展：

| 字段 | 适用 op | 含义 |
| --- | --- | --- |
| `query` | list、search | list 按元数据匹配；search 默认区分大小写的字面子串 |
| `limit` | 全部 | 最多返回条数，插件声明上限 |
| `next` | 全部 | 上一页返回的 `next`，原样传回；同时保持其他字段不变 |
| `as` | read | `text`（默认）/ `image` / `file`，插件声明支持哪些 |

其余字段原样交给插件。宿主只按 `describe()` 校验外层结构（字段名、类型），不解析语义。

`source` 只选插件；插件内的细分过滤走 args 并在 `describe()` 声明，例如 local 的 list 支持 `{ agent: "codex" }`，web 支持 `{ provider: "deepseek" }`。

## 4. 插件接口

```ts
interface ReferenceSourcePlugin {
  readonly source: string                 // 插件名：'local'、'web'、'notes'；一个插件一个 source
  describe(): SourceDescription           // 支持的 op、扩展 args 的 schema、as 取值、用法说明与 1–2 个示例
  list?(scope: Scope, args: ListArgs, call: Call): Promise<ListResult>
  search?(scope: Scope, args: SearchArgs, call: Call): Promise<SearchResult>
  read(id: string, args: ReadArgs, call: Call): Promise<ReadResult>
}
interface Call { budget: number; signal: AbortSignal }   // R1：预算由宿主给出
```

插件负责：

- **发放 id**（R3）：可逆编码，跨重启有效，不含凭据、用户名与绝对路径（内置来源见第 1 节）。旧格式 id 继续可解析，并换算成新格式。
- **判断版本**：位置凭证里的 revision 与当前不符时报 `REVISION_CHANGED`。
- **解析 args**：范围、`as`、查询语法。
- **在预算内产出内容并给出 next**（R1）。
- **每次调用检查自己的开关、目录、账号**：不允许就抛错，不返回空结果。
- **@ 引导**：返回 id、标题、规模，以及 D1 决定的预览。

**SDK 默认实现 `defineReferenceSource`**（2026-11-14 用户定名，沿用 DSH 官方 `defineTool`、`defineDomain` 的 `define…` 习惯）：多数作者不想写分页。它是插件内部引用的库，不是宿主与插件之间的运行时层；宿主始终直接调插件。

```ts
defineReferenceSource({ source, load(id) → Doc, list?(query) → Item[], fetch?(id, childId) → Bytes })
```

自动生成 `describe/list/search/read`：按 `Doc` 做分页、`textOffset` 续读、字面搜索、revision 哈希、子项（附件）列出与读取。现有本地 Agent、网页对话、云盘都用它，第三方最少只写 `load`。数据源自带分页或服务端搜索的插件可以不用它、直接实现四方法；宿主只能校验预算与形态，无法校验续读是否正确，所以 SDK 另附一致性测试工具（按 `next` 拼接须逐字还原原文），文档强烈推荐使用 SDK。

## 5. @ 的流程

1. 用户 @ 某个对象。
2. 插件返回 `{ source, id }` 与引导（见 D1）。
3. 宿主把引导插进上下文，并在授权表登记 `source:id`（含其子项）。
4. 模型调用 `reference(...)`，宿主检查授权后路由给插件。

## 6. 宿主职责（路由 + 守门人）

- **路由**：按 `source` 分发。
- **授权表**：键为 `source:id`，按会话持久化；@ 授权该 id 及其子项（D2）。
- **schema 校验**：按 `describe()` 校验外层，不解析语义。
- **预算**：传给插件并校验结果，超出报 `BUDGET_EXCEEDED`（R1）。
- **输出把关**：只放行 text / image / file 三种形态；加不可信历史材料标记；去掉来源内部路径、URL、token（R5）。
- **错误规范化**：`{ code, message, retry }`，`retry` 取 `relist | restart | none`。code：`NOT_FOUND`、`UNAUTHORIZED`、`SOURCE_DISABLED`、`SOURCE_UNAVAILABLE`、`REVISION_CHANGED`、`UNSUPPORTED_OP`、`INVALID_ARGS`、`BUDGET_EXCEEDED`。
- **不做**：不存 id 映射、不解析 args、不跨调用缓存正文（保证每次读取实时经过插件的权限检查）。审计日志可选。

## 7. 不变量（沿用，不因单工具改变）

- 本地 @ 引用只读；关闭来源后旧引用也不能新读取；不放宽 DSH 沙箱。
- 内容是不可信历史材料，不是指令。
- 读不到就明确报错，不用空内容冒充成功；来源本身不完整时给 notice。
- 插件自己注册的写操作或参数化查询工具，只返回 ref，正文统一经 `reference` 的 read。`reference` 名称保留给核心。

## 8. 待用户拍板

- **D1 @ 时是否保留正文预览**：**2026-11-14 用户决定保留**。由 SDK 默认实现产出最近一段内容，整批 @ 共享 16 KiB；超出只给引导，不给正文。
- **D2 授权范围**：**2026-11-14 用户选 A（只有 @ 授权）**。同时去掉"工具结果里出现的 @ 也算授权"（`src/index.ts` `assertSessionGranted` 扫描 `tool/result`），授权只从用户消息推导；子 Agent 需继承父会话授权（实施时核实）。原建议：@ 授权 id 及其子项；list 在已启用来源中可直接跑（只返回元数据，不授权）；对象内 search 与 read 需要授权；取消现在"list 即授权"。代价：模型自己 list 到的会话不能直接读，要请用户 @。
- **D3 是否保留"免授权"条目**：**2026-11-14 用户选按条目判断——工作目录与当前会话相同的本地会话可直接读，无需 @**；其他本地会话、网页、网盘、第三方一律需要 @。原说明：按条目判断：工作目录与当前会话相同的本地会话免授权，其他本地会话、网页、网盘、第三方一律需要 @。接口为可选 `ungated?(id, { cwd })`，默认需要授权。依据：官方 `dsh-tool-session-query` 的 `headerAuthorized` 只放行 `cwd` 与调用方相同的 session。备选：本地会话也一律需要 @（更一致，本项目历史也要 @）。注意本地授权只是软边界：DSH 文件沙箱只限写入，模型可用文件工具直接读原始会话文件。
- **D4 本地 id**：**2026-11-14 用户决定用可逆明文编码，不建登记表**，规则见第 1 节"id 编码"。

## 9. 迁移（基于当前工作区，不是 e066afa）

当前工作区已把 7 个工具收成 4 个（`reference_list/read/search/attachment`，未提交），且含其他会话未提交改动，迁移在其上进行、不回退。

1. **SDK 与类型**：`types.ts` 的 `ReferenceSource` 换成第 4 节接口；新增 `defineReferenceSource`，复用 `local-reference.ts` 的 `readLocalPage`、`selectLocalRows`、搜索与 `documentNotice`；`source-documents.ts` 与 `reference-documents.ts` 的 `DocumentSource` 合并进它。
2. **单一工具**：`local-reference-tools.ts` 的三个工具与 `tool.ts` 的 `reference_attachment` 合并为 `reference`；附件改为 list(id) + read(as)。
3. **source 与 id**：source 收为插件类别（`local`、`web`、`drive`、`plugin`），删除 `DocumentSource.category/owns/matchesFilter` 与 `<类别>:<名称>` 规则。本地统一用 `src/sources/local-agent/index.ts` 的 `kind:relPath` 编码并加上 `@位置名`，删除 `local-locator.ts` 的绝对路径 base64 编码（`localLocatorId`），只保留它的解码用于兼容；改 `resolveRoots` 的"第一个命中就用"为按名定位 + 身份校验找回。兼容三种旧格式：`local-agent` + `…:chat-import:<base64>`、`dsh-local:?source=&path=&sessionId=`、模型侧旧 `{ source: "local:codex", path, sessionId }`。网页去掉 `{ conversationId, account }` 多字段 locator；云盘沿用 `encodeDriveId`。
4. **revision 进位置凭证**：`next` 与命中 `args` 编码 revision；删除工具参数中的 `revision`、`from`、`maxItems`。
5. **授权**：删除 `local-reference-tools.ts:204` 的 `grantListed`；@ 授权覆盖子项（D2/D3）。
6. **prestep**：`reference-prestep.ts` 按 D1 改为插件引导 + 可选预览。
7. **错误**：`errors.ts` 输出 `{ code, message, retry }`，旧 code 映射到新集合。
8. **文档与技能**：本文定稿后替换协议契约中的工具字段（同时清掉该文第 521–749 行误贴的源码）；更新 `third-party-source.md`、`skills/reference-source-author`、示例 `examples/reference-source-notes`、README 草稿。
9. **测试**：工具、附件、本地/网页/云盘来源、prestep、example-source、URI 兼容；补齐 R1–R5 的失败路径。

## 10. 验收

- 模型工具列表只有 `reference`；注册 3 个第三方来源后工具描述长度不变（只有来源说明随 list/@ 出现）。
- 进行中的会话被 @ 后继续增长，从头读成功；拿旧 `next` 续读报 `REVISION_CHANGED` 且 `retry: restart`。
- 重启 DSH 后历史里的 @（含三种旧格式）仍可读。
- 结果与 id 中不出现用户名或绝对路径；同一会话经 @、list、search 得到同一 id。
- 多扫描位置：两个位置有同名相对路径时读到 id 指名的那个；自定义目录换路径后 `custom:` 引用仍可读；删掉自定义目录后报明确错误；身份不符的同名文件不被顶替。
- local 的 `{ agent }` 过滤与按 Agent 开关生效；关闭某个 Agent 后其旧引用读取报 `SOURCE_DISABLED`。
- 未授权 id：read 与对象内 search 报 `UNAUTHORIZED`；来源级 search 不含片段。
- 文本按 next 拼接逐字还原（中文、emoji、超长单条）；超预算的插件结果被拒而不是被截断。
- 结果中不出现来源内部路径或 token；`as: file` 只给宿主临时路径。
- 关闭来源后旧引用读取报 `SOURCE_DISABLED`。
- 第三方示例只实现 `load` 即可完成 list/search/read 全流程。
- 真实 Web 与 Desktop 各跑一次：总结最近结论、找中段决定、看图片、读文件附件。

## 11. 实施记录（2026-11-14）

代码位置：`src/reference-source.ts`（接口、`defineReferenceSource`、位置凭证、错误规范化、`readAllText` 一致性检查）、`src/tool.ts`（`reference` 工具）、`src/index.ts`（`registerPlugin`、`resolveMention`、`assertPluginGranted`）、`src/legacy-source.ts`（旧 `ReferenceSource` 包装）、`src/sources/local-agent/ids.ts` 与 `reference.ts`（`local`）、`src/sources/web-chat/document.ts`（`web`）、`src/reference-prestep.ts`。删除 `local-reference-tools.ts`、`reference-documents.ts`、`source-documents.ts` 及旧分页函数。

实施中补充的细则：

- **本地 id 的会话号**：读取器必须拿到 sessionId，所以 id 在文件名（去扩展名）不等于会话号时追加 `#<会话号>`，相等时省略。例：Codex 的 `rollout-…-<uuid>.jsonl` 带 `#<uuid>`；`%` 与 `#` 在路径和会话号中转义为 `%25`、`%23`。
- **默认位置命名**：第一个默认位置不命名；其余取与第一个位置首个不同的路径段（去掉前导点、转小写、非法字符换成 `-`），如 Kimi 的 `kimi-code`、Codex 的 `archived-sessions`。以后上游增加默认位置不会改动旧 id。数据库文件本身作为位置时，相对路径就是文件名（`opencode:opencode.db#ses_…`）。
- **位置不再配置**：直接报 `NOT_FOUND`（`retry: relist`），不到其他位置找回；只有指名位置还在、但文件不在时才找回，并且只接受同一会话号。
- **子项 id**：`<对象 id>><key>`，key 为 `[a-z0-9-]+`；本地图片 `1`、`2`…，工具调用记录是文本子项 `tools`。`@` 授权通过 `parentOf` 覆盖子项。
- **`as: "image"`**：任何二进制子项都可请求，宿主检测字节不是 PNG/JPEG/WebP/GIF 时报 `INVALID_ARGS`。
- **SDK 入口**：宿主端从 `dsh-reference-anything/source` 导入（`defineReferenceSource`、`referenceError`、`readAllText`），`dsh-reference-anything/sdk` 只保留类型和浏览器安全函数，避免浏览器端打包进宿主依赖。
- **`@` 线格式未改**：输入框仍插入旧的 `local-agent` / `web-chat` / `cloud-drive` 引用，由各插件 `claim` 换算成新 id 后授权和预览；模型看到的始终是新 id。旧 `dsh-local:` URI、`<local-agent-reference>` 标签和模型侧 `{ source: "local:codex", path, sessionId }` 均可读（后者由工具换算）。
- **错误码**：附件过大、限流、下载目录配置错误等归入 `SOURCE_UNAVAILABLE`（消息说明原因），账号不符归入 `UNAUTHORIZED`；取消仍报 `REFERENCE_CANCELLED`。工具运行时自身的 schema 校验错误（如 `as` 取值非法）不是 JSON 格式。
- **子 Agent**：读取时检查本会话与 `header.parentSession` 在内存中的授权；父会话授权只在同一进程内可见。

验证（2026-11-14）：`npx tsc --noEmit` 通过；`npx vitest run` 全量通过（新测试覆盖：单工具注册且描述不随来源增长、按 next 逐字还原中英文与 emoji、旧位置 `REVISION_CHANGED`/`restart`、搜索命中 args 直达、未 @ 报 `UNAUTHORIZED`、工具结果不授权、子 Agent 继承、超预算拒绝、子项文件与图片、本地 id 编解码与多位置定位、同工作目录免 @、三种旧格式、第三方示例只写 `load`/`list`）。未做：真实 Web 与 Desktop 验收、`agent:sync` 后的宿主实测。

