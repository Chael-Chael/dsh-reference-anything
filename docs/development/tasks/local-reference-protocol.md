# 本地 Agent 引用协议重构

- 用户目标与授权：2026-10-19 实施新协议，完成真实 Web 验收；追加简单/复杂模糊请求和 Codex 长会话带图专项。测试会话使用“仅可查看”。不发布、不导入真实历史。
- 状态：代码已实施，自动检查、长 Codex 带图和协议矩阵已完成。2026-10-19 用户澄清后复核：OpenCode 引用读取正常，不能把临时产物缺失或实时检查本身判为 DSH 故障；多引用被主动中断，验收未完成。仍有回答因果表述问题及未验项目，不能宣称全部案例通过。
- 基线 HEAD：8a97bd4825235f4f5c9cb498bbe50a45b64374a4；改动尚未提交。
- 保留用户已有 AGENTS.md 与两份协议文档，不回滚其他改动。

## 实现边界

- 本地四工具 reference_list/read/search/image：ref/revision、part、from、可直接复制的 next；消息/工具/图片独立编号；严格参数校验、码点连续分块、单份正文、英文说明。
- pre-hook 遍历本批所有直接用户消息，引用背景跟随所属消息；共享 16 KiB 预算，未知预算保留定位；批内复用解析，不保留正文缓存。
- 来源开关、允许目录、realpath、原会话身份每次重验；图片清单与像素分离；只根据明确来源标记映射 summary。
- 非本地读取保留现有实现，改用 external_reference_list/read，避免旧参数进入新的本地 schema。调用方、配置、双语 README、契约、子系统入口和测试同步更新。
- 修复 Vibe 解析器合成随机 callId 导致 revision 不稳定；原始工具参数已是文本时不再重复 JSON 转义；目录版本包含来源配置变化。

## 已完成验证

| 检查 | 结果 / 证据 |
| --- | --- |
| 全量类型检查、单测、build、双环境刷新 | PASS；1122 passed、8 skipped；`.codex-tmp/agent-workflow/verify-1792388243464/`，最终业务代码对应第三次完整检查 |
| 真实语料专项 | PASS；4 项；`.codex-tmp/local-protocol-corpus-final.log`。这是原扫描器专项，不代替新协议专项 |
| 重复转义 red/green | PASS；隔离副本恢复重复转义后精确断言失败，现实现通过；`.codex-tmp/protocol-red-escaping.log` |
| 权限 break check | PASS；隔离副本绕过来源开关后被测试抓住；`.codex-tmp/protocol-break-source.log` |
| 分页 break check | PASS；隔离副本让 next 跳过一个码点后重组断言失败；`.codex-tmp/protocol-break-pagination.log` |
| 新协议真实 Codex 全量重组 | PASS；165327276 字节与 43917199 字节两条真实历史，共 411 页；正文、工具全文逐条等于规范化源文本，图片目录无漏项、revision 稳定、每页 ≤16384 字节；`.codex-tmp/local-protocol-web/codex-long-check.json` |
| 165 MB Codex 统计 | 179 条正文 / 522 条工具 / 186 图片条目；分页 5/83/2；预览为 133–179，15762 字节（测试标题） |
| 44 MB Codex 统计 | 250 条正文 / 1696 条工具 / 26 图片条目；分页 9/311/1；预览为 216–250，15932 字节（测试标题） |

8 个默认跳过项中的 4 个真实语料测试已单独启用通过。剩余 4 项：文件来源与本地会话来源各一个文件符号链接测试（Windows EPERM）、一个仅 POSIX 的附件符号链接路径语义测试、一个需指定官方 Desktop executable 的 OpenCLI 集成测试。新协议自己的 junction 目录逃逸测试通过，不代替这些跳过项。构建日志里官方依赖缺 source map 的警告不影响退出码；没有改动第三方依赖。

## 真实 Web 累计记录（尚未放行）

环境：agent-browser-test，http://127.0.0.1:3081/，DeepSeek 官方账号 deepseek-account / deepseek-flash（Flash 1017）。各轮单独记录推理等级。原始来源只读。

| 案例 / sessionId | 结果与证据 |
| --- | --- |
| 精确协议初测 / session-66f6eb47-688a-48cb-9b7e-1d9a83dd727a，High | 首轮六次工具成功（seq 22–33），随后模型请求 TRANSPORT 失败（seq 36–53）；续轮正确复述两条正文，但不算完整协议验收。还发现工具参数重复转义，已修复 |
| 简单模糊请求初测 / session-cb7d7272-486f-4cb8-9a3a-b5326d01a062，Low | “帮我看看这段聊了什么，现在做到哪了？”；读引用成功后查本机技能/目录，被主动停止；pwsh 在分派前取消，未执行写入。补充公共说明后复测 |
| 简单模糊请求复测 / session-f2d665d0-b5e7-4dee-b033-afdc4d060fa3，Low | 引用 read/search 正常，能找出正文未披露的历史工具失败；工作区修改模式遇到宿主 Win32 5 ACL 错误，改只读后续轮完成。但将目录缺失归因为系统清理，缺证据，回答准确性 FAIL |
| 最终说明下同题复测 / session-eb46fc26-adc6-4127-8e8f-53f1400038a8，Low、只读 | 引用读取与工具分块 PASS。最初把实时检查与回答因果问题合并判失败；用户澄清后撤销实时检查属于框架失败的判定。“临时目录被系统清理”仍缺删除原因证据，仅作为回答准确性问题保留；当前原始会话与临时目录核验见下文 |
| Codex 44 MB 长会话 + 图片自然请求 / session-e66f2a68-a56e-46c6-93cb-94277ea63529，第 1 轮，Low、只读 | 读取与首图理解 PASS；“这段长对话最早在修什么？最开始那张截图反映了什么问题，后来到底修好没有？帮我捋清过程和证据。”无工具或字段提示。模型从尾部预览回读开头，正确识别首图 `@claude-code:` 误列 Codex、第一次修复后复现、自定义别名覆盖默认名的第二次修复，并区分部分 Desktop 验收。也去查了实时仓库，历史范围约束未通过；其“后续没有补完全部矩阵”的全局否定未逐条穷尽验证，因此整条自然请求不标全项 PASS |
| Codex 精确协议矩阵 / 同 session 第 2 轮，Low、只读 | PASS；工具长文本续页、图片所属范围与全局续页、搜索 position 复制读取、目录 revision/next 翻页、错误 revision 拒绝和省略 revision 起点恢复，均对照官方工具结果断言。模型最终输出 PROTOCOL-MATRIX-END |
| 简单自然概括 / session-c95da9fa-143e-4772-8953-622f8c320711，第 1 轮，Low、只读 | 概括目标 PASS；真实 OpenCode 引用 + “这段聊天主要在说什么？简单概括一下。”仅依据包含全部 15 条消息的预览，概括论文翻译、396 段、53 批术语、7 批翻译，指出未见最终译文。1 步、约 5 秒，无工具调用；这里只验概括，不证明历史完成声明均由工具核实 |
| 跨来源自然请求 / 同 session 第 2 轮，Low、只读 | BLOCKED（主动中断，验收未完成；原 FAIL 判定撤回）；新增真实 Claude 引用 + “加上这段，帮我分别概括这两个任务，哪些有完成证据，哪些还不能说做完了。”执行 14 次 pwsh 与 2 次 grep 检查当前状态；停止时最后一个命令取消，无最终答案。用户认可模糊状态询问可以检查当前文件，不能仅因这类检查或未调用额外引用工具判失败；自动预览已提供历史内容 |

模型请求期间多次 TRANSPORT，部分自动重试后恢复；发生于工具调用前后，不能归结为引用解析失败，也不能宣称已修复账号传输。工具结果正常而模型转去查当前文件，是观察到的行为；没有证据将根因确定为推理等级、某个模型或宿主某一机制。

### Codex 官方日志交叉断言

- 自然请求工具轨迹：seq 36–39 从 messageId=1 读取正文与图片目录；seq 47–49 返回首图真实 image block；全轮读取 imageId=1/12/7/6/5，共 5 张。ZIP 内这 5 张媒体的 SHA-256 均与原 Codex 会话中图片字节一致。没有把目录项当作已看图。
- 工具 14：seq 188–195 两页分别从 offset=0、15336 读取；完整复制 next。拼接得到 29554 码点，严格等于当前来源解析器的规范化工具正文。它不等于原始 JSON 外层封装字符串，比较基准明确采用规范化正文。
- seq 200–213 验证 messageId=1 只含 imageId=1，范围 next=null；全局目录依次返回 imageId=1、2，next 分别为 2、3。
- seq 218–225 搜索“默认快捷短语”得到 `{messageId:2,textOffset:54}`，完整复制到 read.from；seq 230–237 保持相同目录 revision/query，next.index=2 读取第二页。
- seq 248–249 为预期 REVISION_CHANGED；seq 269–270 省略 revision 从正文起点成功恢复。
- 原样 next 复制的精确矩阵通过。自然请求有一次把 `{messageId:56,textOffset:22}` 简化成 messageId=56，重复读取前 22 码点；未漏字，但不能称为该轮所有游标都被正确复制。
- 411 页后端重组覆盖 165 MB 与 44 MB 两条；真实模型 Web 读图专项只运行了 44 MB 条，未把 165 MB 后端验证计作 Web 验收。
- 脱敏断言结果：`.codex-tmp/local-protocol-web/codex-web-assertions.json`；去正文工具轨迹：`codex-tool-audit.json`；新增自然请求事件摘要：`natural-audit.json`。界面证据：`codex-matrix.png`、`vague-summary.png`。
- Windows Expand-Archive 不接受官方 ZIP 的 `media/sha256:...` 文件名；改用 Python zipfile 在内存读取媒体校验，没有改原包，也没有把解压报错算作协议失败。

### 用户澄清后的 OpenCode 来源复核（2026-10-19）

- 用户认为该旧任务可能被自己清理，不应归咎于 DSH。只读查询原 `opencode.db` 中 session `ses_fcbc6c8c9ffeTVVLMKvpltA0m0`：会话仍存在，标题为“Zotero翻译论文为中文”，创建于 2026-08-24 22:42:40，更新于 23:31:43（北京时间），time_archived=null；31 条数据库 message、126 条 part，其中 36 条工具 part。
- 使用当前 DSH 来源解析器重新读取成功：15 条规范化正文、72 条工具记录、0 张图片。数据库 message 包含非正文记录，36 条工具 part 拆为调用/结果共 72 条，不与正文数混算。证据：`.codex-tmp/local-protocol-web/opencode-source-check.json`。
- 原始数据库工具错误包含 `Upstream request failed: Endpoint is unavailable` 和 3 条 `Task cancelled`；这些属于 8 月的 OpenCode 历史执行记录，不是本次 DSH 读取报错。
- 当前 `C:/Users/27923/AppData/Local/Temp/zotero-translate-runs` 不存在；`D:/Zotero_Docs/storage/8MQYNMFX` 存在，包含原英文 PDF 和 Zotero 缓存，没有该目录下的中文译本。没有全盘搜索，也不能据此证明历史上从未生成过译本。
- 结论：原始会话没有被整条删除；缺失的是历史临时产物目录。与用户所述可能清理过文件相符，但未取得删除者、时间或机制证据。此样例不构成 DSH 引用读取故障；“系统自动清理”属于回答的不确定因果，不能升级为框架 bug。
- 验收口径修正：“现在做到哪了”“哪些有完成证据”可能合理包含实时状态核查；不得把测试者未声明的“只能看历史”当作用户要求。仍需区分历史记录、当前检查和推断。此前过严判定已记录撤回，不把未完成的多引用测试改成 PASS。

## 未放行项与后续边界

- 模糊状态询问不因实时核查本身判失败；不确定的文件缺失原因仍需谨慎表述。多引用端到端回答未完成，保留 BLOCKED；不能把简单概括成功代替它，也不禁用宿主工具来制造 PASS。
- Desktop 已同步重启；实际窗口验收 NOT_RUN（当前工具未提供 native app 控制）。npm 包安装、发布和全来源发版矩阵 NOT_RUN，本任务未授权发布。
- 总 token 节约率未进行旧/新协议同题同模型配对实验；单次返回预算通过不等于整题总 token 必然下降。
- 本版有意不兼容旧本地参数；旧直接调用需迁移到 ref/part/from。非本地调用名也已迁移到 external_reference_list/read。

## 收尾

- 最终业务代码检查通过后只更新验收与复盘文档；最终 git diff --check 通过，已审阅实际实现差异并运行 agent:retro（材料 `.codex-tmp/agent-workflow/retro-1792391119138.txt`）；未提交、推送或发布。
- 临时官方 ZIP、解压副本和原图副本清理：BLOCKED。在 PowerShell 中验证目标位于指定临时根目录后尝试删除，本次 exec_command 在执行前被自动审批策略拒绝，唯一原因文本为 `blocked by policy`，未执行删除。没有改用其他执行方式绕过。
- 待清理范围：Downloads 下本报告六个 session 对应的 `dsh-session-session-<id>.zip`；`.codex-tmp/local-protocol-web/` 下 `failure/`、`vague-failure/`、`vague-retest/`、`vague-final/`、`codex-pass/` 五个解压目录，以及 `source-image.png`、`codex-01a148d6-905b-7a32-868c-56d43cd305a8.png`、`codex-01a14a41-477d-7191-951e-064ca085e33a.png` 三个来源原图副本。报告对应的六个 session 为 66f6eb47、cb7d7272、f2d665d0、eb46fc26、e66f2a68、c95da9fa 开头的上述完整 ID。
- 原 DSH 会话、真实来源和脱敏统计/界面截图不属于删除范围。临时日志含真实历史内容；在完成清理前仍占本机磁盘。
