# 引用协议重设计：简洁结果、可靠续读、来源复用

状态：用户已于 2026-10-19 授权实施，当前代码与验收进度见[开发任务](../development/tasks/local-reference-protocol.md)。用户于 2026-10-19 要求先调研官方格式并提出新设计；明确无需兼容旧协议。最初调研不含实现授权；后续用户已授权实现与 Web 验收，未授权发布或删除历史数据。

## 结论

建议建立一个小型分页契约：`ref → revision + items + next`。正文只出现一次，预览与补读使用同一种条目结构；工具记录、图片按需读取；显示信息留给 DSH presentation metadata。保留清晰字段名，不把数据缩写成需要模型记忆的字典或位置数组。

先落地本地 Agent，再将确实相同的分页、渲染和预算逻辑接到其他来源。不新建通用资源平台、句柄注册表、虚拟文件系统或全文快照服务。

## 1. 调研范围与证据

- 源码基线：`8a97bd4825235f4f5c9cb498bbe50a45b64374a4`，插件 0.5.0。开始调研时六个文件有未提交改动，后续读取时已由外部操作收敛到该提交；本轮未修改业务代码。
- 本地官方包：`dsh-session-reference`、`dsh-file-reference`、`dsh-tools` 为 `0.2.0-rc.2`；仓库直接解析到的 `dsh-tool-fs` 为 `0.1.2-alpha.1`，不能把它冒称为 Desktop 当前运行版本。
- 已交叉核对官方 GitHub 的 session projection、file-reference 文档、tool-fs 的 read 与 read-render 源码；下述核心格式与本地读取一致。远端 master 是可变引用，不表示本机已加载该版本。
- 未执行真实模型调用、Session Log 导出、Web/Desktop 验收，也未验证宿主运行中具体加载的包路径。

官方来源：

- [会话引用说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/session-reference/README.md)
- [会话 projection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/session-reference/src/projection.ts)
- [文件引用说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/file-reference/README.md)
- [read 工具](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/src/read.ts)
- [read 输出格式](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/src/read-render.ts)

本地核对入口：`node_modules/@deepseek-ai/dsh-session-reference/lib/index.js` 的 `retainReferencedSession`、`renderPrompt`、`renderTranscript`；`dsh-tool-fs/lib/index.js` 的 `applyReadTool`、`formatReadOutput`；`dsh-tools/lib/index.js` 的 `createSuccessResult` 与 run_code SDK bridge。

### 官方 @session

不是一个“读取 session 的工具返回值”。它在 pre-step 捕获来源当前表层，将只读背景作为紧随当前用户消息的另一条 user 消息持久化。

下面是结构等价示例，示例正文与标识均为虚构，未逐字复制官方提示词：

```text
## Referenced sessions
[固定的不可信背景警告]
<referenced-sessions>
[{"sessionId":"example","label":"缓存讨论","cwd":"D:/project","capturedThroughSeq":42,"conversation":[{"role":"user","text":"检查缓存。"},{"role":"assistant","text":"需要校验来源版本。"}]}]
</referenced-sessions>
```

- 正文只有 `role/text`。直接用户文本、assistant 文本、合法压缩检查点进入投影；工具、推理和其他注入上下文不进入投影，避免递归引用。
- 每个引用独立计算预算。自动上限为 `max(65536, floor(contextWindow * 4 * referenceContextFraction))`，比例默认 0.2；这是字节估算，不是精确 token，也不是剩余上下文共享预算。
- 裁剪先移除较早非检查点消息，再缩短文本。发生省略时，额外给出省略信息；若可选 spill 可用，完整捕获文本可另存并通过定位信息读取。
- 保存的完整文本按每行至多 64 个 Unicode 码点的 JSON 字符串片段编码；这用于支持分页文件读取，不是日常预览的推荐样式。
- 每个 `<` 做 JSON 转义，防止正文伪造外层边界。它仍然是不可信材料，转义不是完整的提示注入防护。

值得借鉴：最少正文结构、排除执行噪声、预算与省略有明确语义。不要直接复制每引用至少 64 KiB 的预算与 spill：它们不符合本项目优先省 token、原源按需补读的目标。

### 官方 @文件

选择文件只插入 `@path` 或带引号的路径，不自动附带文件内容；模型需要调用 `read({file_path, offset, limit})`。内部值与模型文本分离。

结构化值的示意：

```json
{"path":"src/cache.ts","offset":1,"lines":[{"number":1,"text":"export const enabled = true"}],"totalLines":30}
```

直接工具调用的模型文本是路径、类型、带行号正文与一个续读/文件结束提示：

```text
<path>src/cache.ts</path>
<type>file</type>
<content>
1: export const enabled = true

[本页结束；从 offset=2 继续]
</content>
```

这里只保留结构等价示例。官方默认最多 2,000 行、单行 2,000 字符、所选文本 50 KiB；单行截短后，仅增加 offset 不能恢复该行被截掉的部分。因此本地会话不能照搬它的长行策略。

值得借鉴：定位、内容、一个明确续读位置；UI 需要的语言、卡片信息不必进入模型正文。原生文件与 DSH session 仍交由官方服务拥有，不为了统一插件协议而重做官方能力。

### 必须同时考虑直接工具调用和 run_code

`defineTool` 的 `execute` 返回 canonical JSON `value`，`output.render` 生成内容块，`presentationMeta` 生成 UI 元数据。直接调用使用渲染内容；run_code 的 `tools.xxx()` 返回 `value`，只有程序打印或返回的内容进入程序输出，图片另由宿主转送。

因此，不能只美化 `render`，也不能断言“每次模型都看到了 value 与 render 两份全文”。当前冗余确实存在于 value 内部；在 run_code 返回整个对象时会被暴露，且 SDK 输出类型声明也增加常驻提示成本。

## 2. 当前插件应彻底移除的负担

| 当前机制 | 影响 | 建议 |
| --- | --- | --- |
| `localText` 内再编码正文，同时返回 `messages`/`toolRecords` | value 重复保存正文；序列化预算为双份内容付费 | 删除 `localText`，由唯一结构化 page 渲染 |
| 每页 `tools` 用法字典、长 `LOCAL_NOTICE` | 每次重复说明刷新、偏移、预算、工具用法 | 稳定规则放一次工具/系统说明；上下文仅保留短不可信标记 |
| `messageRange`、`shownMessages`、`hasOlder`、`nextStart`、全局 omission ranges | 模型要推理多个有重叠含义的分页事实 | 连续页 + 一个实际续读位置 |
| 预算删除请求窗口内消息，`nextStart` 仍跳到请求末尾以后 | 顺着 next 读取可能漏掉被裁掉的正文 | 从请求起点顺序装入；next 指向第一个未返回字符 |
| 单条正文/工具文本 head-tail 截断 | 中段可能没有可恢复的读取方式 | 长条目按偏移续读，不把“有省略提示”等同于“可完整读取” |
| 每条 `checkpoint:false`、`images:[]`，每页空工具数组、零值省略统计 | 小对话中元数据占比很高 | 只有存在语义时才输出可选字段 |
| 读工具混用 local/non-local、0/1-based、cursor/before/start、废弃 detail | 参数、SDK 类型与描述过长 | 新契约统一编号方向，后续逐源迁移，最后删除旧分支 |
| 每次重复标题、locator、capturedAt | 参数已知、时间每次变化而不支持正文判断 | 身份与标题用于初始预览/发现；补读仅保留 revision 与结果 |

代码证据：[本地投影](../../src/local-reference.ts)、[本地工具](../../src/local-reference-tools.ts)、[公共工具声明](../../src/tool.ts)、[发送前注入](../../src/reference.ts)、[实际源读取与版本](../../src/local-conversation-reader.ts)。

## 3. 当前汇总契约入口（2026-10-19）

每个工具的字段、默认值、返回示例和 pre-hook 设计统一见[引用工具与 pre-hook 完整契约](reference-protocol-contract.md)。该文已合并对话修正，是当前字段的唯一详细定义；本调研文档中的代码现状、官方格式和早期测量保留其历史语境。

当前要点：

- 用 from/maxItems 描述读取定位与数量；列表用 from.index，正文用 from.messageId，工具用 from.toolId，图片用 from.imageId，文本续读用 from.textOffset；next 原样复制为 from。
- 正文 part 统一为 messages。正文/工具/图片编号保留 messageId/toolId/imageId，由读取层在同一内容版本中按来源顺序分别分配；不要求原始消息自带 ID，筛选不重编号。删除 itemId，不提供旧名称兼容。
- tools/images 的所属正文筛选放进 from.messageId，不再有外层 messageId；next 必须保留该范围。messages 的 from.messageId 则表示正文起点。搜索命中 position 可直接复制为 read.from。
- 删除模型返回中的 total/partial/checkpoint/localText。来源限制用一句 notice，来源摘要用 role=summary；原始标记保留内部溯源。
- 插件生成的模型侧 notice、错误说明、工具说明和 pre-hook 固定提示统一英文；来源正文、摘要、工具输出、标题和文件名不翻译。审核文档与行内注释保留中文，实际输出不带注释。
- role=summary 是新协议的返回项分类，由读取层根据明确来源标记映射，文本直接取来源已有摘要。当前 checkpoint 的宽泛 compact 字符串匹配需在实施时收紧，不能把方案描述为现有可靠能力。
- 图片清单返回 imageId、已知原始 name 和可靠 messageId；实际像素仍由 reference_image 返回。
- 预览成功复用 messages page；正文未加载时只给定位与 notice，不增加 deferred 状态代码；失败明确 error，不伪装成空结果。
- deferred 的语义仅保留为“本次未加载正文”，后续由模型主动调用读取；不新增后台排队或自动补发。
- pre-hook 处理全部本批直接用户消息，在各自消息后附聚合背景，共享新增预览预算。目录与内容版本区分使用。

无新增句柄注册表、虚拟文件系统、跨调用全文缓存或兼容旧参数的分支。此前合成字节测量不代表本版格式的实测收益。

## 4. 预算设计

优先减少固定开销、重复正文、默认展开量，再调默认上限。不得把“减少 JSON 字节”直接写成“减少相同比例 token”。

建议只保留一个用户可理解的文本输出上限，实验初值为 16 KiB：一次 pre-step 批次的所有本插件新增自动预览共享它，一次工具结果也受它约束；两者均须考虑实际剩余上下文，不能靠提高上限挤占用户输入和回答空间。这个数值仍需模型验收，不作为已批准产品默认值。

上限按最终完整的模型文本以及 canonical JSON 分别计量，至少取两者中的较大值，包含包裹、版本、定位、next 和转义成本。图片像素/token 单独约束，不能算进文本 16 KiB 后声称已控住多模态上下文。代码工具自己再包装/打印结果也可能增加开销，最终要测实际请求。

模型容量未知时保留保守的 metadata-only 自动预览回退。共享预算不足时按引用公平分配；定位信息自身超过预算就给简短错误，不声称元数据可以无限豁免。未知剩余上下文时，显式工具读取只承诺固定输出上限，不虚称已经精确测算上下文。

固定安全说明安装一次；预览和直接 render 仍有短不可信标记并保留标签安全转义；run_code 的 canonical value 不能依赖 render 才获得安全边界，使用它的 agent 同样必须拥有稳定规则。

## 5. 已执行的合成体积实验

使用临时 Codex JSONL（两条中文消息、无工具、无图片），通过当前真实 `loadLocalReference`、`renderLocalPreview` 和 `readLocalTool` 获取旧结果；新草案使用相同正文和版本，assert 核对正文逐字一致。临时来源在校验其位于系统临时目录后已删除。

| 对象 | 当前 UTF-8 字节 | 精简草案字节 |
| --- | ---: | ---: |
| 自动预览文本 | 1,738 | 610 |
| read canonical JSON value | 2,859 | 296 |

旧 read 的直接 render 为 1,920 字节。预览草案包含相同 locator、标题、短警告和页对象；read 草案不重复参数里的 locator，也不再含 localText。这些数字约为 65%/90% 字节下降，但只是固定开销主导的两条消息合成样例；不是实际模型 token、长会话收益、能力保持或最终协议实现测试。测量中临时路径长度影响结果。

实施验收时再比较：工具/SDK 声明、自动注入、工具参数、实际工具输出、达到正确答案所需补读总量。不能只把第一页变短、却让总工具调用数和总 token 上升。

## 6. 最小实现边界与后续复用

| 层 | 首轮需改范围 |
| --- | --- |
| 规范化来源 | 本地消息、工具、图片稳定编号与关联；`local-conversation-reader.ts`、vendor 契约只在当前输出缺少必要事实时修改；保留权限、身份和错误处理 |
| 纯分页与渲染 | 用一个小分页函数处理顺序填充、offset、next；一个紧凑安全 JSON renderer；不新建 class 层级 |
| 本地工具 | `local-reference.ts`、`local-reference-tools.ts`、`tool.ts` 的参数、返回 schema、描述、注册和 post-execute/retention 交互 |
| 注入与 UI | `reference.ts` 直接消费 page，不先渲染后 JSON.parse；locator/mention/客户端复制恢复链同步；UI 统计进入 meta，不让模型为卡片付费 |
| 公开契约与配置 | `types.ts`、相关 exports、配置项、`cordis.patch.yml`、契约文档及调用示例按实际受影响项更新，不保留旧字段别名 |
| 测试 | local-reference、tool/PTC、mention/runtime、reader、URI、客户端引用与相关 fixtures；补齐失败路径而非只测 schema 快照 |

先在本地 Agent 证明：连续补读无漏字、PTC 可直接使用、实际回答正确、总输入 token 下降。其他来源随后接入同样的 page 与预算接口：

- 网页对话沿用 metadata-only、实时 detail、账号检查，不新增完整正文缓存/快照。网络全量获取成本不会因为输出分页自动下降。参见[网页引用方案](web-chat-reference.md)。其旧预算与协议建议应在本方案定稿后统一更新，网页方案仍待单独实施，不能将其预算建议叠加到本地协议。
- 云盘/文件导出仍是文档，不伪造 user/assistant。图片与下载各有权限和物化语义，按能力逐项接入，不强制所有来源实现所有方法。
- 官方原生 `@session/@文件` 不改，借鉴其接口分层。已有来源 registry 能复用就复用，先不规定一套所有提供方必须实现的重型基类。

无需兼容意味着删除旧参数、旧返回形状和重复说明；不意味着删除原始会话、重写用户历史或放宽沙箱。旧消息中可保留已持久化文本，但旧工具参数重放可能失败，需明确提示重新选择引用；旧行为的 UI 回放影响也要单列验证。

## 7. 必须通过的验证

1. **完整性**：普通、单条超长、中文/emoji、多工具巨量输出，按 next 拼接恰好还原规范化来源；无漏字、重复或死循环。
2. **语义**：空页、partial、尾部预览、source missing、搜索零命中、summary/checkpoint 均不误报完整原始历史。
3. **安全**：关闭来源后所有旧引用的新读取失败；路径越界、symlink、伪造 sessionId、账号切换、版本变化拒绝；正文中的标签和指令保持不可信。
4. **两条工具路径**：直接调用的 content 与 run_code 的 canonical value 信息等价；SDK 没有 legacy 字段；图像确实到达模型；retention 不破坏 next 或改变成需要解析的字符串。
5. **预算**：多个引用、长标题/路径、大量附件链接也有界；稳定声明、单页与最终实际模型请求分别计量。
6. **真实任务**：总结最近结论、找历史中段决定、核查某次工具失败、识别图片四类任务；与旧协议比较正确性、调用次数、总输入 token、延迟，不能靠丢正文得到“节省”。
7. **交付流程**：实现后按仓库规定完整检查、build、双环境同步与真实 Web/Desktop 验收；实施与当前验收结果见[重构任务记录](../development/tasks/local-reference-protocol.md)。

本轮仅调研、合成体积对照与设计文档。没有新增生产依赖、修改运行配置、重启环境、读取用户会话正文或创建定时任务。

## 实施同步（2026-10-19）

本地四工具按本契约重构；其他来源使用 external_reference_list/read 保留既有逻辑，不再混入本地工具声明。配置统一命名 maxTextBytes：reference-mention 限制整批新增背景，reference-tool 限制每次本地文本结果，默认均为 16 KiB。原 maxOutputBytes 仅用于其他来源；不兼容本地旧参数。README 已同步为待用户审阅的工作区文字，未发布。

针对自然语言总结：公共说明要求依据引用的消息和工具结果回答，区分历史声明与已验证结果；当前用户未要求时，不续做历史任务或检查实时工作目录。简单与复杂模糊请求必须独立真实验收，见发版清单 4.5。
