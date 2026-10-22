# Issue #13：原生引用注册归属

基线：`v0.5.0` / `579ca068f2aa93af45c40269d6a20f0157714894`。问题：[Issue #13](https://github.com/Chael-Chael/dsh-reference-anything/issues/13)。

## 契约与改动

- 默认仍禁用官方 `ui-reference`，RA 保留原生 `reference` codec、文件/目录文本规则与渲染组件。
- Profile 显式启用官方插件时，从 `loader.internal.manifest.plugins` 判断本次启动的归属。该清单在插件激活前已经完整，不依赖双方加载顺序；不能根据已加载模块或当前注册表推断启用状态。
- 官方接管时，RA 不重复注册上述原生能力；文件和 DSH 会话来源保留旧 chip 的 codec/预览，但返回空候选、移除文件导航头，避免重复菜单。即使 RA 的对应 Picker 开关关闭，旧 chip 仍可解析。不修改用户保存的 Picker 设置。
- 其他 RA 来源维持原行为。修改 Profile 后重启 DSH 并重新加载页面；本修复不承诺同页热切换归属。
- 归属判断位于 `src/client/index.ts`，官方菜单展示适配位于 `src/client/official-reference-menu.ts`；不增加依赖，不改变读取权限、导入、宿主协议或 exports。

## 验证（2026-10-21）

| 项目 | 结果 |
| --- | --- |
| 基线复现 | 官方先加载出现 `slash source "@reference" is already registered`；RA 先加载出现 `user-text rule "file" is already registered` |
| 自动化回归 | 两种顺序、官方禁用、RA Picker 关闭、旧 chip 序列化/复制/预览与释放；见 `tests/client-reference-ownership.spec.ts` 及已有 native-reference / plugin-toggle 测试 |
| 实际官方客户端包 | 本机官方 `ui-reference 0.2.1-rc.2` 的真实 `apply()` 与 RA `apply()` 在隔离注册表中按两种顺序运行，通过；宿主环境为测试替身，不冒充完整浏览器启动顺序证据 |
| 定向破坏检查 | 隔离副本中把归属判断强制改为 false，两种顺序均重新失败 |
| 完整检查 | 类型检查、1136 项测试通过 / 8 skipped、build 成功；随后新增 Picker 关闭用例单独复测 |
| Agent Web / 官方启用 | DSH 0.2.1-rc.2 实际启动；文件、目录、会话候选无 RA 重复项；文件插入、复制、预览，目录/会话插入复制通过 |
| Agent Web / 官方禁用 | RA 文件/会话来源、目录钻取、文件复制及已发送文件卡片正常 |
| 旧 RA 草稿切换 | 禁用官方时插入 `Files and folders` chip，启用官方并重启/刷新后仍恢复该 owner，复制与预览通过 |
| 官方模式真实模型读取 | DeepSeek 官方账号读取测试文件，工具结果与答案标记一致，轮次 completed |
| RA 模式真实模型读取 | BLOCKED：用户引用消息已正确持久化，但模型传输在 5 次自动重试后失败，未进入工具读取；不标为完整端到端通过 |
| Desktop / 操作系统级拖放 | NOT_RUN；本次按用户要求限定独立 worktree 与 Agent Web，无 Desktop 刷新 |

证据保存在独立 worktree 的 `.codex-tmp/issue-13/`：`red.log`、`green.log`、`check.log`、`official-package.log`、`break.log`、`session-diagnosis.json` 与截图。

官方会话 `session-0edc5e07-cf7b-4de0-b951-60dce6fad26c`：第一轮 `tool/result seq26`、答案 `seq30`、completed `seq32`；第二轮用户消息 `seq38`、传输重试 `seq42/45/48/51/54`、错误结束 `seq58`，错误为 `DeepSeek Messages transport failed` / `TRANSPORT`。没有将网络传输失败归为引用注册问题，也没有更换第三方模型。

测试 profile 曾带有主分支新增 `agentDirectories.omp`，v0.5.0 无法解析；仅在备份后临时移除该测试设置项，不将降级设置兼容混入本次修复。临时 profile 修改与链接在验收结束后恢复，原始会话保留。

收尾：Profile patch 与 RA storage 已按备份逐字节核对恢复，链接恢复到原主工作区；草稿清空。官方导出 ZIP、解压 JSON 与临时配置备份已删除并核实不存在，保留脱敏 `session-diagnosis.json`。最终定向测试 8/8、类型检查、diff 检查通过。未执行会自动刷新 Desktop 的 `agent:verify`，以完整 `check` 加限定 Agent Web 的刷新验收代替。

## 官方分组折叠适配（2026-10-22）

用户追加授权方案 A：官方保留引用归属，RA 仅适配候选展示与展开/收起动作。适配通过会话控制器获取官方已返回的候选，不拦截来源注册，不修改官方 codec、预览、目录面包屑或候选内容。文件、子会话、普通会话各自按官方 section 分段，使用 RA 对应折叠条数，每次增加 5 项；键盘与鼠标使用同一份可见候选。

宿主没有专用公开折叠接口，目前包装 `sessionOf`、`menu.set` 和 `pick`；这是兼容层，不是稳定上游扩展契约。无法识别候选格式时显示官方完整列表；原生滚动模式同样不折叠。搜索/目录查询变化、菜单关闭或重新打开后重置展开状态；插件释放恢复完整列表与方法。宿主升级仍需回归。

| 项目 | 当前结果 |
| --- | --- |
| Red / 定向破坏检查 | 无适配时初始 2 项断言失败；最终隔离禁用适配后 3 项断言失败，均为功能断言，非编译失败 |
| 完整 check | 类型检查、1145 测试通过 / 8 skipped、build 成功 |
| 宿主真实控制器 | 项目 SDK 0.2.0-rc.2 及当前宿主 0.2.1-rc.2；官方先注册 / RA 先适配 × 文件 / 会话；Down → Enter 展开 → Down → Tab 收起 → Up → Enter 官方插入，全部通过 |
| 官方真实 apply | 0.2.1-rc.2 官方与 RA 的两种加载顺序及官方禁用回归通过；先前一次测试收集超时，重跑通过 |
| Agent Web 会话 | 官方 6 项 → Enter 展开 11 项 → Tab 收起 6 项；Up + Enter 插入后 chip owner 为 reference |
| Agent Web 文件 | 14 个独立测试文件：显示 6 项 → Enter 展开 11 项 → Tab 收起 6 项；键盘插入 sample-06.md，owner 为 reference，复制完整 mention，官方侧栏读出对应正文 |
| 目录 / 查询 | 官方进入目录成功；带引号目录查询成功；切换查询回到默认折叠状态 |
| 证据边界 | 两种加载顺序是自动化注册/控制器证据；Web 实际启动只核验当前加载顺序。未声称浏览器强制切换过两种顺序 |
| 未执行 | 本轮模型发送、Desktop、操作系统原生拖放；不复用上一轮模型读取 PASS 作为本轮证据 |

本轮证据：`.codex-tmp/issue-13/folding-check.log`、`folding-tests.log`、`folding-host-keyboard.log`、`folding-official-package-rerun.log`、`folding-break.log`、`folding-collapsed.png`、`folding-expanded.png`。临时测试文件只位于 Agent Web workspace 的 `issue13-fixtures/folding/`。

最终审查补充“同一批原始候选重新发布”的回归：先复现恢复到 24 项的错误，修复投影数组身份判断后完整 check 再次通过；当前宿主键盘与官方包测试重新通过，最终构建的文件/会话 Web 键盘操作也已复测。额外证据为 `folding-refresh-red.log`、`folding-sessions.png`。验收草稿已清空，没有发送模型消息。

按用户要求，Agent Web 3081 继续使用独立 worktree 构建，官方 ui-reference 保持开启供查看；原始 profile patch、settings 备份及原链接保留以便恢复。未修改 Desktop、用户 Web 3080，未提交、推送或发布。

## 追加端到端验收（2026-10-22 11:05–11:07，Asia/Shanghai）

本轮未改代码或重新构建，针对上述最终构建补充真实模型证据。使用 `deepseek-account / deepseek-flash`（UI：DeepSeek-V4.1-Flash 1017）。

- 文件 PASS：从展开后的官方文件列表选取原本隐藏的 `sample-11.md`。会话 `session-dee9cc51-5649-42c5-9aeb-8bd4af5585ce` 中，`tool/call seq20` 实际读取该文件，`tool/result seq21` 包含独立标记 `FOLDING_OFFICIAL_7E91C2`，`assistant/message seq25` 正确回答，`turn/end seq27` 为 completed。
- 会话 PASS：对官方会话分组执行展开/收起后，在新会话 `session-fd478f57-5f15-4f73-b849-d9e38636250e` 引用上一测试会话。`user/message seq9` 包含官方 `referenced-sessions` 快照（capturedThroughSeq 27），`assistant/message seq24` 根据快照给出相同标记，未重新读磁盘，`turn/end seq26` 为 completed。官方快照仅包含对话文本，没有附带上一轮工具记录；模型明确说明此边界。`seq18/21` 两次 TRANSPORT 自动重试后完成，保留该网络现象，不标为零重试。
- 导出：浏览器下载失败后，通过同一测试宿主已有认证的官方 `/api/session.export` 导出两份日志，HTTP 200，并核对头部 session id；ZIP 与原始 JSONL 仅在内存中解析，没有落盘副本。保存脱敏事件索引 `folding-e2e-events.json`，截图 `folding-model-read.png` / `folding-model-session.png`。
- 真实启动顺序边界：已核对宿主 `dsh-client-modules 0.2.1-rc.2` 的 `entries.start()`，它通过 `Promise.all(desired.plugins.map(...create))` 并发创建客户端插件；配置行先后不能证明 apply 先后。未修改宿主加载器或给实际包注入时序控制，两个实际浏览器启动顺序仍为 NOT_RUN；现有两种顺序的真实 apply / 控制器自动化证据保持有效。
- 用户正在另一个预览标签页查看其他插件设置，本轮使用另开的验收标签页，未重启 Web、未修改这些设置。验收草稿为空，保留完成结果供查看。Desktop、原生操作系统拖放仍未测试。

## 目录浏览隔离与灰色操作（2026-10-22）

- 官方 Tab 目录浏览通过公开 headers 面包屑接入 RA 的共享候选入口；目录内不调用命令、技能、本地 Agent、网页 AI、插件、网盘等 RA loader，返回根级恢复。官方同一 reference 来源中的会话候选在目录内隐藏，原始候选保留用于返回根级及卸载恢复。官方内部的会话查询仍由官方控制，此改动不声称阻止该内部请求。
- 复用已有灰色操作样式，补齐官方无描述文字的展开/收起标签识别，未新增配色系统。
- Red：隔离副本撤销两处修复，2 个行为断言失败 / 164 通过；最初隔离环境缺图片的收集失败不计 Red。Green：最终 npm run check 类型检查、1147 测试通过 / 8 skipped、build 成功；git diff --check 通过。
- Agent Web 3081：官方开启，Tab 进入 issue13-fixtures 再进入 folding，只显示文件；目录内继续输入 sample-0 保持隔离；返回父目录仍隔离，点击工作区回根级恢复会话与其他分组。Down + Enter 展开 6→11，Down + Tab 收起；展开及收起实际 computed color 均为 rgb(173,178,184)。截图 directory-gray.png。
- Web 启动初期尚未监听导致一次页面拒绝连接；误判后备用启动报 EADDRINUSE，检查宿主日志确认原启动已成功监听。最终使用 helper 启动的单一进程 93704；未改变端口或其他 Profile。最终浏览器验收草稿清空，未发送模型消息。
- 证据：directory-gray-check.log、directory-gray-red.log、directory-gray-tests.log、directory-gray.png。Desktop 与 3080 未改动，本轮未复测模型回答或原生拖放；未提交、推送或发布。

## 官方关闭复测（2026-10-22 12:45，Asia/Shanghai）

用户要求关闭 ui-reference，已仅在 Agent Web 3081 将 disabled 设为 true 并重启，最终监听进程 5012。启动较慢：最初就绪检查超时，随后确认监听与真实页面正常；日志提示 DeepSeek 模型列表网络失败后使用 bundled catalog。

真实 Web：RA 文件来源恢复，6→11 展开、Tab 收起后插入 sample-06.md，侧栏正文为 Issue 13 folding fixture 6；RA 会话来源 6→11 展开，Tab 收起后明确核对 7 行（6 个会话 + 展开项），Up+Enter 插入会话引用成功。截图 official-off-file-preview.png、official-off-session.png。草稿清空，保持官方关闭供用户测试。

边界：这是菜单、键盘、插入与文件预览复测；关闭状态下本轮没有发送模型消息、没有复测模型读取/会话快照回答、复制粘贴或 Desktop，不称为全部功能通过。此前完整 check 中 official-disabled 自动化用例通过。

## 官方开启性能适配（2026-10-22 13:06–13:17，Asia/Shanghai）

范围仍为 v0.5.0 独立 worktree，未改官方包、Remote 或缓存。修改三处：官方候选按数组身份和目录模式缓存解析；已投影列表在焦点/其他来源更新时直接复用；同批 DOM 变更对每个菜单只扫描一次；根级官方候选 ready 后不再等待 RA 前置来源才选中。展开/收起复用解析结果，配置、查询代次、目录状态及新候选仍触发必要更新。

- Red：新加的无重复解析、官方初始选择两项在旧实现失败（perf-red.log）。DOM 批量变更增加单次扫描断言。
- 自动化：最终完整 check 1150 passed / 8 skipped，typecheck/build 成功；真实官方 apply 两种顺序及禁用 3 项通过；当前宿主控制器两种顺序 × 文件/会话键盘 4 项通过。perf-check.log、perf-official-package.log、perf-host-keyboard.log。构建后仅调整 official-reference-menu.ts 缩进，无行为变化。
- 速度方法：相同 Edge、Agent Web workspace、查询 @issue13-fixtures/folding/，预热一次；每次清空草稿并等待菜单关闭，计时输入/ArrowRight 至 sample-06.md 可见。包含 CUA 调用开销，非内部 Remote 耗时。基线在 RA 从启动清单移除后测量；优化构建在 RA 和官方都启用、重启后测量。
- 纯官方 5 次：380、389、379、411、370 ms，中位数 380 ms。
- 优化后 5 次：305、1273、292、293、291 ms，中位数 293 ms。前一尝试首样本 311 ms，随后一次超过默认 3 秒等待窗口（超时诊断时元素已可见）；没有删除此异常事实。扩大等待窗口后获得上述完整五样本。不能由这些小样本声称比官方更快，也不能声称偶发卡顿已消除。没有未优化 RA 的同条件定量基线；未测冷启动、大工作区或空 @ 全列表耗时。
- 目录隔离：直接输入带 / 的路径属于官方全局查询，仍会显示其他来源。真实 Tab 进入 issue13-fixtures → folding、继续输入 sample-0，均只显示文件；点击父目录仍隔离，点击工作区根级恢复其他来源且首选官方文件。perf-directory-isolated.png。
- 功能：官方文件展开到 11 项后选取 sample-11.md，预览标记正确。当前宿主自动化验证文件/会话 Down Enter 展开、Down Tab 收起、Up Enter 插入。最新 Web 文件引用 sample-06.md 实际 read 后返回 Issue 13 folding fixture 6；随后另一会话引用该会话快照（capturedThroughSeq 56），正确返回相同正文，未重新读取磁盘。
- 端到端日志：官方账号 deepseek-account/deepseek-flash。文件会话 dee9cc51… 第二轮 completed seq56；seq39/42 两次 TRANSPORT 重试后成功。会话 fd478f57… 第二轮 completed seq41。官方 export HTTP200，ZIP/JSONL 在内存解析，保存脱敏 perf-e2e-events.json；截图 perf-file-read.png、perf-session-read.png。
- 边界：没有重新验证复制粘贴、原生 OS 拖放或 Desktop；没有强制切换浏览器真实启动顺序。当前官方和 RA 均开启供用户测试，草稿清空。未提交、推送、发布。

## 偶发等待定位与无效导入状态扫描修复（2026-10-22）

- 先排除一次测试误判：新会话选中了 dsh-reference-anything 工作区，测试文件实际在 agent-browser-test/workspace；当次官方来源 160 ms 已返回，没有文件匹配，不是查询超时。之后固定已有 workspace 会话进行连续测量。
- 根因证据：RA 的 agentSearch 在查询/工作区过滤后即使没有匹配项，也会对所有扫描请求调用 Chat Import scanDiscover 补充 importStatus。该 API 每次都先 listPersistedHeaders，再做各来源发现；并发重复枚举会与官方 sessionQuery.listSessions 争用 I/O。禁用 Chat Import 的 DSH 来源不能消除此共有步骤，Codex/Claude 等扫描也会执行。
- 修复：仅收集贡献了匹配、去重后候选的扫描请求，为这些请求补充导入状态。空结果不调用 Chat Import；重复根目录不重复补充。没有增加缓存或改变 TTL，没有修改官方查询、codec、权限、引用读取或导入确认。
- Red/Green：新增 web.spec.ts 用例在旧代码出现 3 次多余 API 调用而失败；修复后无匹配 0 次、匹配 Codex 只查贡献结果的 custom 根目录 1 次。原有精确路径匹配、导入绑定、API 失败仍可引用、关闭来源等用例通过。stall-red.log / stall-green.log。
- 宿主诊断构建：修复前 12 次 UI 查询 [557,2022,260,360,1455,439,246,317,297,320,351,3132] ms；对应文件 list 为 1–7 ms，sessionQuery 峰值 2916 ms、sessionReferenceResolver 峰值 2923 ms。修复后同条件宿主 sessionReferenceResolver 27–88 ms，文件 list 1–4 ms。计时只记录方法与耗时，不记录查询或凭据，临时包装和 PerformanceObserver 均已移除。
- 不隐瞒残留：修复后第一次 20 次 UI 测量仍有 1286–3163 ms 样本；宿主已快，浏览器同时出现约 1 秒长任务。后续增加长帧归因时，长帧与长任务不能混为一谈，未获得足够证据归因到某个产品脚本或自动化扩展。不能声称所有启动/重载停顿已修复。稳定运行后另测路径 30 次 293–347 ms、空 @ 10 次 303–571 ms，无秒级等待。
- 自动化：最终完整 check 1151 passed / 8 skipped，typecheck/build 成功；当前宿主 0.2.1-rc.2 控制器两种加载顺序 × 文件/会话键盘 4 项通过。stall-check.log / stall-host-keyboard.log。源码和构建产物无 RA-PERF 诊断代码。

- 最终无诊断构建（监听 PID 93520）：路径查询 20 次 [1334,294,290,285,289,276,300,282,285,280,272,286,271,295,285,285,288,287,299,290] ms；首样本 1334 ms，其余 19 次 271–300 ms，中位数 286.5 ms。根级空 @ 10 次 [628,358,364,377,366,381,727,281,388,267] ms，中位数 371.5 ms。保留首样本，不宣称零卡顿或全场景延迟上界。证据 stall-final.json。
- 最终 Web 功能：Tab 进入 issue13-fixtures 再进入 folding，只显示文件；Down×6 + Enter 展开 6→11，Down + Tab 收起到 6；Up + Enter 插入 sample-06.md，DOM data-composer-chip 为 reference。截图 stall-final-directory.png。草稿已清空；官方与 RA 均开启供用户测试。
- 边界：仅 Agent Web 3081，Desktop/用户 Web 3080 未重启。本轮未重复模型发送、复制粘贴、文件预览或原生 OS 拖放；未新增公开配置、未删除 Chat Import 来源、未提交或发布。

## 本地 Agent 操作二级菜单隔离（2026-10-22）

- 用户反馈：进入导入确认页后网页 AI 等分组仍显示。根因是本地 Agent 只替换自身候选，菜单仍保留其他来源及其异步更新。
- 修复复用现有控制器菜单适配：以本地 Agent 的 agent-back 动作识别操作/确认页，只保留该分组，并把落在其他来源的键盘焦点移回首个动作；返回列表重新生成来源列表后恢复。未按中文标签或 agents 快捷词判断，导入确认、错误/忙碌状态和执行路径未修改。此项为显示隔离，不宣称取消官方内部查询。
- Red：新增回归在旧代码因仍含其他分组失败；Green：完整 check 1152 passed / 8 skipped，类型检查与 build 成功。回归涵盖官方和 RA 来源隐藏、异步更新不重新显示、键盘焦点保持、返回同名查询的初级列表恢复。证据 agent-isolation-red.log / agent-isolation-check.log。

- 最终 Agent Web 3081（PID 38620）实测：在独立标签页从“添加 ASCII Kanji Sharks 样式”的导入入口进入，菜单仅有“本地 Agent 对话 / 确认导入并继续 / 返回对话列表”，其他来源消失；Down + Enter 返回 @ 根级后，命令、技能、网页 AI、网盘等来源恢复。截图 agent-isolation-confirm.png。未点击最终确认，没有实际导入或发送消息，测试草稿清空。Desktop / 3080 未改动；本轮未重测模型读取或原生拖放。

## 官方分组显示开关与排序（2026-10-22）

- 官方仍只注册/查询一次 reference，RA 不增加文件或会话 Remote 请求、不复制官方缓存。展示适配将官方会话行放入独立菜单分组，使 files/sessions 的 enabled、order 分别生效，并能与命令、技能、本地 Agent 等 RA 来源交错排序。文件保留 reference 菜单分组，独立会话分组的选中动作转交原 reference.pick，插入 owner/codec 仍为 reference；未注册第二份引用来源。
- 每个官方 section 的折叠/展开保留；关闭分组只隐藏候选，不撤回既有引用或禁用后端读取。开关恢复复用本次官方原始候选；未知未来候选契约仍回退官方完整结果。原生滚动模式同样遵守开关与排序。
- Red：新增两个显示开关和跨来源交错排序回归在旧实现失败。最终自动化 check 1155 passed / 8 skipped，类型检查、build 通过。当前宿主 0.2.1-rc.2 的两种加载顺序 × 文件/会话键盘操作四项通过。额外回归覆盖关闭两组后恢复、行身份与焦点保持、原生滚动开关、卸载恢复及无重复 JSON 解析。证据 official-order-red.log、official-order-check.log、official-order-host-keyboard.log。
- Agent Web 3081（PID 33248）实测：关闭文件时仅保留官方会话；两个开关都关闭后官方候选为 0、其他来源仍显示。拖动 DSH 对话到命令与技能之间，DOM 实际顺序为 Commands → official-sessions → Skills → reference（文件），验证独立交错排序。
- 排序后会话键盘 Down/Enter 展开 6→11、Down/Tab 收起到 6，Up/Enter 插入第六项；文件同样展开、收起并插入 sample-06.md。两种插入的 data-composer-chip 均为 reference。没有发送模型消息或执行导入。
- 已通过 UI 恢复原排列（命令、技能、文件、DSH 对话、本地 Agent、网页 AI、网盘、本地插件）和全部八个显示开关，测试草稿与引用芯片已清空。截图 .codex-tmp/issue-13/official-order-settings.png。官方 ui-reference 与 RA 保持开启供亲测。
- 限制：本轮只验收 3081，没有重启或验证 Desktop/3080；没有重新量化速度、复制粘贴或原生 OS 拖放。一次逐字输入操作超时停在 @issue13-，读取页面状态后改为完整输入完成后续测试，不将此作为无卡顿证据。两种加载顺序为真实宿主控制器自动化验证，未强制浏览器启动顺序。
