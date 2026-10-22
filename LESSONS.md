# 可复用教训

开发或排障时阅读。只保留规则、原因和证据；新增与晋升要求见 [复盘](docs/development/retrospective.md)。历史记录为本地证据，不要求上传。当前五条均为观察中、各有一个独立日期：L-001/002/003 为 2026-10-18，L-004/005 为 2026-10-19；晋升前继续记录独立日期证据。

## L-001：后台程序不能继承同步命令的输出管道

- 规则：Windows 上通过同步子进程启动常驻应用时，将输出直接写入文件，并单独验证启动命令能正常返回。
- 原因：本次双环境刷新已启动 Web/Desktop，但 Electron 后代持有管道，上层 Node 命令无法结束；仅检查服务存在未发现这个问题。
- 证据：`scripts/agent/workflow.mjs` 的 sync 使用文件描述符；本次实际复测日志 `.codex-tmp/agent-workflow/sync.log`，命令退出码 0。

## L-002：profile 的设置目录不等于会话目录

- 规则：验证测试环境隔离时，分别核对设置存储和宿主 session persistence 的实际根目录，并在真实页面检查是否仍显示日常会话。
- 原因：本次 Web 冒烟发现 `storage-json` 已独立，但宿主 `session-persistence-jsonl` 仍默认使用共享 DSH_HOME/sessions；仅检查前者不足以证明隔离。
- 证据：宿主 `dsh-base/cordis.patch.yml` 的两个独立配置项；刷新脚本现已要求两项均指向测试 profile。没有修改或删除原日常会话。

## L-004：自然请求验收不能附加用户未要求的限制

- 规则：自然请求按用户意图验收；“现在做到哪了”可以包含实时状态检查。分别判断引用读取、外部产物存在性与回答依据，不能因旧文件缺失就归咎于引用框架。
- 原因：本次把检查实时目录判为范围偏离并提前停止多引用测试，用户指出旧任务可能已手动清理。复核发现 OpenCode 会话与正文仍在、DSH 读取正常，缺失的是临时产物目录；删除原因无法证明。
- 证据：`docs/development/tasks/local-reference-protocol.md` 的累计 Web 记录及官方日志事件编号。

## L-005：替换官方菜单必须审计原生引用 owner 与宿主版本

- 规则：禁用官方 UI 插件时，遍查其全部注册项及固定 owner 的调用方；分别验证候选插入、原生 drop/paste、复制、发送、预览和消息渲染，明确检查的上游版本。
- 原因：RA 菜单正常和关闭 RA 后官方菜单恢复，不能证明原生 `source: 'reference'` 可序列化；本机旧包也不能反证新版 `ui-reference` 已迁入的 userText 规则与文件卡片。
- 证据：[兼容审计](docs/development/tasks/native-reference-compatibility.md)，含旧实现失败的 codec/图标回归、官方源码版本、真实 Web 发送及官方 Session Log 事件定位。

## L-003：宣传卡文字核对不能替代布局验收

- 规则：长 Markdown 与 GIF 卡片必须查看实际截图，检查弹窗、媒体和翻页按钮是否处于视口内；安装新包后分别核对磁盘版本与宿主实际加载版本。
- 原因：双语卡片验收只核对文本与语言，遗漏长文案撑出屏幕；用户安装 0.5.0 后旧宿主仍显示 0.4.4。
- 证据：`docs/testing/releases/0.5.0-acceptance-report.md` 第 13、14 节及对应截图。

## L-006：候选附加状态查询也会拖慢官方来源

- 状态：观察中。
- 规则：候选过滤后只补充实际匹配项需要的附加状态；性能排障分别记录宿主查询、客户端投影与浏览器停顿，固定测试工作区。
- 原因：RA 无匹配的本地 Agent 查询仍调用多个 Chat Import scanDiscover，每次枚举 DSH 持久化会话，官方会话查询曾达 2923 ms；移除无效调用后宿主测得 27–88 ms，但重载期浏览器仍有另一类停顿。
- 证据：[issue #13 累计记录](docs/development/tasks/issue-13-reference-ownership.md)；web.spec.ts 无匹配零调用及重复根目录回归。
- 观察日期：2026-10-22（Asia/Shanghai），Seen 1。
- 验证：Red/Green 与 1151 项测试通过；稳定 Web 连续查询已测，未声称消除所有重载停顿。
- 晋升：未达到三个独立日期，暂不晋升。
