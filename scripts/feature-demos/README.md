# 新功能演示

`scenes.mjs` 保存五个演示的分镜、鼠标关键点和时长，`movie.jsx` 是 Remotion 按帧驱动的动画，`movie.css` 负责展示画布和布局。没有连接真实导入、升级或聊天服务。

## 生成

首次运行 `npm install --prefix scripts/feature-demos`，动画依赖独立于插件运行时。再从仓库根目录运行 `node scripts/feature-demos/build.mjs`，打开 `.codex-tmp/feature-demos/preview.html` 自动播放。URL 参数 `?demo=shortcuts` 可切换到 `agent-import`、`chat-import-upgrade`、`local-plugins`、`shortcuts` 或 `folders`。

环境需有 Playwright、Edge 和 PATH 中的 FFmpeg。若 Playwright 不在项目中，通过 `PLAYWRIGHT_MODULE` 环境变量指定其模块目录，再运行 `node scripts/feature-demos/render.mjs`，可追加场景 ID 只渲染指定场景。每秒实际捕获 30 帧，导出 30 fps MP4 和 20 fps GIF。鼠标目标在播放前从官方组件的实际布局测量；移动缓动、点击波纹、按键提示、逐字输入和列表过渡全部由帧号计算。

脚本检查帧号、画布边界、浏览器异常、变化帧占比及 GIF 尺寸、帧数、时长。PNG 帧、MP4 和 `gallery.html` 总览保存在 `.codex-tmp/feature-demos/`，GIF 输出到 `docs/release/0.4.4/demos/`；替换前自动备份旧 GIF。

动作设计参考本机 Remotion 与 snapcn 技能：缓入缓出、短暂停顿后点击、适度错峰、每个节拍只突出一个动作。界面没有换成 snapcn 的 shadcn 风格组件，仍使用下面列出的 DSH 官方组件。

卡片标题、说明和媒体路径在 `docs/release/0.4.4/features.json` 中维护，正常插件构建会将 GIF 嵌入新功能卡片。

## 官方样式来源

按钮、输入框、菜单容器、引用图标直接使用项目安装的 `@deepseek-ai/dsh-client-ui-primitives`。`官方组件位于 `vendor/`，是 DSH 官方仓库提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc` 的原样副本，附 MIT LICENSE：

- `MenuView.tsx` / `MenuView.module.css`: `packages/client/ui-input-trigger/src/client/`
- `base.css` / `design-platform.css`: `packages/client/ui-theme/src/styles/`
- `PreferenceRow.module.css`: `packages/client/ui-chat/src/client/settings/`
- `ReferenceChip.module.css`: `packages/client/ui-conversation/src/client/input/editor/`

这是基于官方组件的教学动画，版本、会话和安装结果均为示例，不代表对真实服务的端到端验证。


The demonstrations import the plugin's actual ConversationSettings, agentLogoElement,
ProviderLogo, and PickerSourceLogo components. Settings CSS is extracted from
src/client/styles.ts at preview build time. Only fixture data and frame-driven
focus/scroll are injected; all settings actions are inert.
The header uses the official BrandWordmark SVG component. Text uses the locally
installed Source Han Sans SC variable font, embedded into the preview and rasterized
into GIF/video. The keyboard overlay is centered below the app.

Font redistribution license: vendor/SourceHanSans-LICENSE.txt (SIL OFL 1.1).
