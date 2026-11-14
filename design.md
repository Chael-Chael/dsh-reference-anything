# Reference Anything UI Design System

本规范把 DeepSeek Harness 官方 Web/Desktop UI 的视觉语言落到 Reference Anything 的设置页、插件卡片、选择器和弹层中。实现优先使用 DSH 已提供的 `--dsw-*` 语义 token；只有在宿主 token 不可用时，才使用文档中的 fallback 值。

本文件与 [Reference Anything 设计系统](https://claude.ai/artifact/NGjTZ887RebVBtgcGVB8iA)（tokens、组件预览、素材）保持同步，二者以 `src/client/styles.ts` 最后生效的规则层为准；修改任一方时同步另一方。设计系统源文件保存在 `D:\dsh-reference-anything-claude\design-system\`（`claude/main-work` 分支），发布到线上时以该目录为 root 上传。设计系统 token 名去掉了 `--dsw-alias-` 前缀（如 `label-primary`）。

## Design principles

- **Quiet hierarchy**：用字号、字重、留白和灰阶建立层级，避免大面积装饰和强阴影。
- **Neutral surfaces**：默认使用白色/蓝灰中性表面，品牌蓝只用于链接、焦点和业务状态。
- **Hairline separation**：设置行使用 `0.5px` 分隔线，卡片使用 `0.5px` 描边。
- **One control language**：选择器、步进器、搜索框和按钮优先采用 36px 高度、12px 圆角和 14px 文本。
- **Token first**：组件只引用语义 token，不直接复制官方调色板到组件 CSS。
- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

## Typography

### Font families

```css
--dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
  'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei',
  'Helvetica Neue', Helvetica, Arial, sans-serif;
--ds-font-family-code: 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas,
  'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei';
```

UI 文本使用 `--dsw-font-family`。代码、路径和 entry id 使用 `--ds-font-family-code`。品牌字只在品牌字标或品牌标题中使用 `Montserrat`，不能用于普通设置文本。

### Type scale

| Token | Size / line-height | Weight | Usage |
| --- | --- | --- | --- |
| `display` | 24 / 32px | 600 | 页面级标题、空状态主标题 |
| `heading` | 20 / 28px | 500 | 内容区标题 |
| `body-lg` | 16 / 24px | 400 | 长文本、主要内容正文 |
| `body-lg-strong` | 16 / 24px | 500 | 正文强调 |
| `body` | 14 / 22px | 400 | 设置标题、按钮、导航标签、选择器 |
| `body-strong` | 14 / 22px | 500 | 卡片标题、强调值 |
| `compact` | 13 / 20px | 400 | 表格、紧凑辅助信息 |
| `caption` | 12 / 18px | 400 | 设置描述、帮助文本、次要说明 |
| `micro` | 11 / 14px | 400 | 元数据、详情字段 |

设置页最终层只用 `body`、`body-strong`、`caption`，页头用 `heading`，来源卡片计数用 `metric`（18 / 24px，500）；设置页正文不低于 12px。

@ 菜单沿用官方 `MenuView`：

| Token | Size / line-height | Weight | Usage |
| --- | --- | --- | --- |
| `menu-item` | 13 / 20px | 400 | 菜单项名称、下拉菜单项 |
| `menu-meta` | 12 / 18px | 400 | 右对齐描述、命令别名、Agent 预览正文 |
| `menu-section` | 11 / 16px | 500 | 分组标题，`label-tertiary` |
| `menu-hint` | 10 / 16px | 400 | 可下钻行的 Tab 键帽提示 |

官方 UI 中间字重按 `500` 实现；不要使用 510 等平台专用中间值。中文文本保持正常字距，不额外增加 `letter-spacing`。

## Spacing

以 4px 为基础单位。组件只从以下步进中选择间距：

| Token | Value | Typical usage |
| --- | ---: | --- |
| `space-1` | 4px | 图标与紧邻文字、状态间隙 |
| `space-2` | 8px | 行内控件、标题与描述、图标与标签 |
| `space-3` | 12px | 卡片内容、控件内部间距 |
| `space-3.5` | 14px | 选择器水平 padding、卡片水平 padding |
| `space-4` | 16px | 设置行垂直 padding、常规 section 内边距 |
| `space-5` | 20px | 外观选项卡内边距、标题区留白 |
| `space-6` | 24px | 设置内容列边距、区块间距 |
| `space-8` | 32px | 大区块间距、页面级留白 |
| `space-12` | 48px | 需要明显分组时的宽松留白 |

官方设置行使用 `padding: 16px 0`、标题与描述间距 `4px`、行内控件间距 `8px`。插件卡片使用 `gap: 10px`，这是卡片网格的特例，不扩展为新的基础步进。

## Component dimensions

| Component | Dimension / spacing | Radius |
| --- | --- | --- |
| Settings panel | `800px` wide, max height `min(800px, viewport - 48px)` | `28px` |
| Settings nav | `188px` wide; top padding `22px`; nav gap `18px` | — |
| Settings nav cell | `40px` high; `12px 16px 12px 12px`; gap `8px` | `12px` |
| Settings row | `16px 0` vertical padding; gap `8px` | — |
| Preference row in a settings card | min `68px`; `12px 0`; grid `1fr 144px`, column gap `24px` | — |
| Collapsible project card header | min `72px`; `14px 16px`; gap `12px` | `20px` (card) |
| Source card | main `16px`, mark `44px`; foot min `68px`, `16px` | `20px` |
| Picker list row | `12px 16px`; `36px` drag + `20px icon / text / 36px switch / 36px expand` | `20px` (list) |
| Switch | `36 × 20px` track, `16px` thumb | `999px` / `50%` |
| Health marker | `32px` circle | `50%` |
| @ menu surface | max height `400px`; padding `4px` | `16px` |
| @ menu / dropdown item | min `34px`; `6px 8px`; gap `6px`; icon `16px`（命令 `18px`） | `12px` |
| Standard control | `36px` high; horizontal padding `14px` | `12px` |
| Search input | `36px` high; icon/text inset `12px / 36px` | `12px` |
| Close / compact icon button | `28px × 28px` | `8px` |
| Icon | `16px × 16px` | — |
| Appearance card | `20px 32px` padding | `20px` |
| Plugin card | `12px 14px` padding; grid gap `10px` | `20px` |
| Panel content column | `padding: 0 24px 24px` | — |

表格、搜索框、按钮等控件的高度优先保持 36px；不要因为单个文案变长而改变控件高度，应使用省略、换行或横向布局解决。

## Corner radius

```css
--dsw-radius-xs: 4px;       /* code chip, tiny state */
--dsw-radius-sm: 8px;       /* compact icon button, small notice */
--dsw-radius-md: 12px;      /* nav cell, selector, input, button */
--dsw-radius-lg: 16px;      /* larger notice or grouped surface */
--dsw-radius-xl: 20px;      /* appearance and plugin cards */
--dsw-radius-panel: 28px;   /* modal/panel surface */
```

圆形状态点使用 `50%`。除圆形状态点外，不要在组件中引入任意 `border-radius`；需要更大的圆角时只能使用 `xl` 或 `panel`。

## Color roles

组件引用角色 token；下面的值是官方当前 light/dark palette 的参考值，实际渲染以 DSH 主题 token 为准。

| Role | Light | Dark | Usage |
| --- | --- | --- | --- |
| `bg-base` | `#ffffff` | `#151517` | 应用基础背景 |
| `bg-layer-1` | `#ffffff` | `#232324` | 一级 raised surface |
| `bg-layer-2` | `#ffffff` | `#2c2c2e` | 设置面板、二级 surface |
| `bg-module-platform` | `#f5f6f7` | `#353638` | 选择器、输入框、卡片内模块 |
| `bg-overlay` | `#e9ecf2` | `#61666b` | overlay、popover |
| `label-primary` | `#0f1115` | `#f9fafb` | 标题、主要正文 |
| `label-secondary` | `#61666b` | `#cfd3d6` | 次要正文 |
| `label-tertiary` | `#81858c` | `#adb2b8` | 描述、placeholder、辅助信息 |
| `label-caption` | `#adb2b8` | `#81858c` | 最弱元数据 |
| `border-l2` | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)` | 设置行分隔线 |
| `border-l4` | `rgba(0,0,0,.16)` | `rgba(255,255,255,.20)` | 输入框、卡片描边 |
| `interactive-bg-hover` | `rgba(38,49,72,.06)` | `rgba(255,255,255,.08)` | hover |
| `state-business-primary` | `#4176e6` | `#7aaaff` | 链接、焦点、业务状态 |
| `state-error-primary` | `#ec1313` | `#f25a5a` | 错误 |
| `state-success-primary` | `#22c55e` | `#22c55e` | 成功 |
| `state-warn-primary` | `#f59e0b` | `#f59e0b` | 警告 |
| `bg-layer-3` | `#ffffff` | `#353638` | 最高 raised layer |
| `menu-surface` | `rgba(248,249,250,.94)` | `rgba(48,49,54,.94)` | @ 菜单与下拉菜单（`--dsw-specific-menu`） |
| `label-dimmed` | `#e1e5ee` | `#43454a` | 折叠卡片 hover/展开描边 |
| `label-primary-foreground` | `#ffffff` | `#0f1115` | 主按钮、徽标、通知、开关开启圆点上的文字/图形 |
| `menu-icon` | `#353638` | `#ebeef2` | 官方菜单下钻箭头、面包屑分隔 |
| `border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` | 菜单外框、面包屑分隔线 |
| `border-l3` | `rgba(0,0,0,.12)` | `rgba(255,255,255,.16)` | 开关关闭轨道、输入框聚焦描边 |
| `brand-primary` | `#0f1115` | `#f9fafb` | 开关开启轨道（DSH 品牌主色为黑白，不是蓝色） |
| `switch-thumb` | `#ffffff` | `#adb2b8` | 开关关闭圆点 |

对比度：`label-tertiary` 在浅色白底上约 3.7:1，`state-business-primary` 约 4.2:1，均为官方原值；只用于辅助文字、焦点环和引用 chip，不承载操作。成功/警告色在白底上低于 3:1，必须配文字或图标。

对应的 CSS 写法：

```css
color: var(--dsw-alias-label-primary);
background: var(--dsw-alias-bg-module-platform);
border-color: var(--dsw-alias-border-l4);
```

不要在普通 UI 中直接使用品牌蓝填充大面积背景。错误、成功和警告状态优先用语义色的低透明度背景，例如 `color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)`。

## Interaction and motion

```css
--ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
--ds-transition-duration-fast: 0.1s;
--ds-transition-duration: 0.2s;
--ds-transition-duration-slow: 0.3s;
--dsw-focus-ring-width: 2px;
```

- hover 只改变背景或边框，不改变布局尺寸。
- 旋转 chevron、展开卡片等短动效使用 `140ms–200ms`；进入/退出面板不超过 `300ms`。
- `:focus-visible` 使用 2px focus ring；鼠标模式可以隐藏 ring，但不能移除键盘焦点反馈。
- 遵守 `prefers-reduced-motion: reduce`，关闭非必要动画。

## Settings page recipe

设置页默认采用以下结构：

1. 一个设置项占一行，左侧为标题和描述，右侧为控件。
2. 标题使用 `14/22 400`，描述使用 `12/18 400`，标题与描述间距 `4px`。
3. 行之间使用 `0.5px` 的 `border-l2`，行上下 padding 为 `16px`。
4. 选择器、输入框和按钮统一 36px 高、12px 圆角；图标固定 16px。
5. 多项选择使用两列网格，列间距和行间距为 `10px`；卡片使用 `xl` 圆角。
6. 移动或窄窗口下，两列降为一列；不压缩正文到低于 12px。

## Implementation checklist

- [ ] 是否使用了官方 `--dsw-*` 语义 token，而不是散落的颜色值？
- [ ] 是否只使用 4px 基础步进及本文件列出的特例？
- [ ] 控件高度、圆角、图标尺寸是否落在组件尺寸表内？
- [ ] Light/Dark 两套颜色是否都有可读对比度？
- [ ] 键盘 focus、hover、disabled、error 状态是否完整？
- [ ] 是否验证了窄窗口和 `prefers-reduced-motion`？

## Collapsible project cards

设置页中除“通用设置”外的 @ 项目使用官方插件设置卡片模式。官方实现位于 `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx` 的 `PluginCard`，使用按钮而非原生 `<details>`：按钮通过 `aria-expanded`、`aria-controls` 和受控的 `open` 状态切换详情内容；官方 CSS 对应 `.cardContent`、`.cardDetails` 和 `.chevron`。

当前实现（`styles.ts` 最终层，以此为准）：

1. 卡片使用官方 `--dsw-radius-xl`（20px）圆角和 `--dsw-alias-settings-card-fill`；折叠时 `1px border-l2`，hover 描边 `label-dimmed`；展开时 `0.5px settings-card-stroke`（`border-l4`）。项目内容始终属于同一张卡片，卡片之间 `16px` gap。
2. 折叠头部最小高度 `72px`，padding `14px 16px`，gap `12px`，标题与描述垂直排列。
3. 标题 `14/22 400`，描述 `12/18 400`、`label-tertiary`。
4. 展开内容左右内缩 `16px`、底部 `16px`，不再画顶部分隔线。
5. 右侧箭头为 7px 细线 chevron（1.5px border 旋转绘制），展开时旋转 `180deg`，`240ms cubic-bezier(.2,.8,.2,1)`；点击整个头部按钮切换，默认折叠，通用设置默认展开。详情内容使用 `hidden` 控制可见性。

官方源码参考：

- `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx`：`PluginCard` 的按钮、ARIA 和受控展开逻辑。
- `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.module.css`：`.cardContent`、`.cardDetails`、`.chevron` 的卡片和展开样式。
- [PluginInventorySettingsTab.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx)
- [PluginInventorySettingsTab.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.module.css)

折叠卡片的结构（按钮头部、`14px 16px` 间距、`16px` 内容内缩、细线 chevron）来自 `dsh-market` 的 `SettingsCard`（`src/client/SettingsCard.tsx`，`Market.module.css` 的 `.setCard` 等）；其字号（15/600、13/1.5）、`12px` 圆角和 `10px` gap 已被上面的官方设置排版和 `radius-xl` 覆盖，不再采用。箭头不使用文字字符替代。

- [dsh-market SettingsCard.tsx](https://github.com/dsh-market/dsh-market/blob/main/src/client/SettingsCard.tsx)
- [dsh-market Market.module.css](https://github.com/dsh-market/dsh-market/blob/main/src/client/Market.module.css)

深色模式遵循官方 `design-platform.css` 的语义 token，不直接写死面板色：卡片填充使用 `--dsw-alias-settings-card-fill`（官方映射到 `--dsw-alias-bg-layer-2`），嵌套控件使用 `--dsw-alias-bg-module-platform`，分隔线使用 `--dsw-alias-border-l2`，次级文字使用 `--dsw-alias-label-tertiary`。设置页外层保持透明，避免在深色主题产生一整块与官方背景不一致的矩形底色。

本地 Agent 卡片展示适配器的实际默认读取位置（例如 `~/.claude/projects`、`~/.codex/sessions`、`~/.cursor/projects`），用户配置了自定义目录时优先显示自定义目录。开关复用 DSH 官方 `button[role="switch"]` 与黑白语义：轨道 `36×20px`、2px 内边距、圆角 `999px`，圆点 `16px`；关闭时轨道 `border-l3`、圆点 `switch-thumb`，开启时轨道 `brand-primary`（浅色为黑、深色为近白）、圆点 `label-primary-foreground` 并右移 16px。不使用蓝色。

## @ menu recipe

@ 菜单是官方 `MenuView` 的扩展，Reference Anything 只增加来源分组、图标投影和 Agent 预览，不改变原生引用文本的光标、选区与换行。

1. 浮层：与输入卡片同宽，最高 `400px`，`menu-surface` 填充，`radius-lg`，`4px` padding，`elevation-prominent` 阴影加 `0.5px border-l1` 外框；下方仍有内容时显示 16px 渐隐提示。
2. 分组标题：`menu-section`（11/16 500，`label-tertiary`），padding `5px 8px 2px`，非首个分组上方多 `3px`。
3. 菜单项：最小 `34px`，padding `6px 8px`，gap `6px`，`radius-md`。顺序为 16px 图标（`label-secondary`；命令 18px；双 Agent 标记 36px 宽）→ 名称（最多 40% 宽，省略）→ 可选别名（`label-tertiary` 12/18）→ 右对齐描述（`menu-meta`，`label-tertiary`）。
4. 高亮：鼠标与键盘共用一个 `interactive-bg-hover`；键盘 `:focus-visible` 额外显示 2px `state-business-primary` 内嵌焦点环（offset `-2px`）。
5. 操作行（显示更多、依赖有更新）用 `label-tertiary` 文字且不显示描述；可下钻行仅在高亮时显示 Tab 键帽与 18px chevron。
6. 加载中的来源显示 18px 骨架条，2s 呼吸动画；减少动态效果时停止。
7. 本地 Agent 预览：12px padding、底部 `0.5px border-l2`，最多 `min(240px, 30vh)` 并独立滚动；消息气泡 `bg-module-platform`、`radius-sm`、`8px 12px`，用户消息左缩进 24px，助手消息右缩进 24px，正文 3 行截断。
8. 引用 chip：`state-business-primary` 文字，`@` 500 字重，16px 图标，最多 240px；失效时 `state-error-primary`、删除线、70% 不透明度。只通过 mask 替换图标，不重绘文字。
9. 图标风格由通用设置「图标风格」决定，默认「极简」：Lucide 线性图标（2px 描边）；引用 chip 通过 mask 单色显示。「灵动」：@ 菜单、引用 chip 与设置页的非供应商图标改用 Kubai Icons（`src/client/vendor/kubai-icons`，映射见 `KUBAI_PICKER_ICON`，统一 `state-business-primary` 蓝，悬停所在行/chip 时播放动效）；无对应 Kubai 图标的保留 Lucide。两种图标同时挂载，由 `html[data-dsh-ref-icon-style]` 切换显示，切换无需重新投影。

## Official references

### Style source priority

设置页的主要样式来源是 DSH 官方核心 UI，而不是 `dsh-market`：

1. 页面布局和普通设置行优先复用 `ui-settings-general/SettingsRoot`、`PreferenceRow`。
2. 外观、字号和主题颜色优先复用 `ui-theme/AppearanceRow`、`FontSizeRow` 与 `design-platform.css`。
3. 开关、按钮、选择器和 chevron 优先复用 DSH primitives 及 `--dsw-*` 语义 token。
4. 只有“每个 @ 项目的折叠卡片外壳”参考 `dsh-market/SettingsCard`；它不定义整个设置页的字体、颜色、控件或行布局。

因此当前页面的内容结构可以保持项目自身实现，但基础设置行、深色模式、控件状态和通用间距必须以 DSH 官方核心组件为准。

- [base.css](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-theme/src/styles/base.css) — font family, motion and radius tokens
- [design-platform.css](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-theme/src/styles/design-platform.css) — light/dark semantic color roles
- [focus.css](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-theme/src/styles/focus.css) — focus ring behavior
- [SettingsRoot.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-general/src/client/SettingsRoot.module.css) — settings panel and navigation geometry
- [PreferenceRow.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/src/client/settings/PreferenceRow.module.css) — settings row and selector rhythm
- [Menu.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-primitives/src/Menu.tsx) + [Menu.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-primitives/src/Menu.module.css) — 下拉菜单必须使用官方菜单语义：浮层 4px 内边距、紧凑 34px 菜单项、悬停填充、选中项尾部勾选标记；深色模式使用 elevated layer 3 浮层和 interactive hover token。设置页的 `DshMenuSelect` 保留原生 select 作为状态/无障碍同步层，视觉菜单遵循这套规则。
- [AppearanceRow.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-theme/src/client/AppearanceRow.module.css) — appearance cards
- [PluginInventorySettingsTab.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.module.css) — plugin search and card grid
