# Desktop 启动失败：本地认证 Cookie 累积

- 日期：2026-10-19（Asia/Shanghai）。
- 状态：本机恢复完成；用户确认已启动。宿主长期累积机制未修改。
- 用户授权：备份数据和配置、覆盖重装、重新启用本地 link，并验收 Desktop 窗口。

## 已确认原因

DSH Desktop 0.2.1-rc.2 在欢迎页连接阶段报 `desktop welcome: Web authentication failed`。Chromium 启动网络日志显示实际响应为 `HTTP/1.1 431 Request Header Fields Too Large`。

本机 Desktop 的 `Network/Cookies` 中有 71 条 `host_key=127.0.0.1`、名称前缀 `dsh-auth-` 的记录，名称和值合计约 16 KB，另有 Cookie 分隔符和其他 HTTP 请求头。宿主 `dsh-client-connection` 按含端口的 authority 派生 Cookie 名称；浏览器按域而非端口发送 Cookie，多次动态端口启动后旧记录累积。

仅重新 build 本地引用插件、停用第三方 bundles、覆盖重装同版本均未消除错误。重装前后 app.asar 和可执行文件 SHA-256 完全一致。不能据通用认证报错认定插件或账号凭据损坏。

## 备份与恢复

- 备份目录：`D:/DSH-Backups/20261019-before-reinstall/`，包含 `.dsh` 与 Electron 用户目录，复制 59,881 个文件且无复制失败；615 个目录链接不递归展开，目标记录在 `links.json`。
- 2,908 个数据/配置文件校验通过；5 个配置文件在备份期间被后台程序更新，初始快照与重采快照均保留。
- 安装包来自官方更新器缓存；签名有效，SHA-512 与 `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml` 一致。覆盖安装退出码 0。
- Desktop package.json 保持 `link:D:/dsh-reference-anything`，重新加入 `dsh-reference-anything` bundle。
- 退出 Desktop 后单独备份 Cookie 数据库，仅移除上述本地认证记录；SQLite integrity_check 通过，非目标记录未改变。未删除会话、账号凭据或插件配置，也未放宽认证或沙箱。

## 验收

- 实际 Desktop 工作区和历史会话正常显示。
- 实际 @ 菜单显示 `dsh-reference-anything 0.5.0 · 运行中`，并正常列出本地 Agent 等来源。
- 原有 114 个会话与凭据文件逐文件 SHA-256 对照备份：缺失 0，变化 0。
- 用户明确回复“ok了，启动了”。本轮未发送测试消息、未导入会话；用户自行操作的草稿未改动。
- 详细备份校验与修复摘要保存在备份目录。临时启动网络日志已删除，避免长期保留其中的启动认证链接；原 Cookie 数据库备份仍保留。

## 限制与后续

这是本机状态修复，不是宿主代码修复。宿主未修复旧 Cookie 回收前，频繁重启可能再次累积。再次遇到同样错误先查实际 HTTP 状态码；只在证据指向此问题时，退出 Desktop、备份数据库并定向清理本地 `dsh-auth-*`，不要清空整个用户目录或关闭认证。
