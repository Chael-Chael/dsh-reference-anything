# 0.5.0 本地构建与 Desktop 启动验证

日期：2026-10-19（Asia/Shanghai）

- Desktop 本地链接：C:\Users\27923\.dsh\profiles\desktop\node_modules\dsh-reference-anything → D:\dsh-reference-anything；package.json 仍为 link:D:/dsh-reference-anything，bundle 已启用。
- npm run check：PASS；类型检查通过，58 个测试文件通过、2 个跳过；1122 项测试通过、8 项跳过；build 通过。依赖缺失 source map 为非阻断警告。
- 构建后 npm run agent:sync：PASS（最终一次）；此前一轮与另一聊天同步重叠失败，用户已表示暂停另一边。
- Desktop 启动：FAIL；本轮最新明确错误为 desktop welcome: Web authentication failed，日志 crash-2026-10-19T12-08-10.352Z-host.log。进程存在不算界面恢复；未取得可用 Desktop 主界面。
- 根因：尚未确定。重新构建 0.5.0 未消除错误，没有足够证据归因于引用插件。
- 进一步组合诊断命令被自动审批拒绝，未执行；拒绝结果未给出具体理由。
- Web 功能 UI / 全功能发版验收 / tgz 全新安装：NOT_RUN。此次仅导出本地构建包，不构成发版放行或 npm 发布。
- 打包使用 npm pack --ignore-scripts，直接包装刚刚检查并构建的产物，避免重复 build。
- 已打开 tgz 验证包名及版本、关键入口和 213 个文件；逐文件 SHA-256 与当前工作区一致；未含 node_modules、.codex-tmp 或 .env。

文件：dsh-reference-anything-0.5.0.tgz
大小：50,747,094 bytes
SHA-256：731e076c488fc4cd7dcc6d614a989d5ee668a26a497f71eea57dd834257556e9

保留全部既有工作区改动、Desktop 配置与会话数据；未修改产品代码，未禁用插件或重装 Desktop。
