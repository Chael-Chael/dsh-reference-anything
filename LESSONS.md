# 项目复盘账本

## L-055：GitHub Release 图片不能沿用仓库相对路径

- 2026-10-30：v0.5.2 正文直接复制仓库 README，demos/new-local-sources.gif 在 Release 页无法解析。发布前转换 Markdown 图片为原发布 SHA 对应的 raw.githubusercontent.com 绝对 URL；保留正文及仓库内相对链接。正常与恢复 workflow 共用转换脚本。

## L-054：npm 接受上传与版本公开是两个阶段

- 2026-10-30：Actions 41050564137 的 npm publish 返回成功并提示处理中，随后约五分钟查不到版本使整个发布 job 失败。上传与核验拆成独立 job，核验增加等待；重跑失败 job 不重复上传。GitHub Release 必须显式创建，不会随 npm 自动同步。
- 入口：docs/development/workflow.md 的 GitHub Actions 发布。

## L-053：本机 npm 认证失败不代表 CI 发布受阻

- 2026-10-30：archive 分支保留 release.yml 与 OIDC 发布脚本，但当前 main 未包含它们。判断发布阻塞前检查归档分支、workflow 与 npm-release 环境；本机 E401 仅证明本机认证失败。
- 恢复入口见 docs/development/workflow.md 的 GitHub Actions 发布；OIDC 是否有效仍须实际发布验证。

## L-052：跨平台清理与验收不能依赖 Windows 假设

- 状态：观察中，2026-10-30。
- Linux CI 实测删除后新建同名文件可复用 inode；附件清理仅比较 dev/ino 会误删替换文件。身份核对增加 birthtime，保留目录身份和非递归清理；确定性复用 inode 回归在旧实现失败、新实现通过。
- OpenList 权限测试必须分别验证 Windows ACL 与 POSIX chmod，不能在所有系统期待 ACL 调用。
- 真实语料测试须按被测适配器选样；不能将最大 .jsonl.zst 直接交给只支持 .jsonl 的原生读取器。修正选样后仍须保留新暴露的文本预算失败，不以选样修正宣称整个测试通过。
- 证据：[0.5.2 累计验收](docs/testing/releases/0.5.2-acceptance-report.md)，首次三平台 CI 与 inode red/green。未晋升通用规范。

每次任务开始阅读。只记录有证据的返工、验收遗漏或有效做法；用户决定写环境/标准文档，不伪装成事故。

## L-001：后台程序不能继承同步命令的输出管道

- 状态：观察中
- 规则：Windows 上通过同步子进程启动常驻应用时，将输出直接写入文件，并单独验证启动命令能正常返回。
- 原因：本次双环境刷新已启动 Web/Desktop，但 Electron 后代持有管道，上层 Node 命令无法结束；仅检查服务存在未发现这个问题。
- 证据：`scripts/agent/workflow.mjs` 的 sync 使用文件描述符；本次实际复测日志 `.codex-tmp/agent-workflow/sync.log`，命令退出码 0。
- 观察日期：2026-10-18（Asia/Shanghai），Seen 1。
- 验证：`npm run agent:sync` 完成后返回，两进程刷新；服务可达与真实 UI 验收仍分别报告。
- 晋升：未达到三个独立日期，暂不晋升。

## L-002：profile 的设置目录不等于会话目录

- 状态：观察中
- 规则：验证测试环境隔离时，分别核对设置存储和宿主 session persistence 的实际根目录，并在真实页面检查是否仍显示日常会话。
- 原因：本次 Web 冒烟发现 `storage-json` 已独立，但宿主 `session-persistence-jsonl` 仍默认使用共享 DSH_HOME/sessions；仅检查前者不足以证明隔离。
- 证据：宿主 `dsh-base/cordis.patch.yml` 的两个独立配置项；刷新脚本现已要求两项均指向测试 profile。没有修改或删除原日常会话。
- 观察日期：2026-10-18（Asia/Shanghai），Seen 1。
- 验证：启动前配置断言与真实页面复查，见本次流程验证报告。
- 晋升：未达到三个独立日期。环境隔离本身是用户已要求的不变量，此条记录具体遗漏机制。

## L-004：自然请求验收不能附加用户未要求的限制

- 状态：观察中。
- 规则：自然请求按用户意图验收；“现在做到哪了”可以包含实时状态检查。分别判断引用读取、外部产物存在性与回答依据，不能因旧文件缺失就归咎于引用框架。
- 原因：本次把检查实时目录判为范围偏离并提前停止多引用测试，用户指出旧任务可能已手动清理。复核发现 OpenCode 会话与正文仍在、DSH 读取正常，缺失的是临时产物目录；删除原因无法证明。
- 证据：`docs/development/tasks/local-reference-protocol.md` 的累计 Web 记录及官方日志事件编号。
- 观察日期：2026-10-19（Asia/Shanghai），Seen 1。
- 验证：撤回实时检查导致框架失败的判定；OpenCode 当前读取 PASS，删除原因只留回答准确性备注，多引用中断记 BLOCKED，不改为 PASS。精确协议与自然请求仍分别记录。
- 晋升：未达到三个独立日期，暂不晋升。

## L-005：替换官方菜单必须审计原生引用 owner 与宿主版本

- 状态：观察中。
- 规则：禁用官方 UI 插件时，遍查其全部注册项及固定 owner 的调用方；分别验证候选插入、原生 drop/paste、复制、发送、预览和消息渲染，明确检查的上游版本。
- 原因：RA 菜单正常和关闭 RA 后官方菜单恢复，不能证明原生 `source: 'reference'` 可序列化；本机旧包也不能反证新版 `ui-reference` 已迁入的 userText 规则与文件卡片。
- 证据：[兼容审计](docs/development/tasks/native-reference-compatibility.md)，含旧实现失败的 codec/图标回归、官方源码版本、真实 Web 发送及官方 Session Log 事件定位。
- 观察日期：2026-10-19（Asia/Shanghai），Seen 1。
- 验证：1130 项测试通过；Web 桥接模拟与真实文件读取通过；Desktop 按用户要求暂缓，新版完整宿主 UI 未运行，两者均不写 PASS。
- 晋升：未达到三个独立日期，暂不晋升。

## L-006：候选附加状态查询也会拖慢官方来源

- 状态：观察中。
- 规则：候选过滤后只补充实际匹配项需要的附加状态；性能排障分别记录宿主查询、客户端投影与浏览器停顿，固定测试工作区。
- 原因：RA 无匹配的本地 Agent 查询仍调用多个 Chat Import scanDiscover，每次枚举 DSH 持久化会话，官方会话查询曾达 2923 ms；移除无效调用后宿主测得 27–88 ms，但重载期浏览器仍有另一类停顿。
- 证据：[issue #13 累计记录](docs/development/tasks/issue-13-reference-ownership.md)；web.spec.ts 无匹配零调用及重复根目录回归。
- 观察日期：2026-10-22（Asia/Shanghai），Seen 1。
- 验证：Red/Green 与 1151 项测试通过；稳定 Web 连续查询已测，未声称消除所有重载停顿。
- 晋升：未达到三个独立日期，暂不晋升。

## L-007：功能卡按页渲染不等于媒体按需加载

- 状态：观察中
- 规则：检查构建产物和 npm 包，不能仅凭 UI 每次只渲染一张图片就判断启动时未携带全部媒体。
- 原因：0.5.1 构建将所有卡片 GIF 编成 data URI，客户端达到 34,825,059 bytes；按页渲染没有消除这部分 JS 载荷。
- 证据：[Issue 15 验证记录](docs/development/tasks/issue-15-release-media.md)；远程 URL 后客户端为 2,889,956 bytes，实际包中无 GIF。
- 观察日期：2026-10-28，Seen 1。
- 验证：完整 check 通过，全部远程图片内容哈希一致；真实双端 UI 和运行时内存对照仍未完成，不将文件缩小等同于已测内存收益。
- 晋升：未达到三个独立日期。

## 新条目模板

### 2026-10-29 验收补记

- 跨分支测试应独立 storage/session：main 新增 provider 数据会使旧基线 schema 拒绝，不能把这种环境污染归因于候选补丁。
- 前缀验收先核对引用入口 owner：测试 profile 显式启用官方 ui-reference 时，文件搜索由官方入口处理。每条查询使用新页面并等待目标候选，不能用固定短等待或上一查询残留项判定结果。
- DSH 会话 zstd 文件可包含多个 frame；只解压首帧只能看到 metadata，不能据此判断消息丢失。逐帧解压并与真实 UI 对照。
- 证据：[Issue 15 累计验收](docs/testing/releases/0.5.1-issue15-20261029.md)。本次观察，不晋升通用规范。

## L-003：宣传卡文字核对不能替代布局验收

- 状态：观察中。
- 规则：长 Markdown 与 GIF 卡片必须查看实际截图，检查弹窗、媒体和翻页按钮是否处于视口内；安装新包后分别核对磁盘版本与宿主实际加载版本。
- 原因：双语卡片验收只核对文本与语言，遗漏长文案撑出屏幕；用户安装 0.5.0 后旧宿主仍显示 0.4.4。
- 证据：`docs/testing/releases/0.5.0-acceptance-report.md` 第 13、14 节及对应截图。
- 观察日期：2026-10-18（Asia/Shanghai），Seen 1。
- 验证：六张卡片实际 DOM 尺寸、GIF contain、可见底栏与新版截图已核对；窄窗口与 Desktop 实际窗口仍待验收。
- 晋升：未达到三个独立日期，暂不晋升。

```markdown
## L-001：简短标题
- 状态：观察中 / 已晋升 / 已失效
- 规则：一句可执行的规则。
- 原因：真实失败或做对了什么，影响是什么。
- 证据：commit / issue / 本地报告路径和具体检查结果。
- 观察日期：YYYY-MM-DD（Asia/Shanghai）；同一天多次只算一次。
- 验证：修复有效的证据，包括 red/green 或真实界面验证。
- 晋升：第三个不同日期再次出现时，链接到 standards.md 中对应规则；未达到写“未达到”。
```

允许记录 Done right，不为了凑数量编造历史。晋升后保留证据并链接唯一规则，不复制两份规则正文。

## L-0263：新增来源要测目录发现及多文件版本
- 状态：观察中。
- 规则：升级上游扫描器时同时测试显式文件和实际目录布局；目录型数据库的版本必须包含子文件，不能只看目录 mtime。
- 原因：Copilot VS Code 显式 JSON 可读取，但目录发现只接受 chatSessions 布局；豆包 LevelDB 的已有文件更新不一定改变目录时间。
- 证据：`tests/local-conversation-scanner.spec.ts`、`tests/local-conversation-reader.spec.ts`、`docs/development/tasks/chat-import-0263-sources.md`。
- 观察日期：2026-10-30，Seen 1。
- 验证：两种 Copilot 的目录发现、豆包子文件变更使旧 revision 失效、非普通文件拒绝读取均已回归。
- 晋升：未达到三个独立日期，暂不晋升。
