# DSH Web 演示与 GIF 制作流程

本流程使用真实 DSH Web 和插件界面，配合隔离的演示数据录制。用户于 2026-10-17 确认：以后更新 GIF 继续使用这个环境；保留以前 HTML 制作的 GIF。

## 1. 文件与职责

| 文件或目录 | 用途 |
| --- | --- |
| `scripts/web-demos/start.mjs` | 启动独立 DSH Web，保存地址和 PID |
| `scripts/web-demos/prepare.mjs` | 备份旧动画，把当前编译产物复制到演示环境，注入演示服务 |
| `scripts/web-demos/fixtures.mjs` | 虚构会话、网页对话、导入与升级结果 |
| `scripts/web-demos/record.mjs` | 操作真实界面、录屏、导出 MP4 和 GIF |
| `.codex-tmp/web-demos/` | 可复用的独立配置、插件副本、工作区和状态 |
| `demo-recordings/web-时间戳/` | 每次新录制的输出，不覆盖前一版 |
| `demo-recordings/html-original-时间戳/` | 旧 HTML 源码、预览与 GIF 的备份 |

以下命令均在 Windows PowerShell、仓库根目录执行：

```powershell
Set-Location D:\dsh-reference-anything
```

依赖：Node.js、已安装的 DSH CLI、Microsoft Edge、Playwright、PATH 中的 ffmpeg 和 ffprobe。当前启动器按 `%APPDATA%/npm/node_modules/@deepseek-ai/dsh/lib/bin.js` 查找 CLI。字体文件为 `scripts/feature-demos/vendor/SourceHanSansSC-VF.otf`。

## 2. 日常启动：复用已有环境

在终端 A 执行并保持运行：

```powershell
node scripts/web-demos/start.mjs
```

启动器使用随机本机端口，控制台输出完整浏览器地址，并保存到 `.codex-tmp/web-demos/instance.json`。打开本次输出的地址；不要收藏固定端口。页面要求 API Key 时选择“稍后配置”。

在终端 B 可读取地址并用默认浏览器打开：

```powershell
$demoInstance = Get-Content .codex-tmp/web-demos/instance.json -Raw | ConvertFrom-Json
Start-Process $demoInstance.url
```

结束时，在终端 A 按 Ctrl+C，只停止这个演示实例。`instance.json` 停机后仍可能存在，存在文件不代表服务正在运行。不要重复启动多个实例。

## 3. 首次搭建或同步新的插件代码

已有环境、只修改录制节奏或按键提示时，直接跳到第 5 节；不需要重建插件副本。

首次搭建：先执行第 2 节，打开页面以初始化 Web profile 和默认工作区，跳过 API Key，然后停止演示实例。

同步代码：先停止演示实例，再执行：

```powershell
npm run build
node scripts/web-demos/prepare.mjs
node scripts/web-demos/start.mjs
```

必须先 build：prepare 复制的是 `lib/` 编译产物，不会自动编译 `src/`。它会备份旧 HTML 动画并校验五支原 GIF 的 SHA-256，然后更新隔离插件副本、演示服务和样例文件。这个脚本需要已经初始化的 Web profile，也依赖当前旧动画目录存在。

修改 `fixtures.mjs` 后也要重新 prepare 并重启，运行中的服务不会直接读取脚本源文件的修改。只改 `record.mjs` 则下一次录制立即生效。

注意：prepare 会更新独立环境，但不会清空以前导入的演示会话和设置；多次录制可能在侧栏积累同名示例会话。

## 4. 手动演示什么

| 场景 ID | 操作顺序 | 要说明的区别 |
| --- | --- | --- |
| `folders` | 输入 `@file:docs` → Tab → 输入 `testing` → Tab → 用顶部导航返回 docs → Enter | Tab 进入目录浏览；Enter 插入目录引用 |
| `agent-import` | 输入 `@agent:` → Enter 引用 → 清除输入 → 再输入 `@agent:` → Tab → 点击确认导入 → 显示历史对话 | Enter 插入会话引用；Tab 打开导入选项，仍需确认导入 |
| `chat-import-upgrade` | 切换到升级场景 → 输入 `@agent:` → 点击升级 Chat Import → 设置 → 引用万物 → 本地 Agent 对话查看状态 | 展示版本不兼容时的入口，以及模拟升级后的“需要重启”状态 |
| `local-plugins` | 输入 `@plugin:dsh-reference-anything` → Enter | 插入真实插件列表中的插件引用 |
| `shortcuts` | 设置 → 引用万物 → 将本地 Agent 快捷词设为 `agent, work`，网页对话设为 `chat, work` → 关闭设置 → 输入 `@work:缓存`，再试 `@codex:缓存` | 共享快捷词可匹配多个来源；具体提供方快捷词仍缩小范围 |

手动演示升级前，在终端 B 切换场景：

```powershell
Set-Content .codex-tmp/web-demos/mode.json '{"scene":"chat-import-upgrade"}' -Encoding ascii
```

然后重新打开菜单；若界面还缓存旧状态，刷新演示页面。结束后恢复普通场景：

```powershell
Set-Content .codex-tmp/web-demos/mode.json '{"scene":"folders"}' -Encoding ascii
```

重新写入 mode.json 会重置模拟升级结果。自动录制会自行切换场景，并在结束时恢复 folders。不要在录制期间手动操作同一实例或切换场景。

## 5. 自动录制并生成动画

保持终端 A 的 Web 服务运行，在终端 B 执行：

```powershell
$env:PLAYWRIGHT_MODULE = 'C:/Users/27923/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
node scripts/web-demos/record.mjs
```

上面是本机现有 Playwright 路径；换电脑后改为实际安装路径。如果项目能直接解析 `playwright`，无需设置这个变量。录制默认读取 instance.json 中的本次地址。

只重录指定片段：

```powershell
node scripts/web-demos/record.mjs folders agent-import
```

每次录制使用新的浏览器上下文和 1280×800 视口，运行真实 Edge 无头浏览器。脚本按场景输入、点击与按键，页面内叠加鼠标、点击圆环、底部居中的大按键及动作说明。按键字号 32px、说明 24px，显示约 2 秒，全部使用思源黑体。叠加效果属于录制脚本，不修改产品界面代码。

生成链路：

```text
真实 DSH Web 操作
  → Playwright 原始 WebM
  → ffmpeg 裁掉初始化阶段、编码 MP4（1280×800）
  → 调色板转换 GIF（960×600、15 fps、循环播放）
  → 预览页、截图与 manifest
```

同一时间只运行一个 record 进程：场景共用 mode.json，多个进程会互相干扰。自动操作不会提交对话给模型。

## 6. 查看与验收

录制成功后，控制台输出本次 `Gallery:` 路径。打开对应的 `index.html` 查看所有 MP4，点击链接查看 GIF。

| 输出 | 用途 |
| --- | --- |
| `raw/*.webm` | 保留原始录屏 |
| `<场景>.mp4` / `<场景>.gif` | 视频母版与循环动画 |
| `<场景>.png` | 场景结束截图 |
| `<场景>-Tab.png` / `<场景>-Enter.png` 等 | 使用按键辅助函数时的提示截图；同场景同键保留最后一次 |
| `manifest.json` | 本次已完成场景、时长和文件路径 |
| `index.html` | 本次预览页 |
| `failure.png` / `failure.txt` | 失败时的截图和可访问性快照 |

脚本会检查关键交互结果、浏览器异常、部分按键提示、GIF 宽度与时长。仍需人工检查：菜单定位、鼠标轨迹、字幕是否遮挡操作、Enter/Tab 说明是否准确、GIF 是否流畅，以及画面是否只包含演示数据。

失败时先查看本次目录的 failure 文件，修正后只重录失败片段。部分片段成功不等于整批成功，必须检查进程退出结果和 manifest。

## 7. 以后新增功能演示

1. 在插件中完成真实功能并 build；停止演示实例、prepare、重新启动。
2. 如需可重复的演示数据，在 fixtures.mjs 中添加最小的服务替身；真实界面、图标和交互继续来自 DSH。
3. 在 record.mjs 的 names 和场景分支中加入 ID、操作步骤及关键结果断言；为按键补上准确的动作说明。新增场景应显式加分支，不能误落入现有 shortcuts 的兜底分支。
4. 单独录制该 ID，先检查 MP4 和截图，再检查 GIF。
5. Agent 可先在本地暂存本次发行说明的媒体引用，并汇总预览和字幕等最终文字交用户审核，批准后才能对外发布。录制脚本不会自动替换 `release-notes` 下的旧 GIF；历史 HTML、原 GIF 和之前实录版本继续保留。详见 `docs/development/release-materials.md`。

## 8. 真实与模拟的边界

文件导航、菜单、设置保存、插件列表和会话展示来自真实 DSH。会话搜索、网页对话和升级结果使用虚构数据；确认导入会向独立 DSH 存储写入示例会话。Chat Import 升级只模拟等待和返回状态，不调用安装器。插件自身更新入口当前没有新版本，实际安装调用被阻止。

独立 DSH_HOME、用户目录、工作区和浏览器上下文用于隔离日常数据；默认本地 Agent 扫描与 Chat Import 自动安装服务已禁用。这是演示环境约定，不是操作系统沙箱：不要在这里添加真实目录、账号或凭据。实例 URL 含访问令牌，不提交到仓库或对外分享。
