# Reference Anything UI Design System

本规范把 DeepSeek Harness 官方 Web/Desktop UI 的视觉语言落到 Reference Anything 的设置页、插件卡片、选择器和弹层中。实现优先使用 DSH 已提供的 `--dsw-*` 语义 token；只有在宿主 token 不可用时，才使用文档中的 fallback 值。

## Design principles

- **Quiet hierarchy**：用字号、字重、留白和灰阶建立层级，避免大面积装饰和强阴影。
- **Neutral surfaces**：默认使用白色/蓝灰中性表面，品牌蓝只用于链接、焦点和业务状态。
- **Hairline separation**：设置行使用 `0.5px` 分隔线，卡片使用 `0.5px` 描边。
- **One control language**：选择器、步进器、搜索框和按钮优先采用 36px 高度、12px 圆角和 14px 文本。
- **Token first**：组件只引用语义 token，不直接复制官方调色板到组件 CSS。

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

1. 卡片使用单一 `0.5px` 细边框、官方 `--dsw-radius-xl` 圆角和卡片填充色；项目内容始终属于同一张卡片。
2. 折叠头部高度约 `88px`，水平 padding `24px`，标题与副标题垂直排列，右侧保留 `20px` 箭头区域。
3. 项目标题使用 `18/24 600`；副标题使用 `14/20 400` 和次级文字颜色。标题与版本号或状态可在同一行内联显示。
4. 折叠状态只显示头部；展开状态在头部下方使用 `1px` 分隔线承接内容，内容区水平 padding `24px`、底部 padding `20px`。
5. 箭头位于右侧并在展开时旋转 `180deg`；点击整个头部按钮均可切换，默认折叠，通用设置默认展开。详情内容使用 `hidden` 控制可见性，折叠时不占用布局空间。

官方源码参考：

- `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx`：`PluginCard` 的按钮、ARIA 和受控展开逻辑。
- `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.module.css`：`.cardContent`、`.cardDetails`、`.chevron` 的卡片和展开样式。
- [PluginInventorySettingsTab.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx)
- [PluginInventorySettingsTab.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.module.css)

本项目的折叠项目卡片进一步对齐 `dsh-market` 的 `SettingsCard`：源码位于 `src/client/SettingsCard.tsx`，样式位于 `src/client/Market.module.css` 的 `.setCard`、`.setHeader`、`.setHeadText`、`.setName`、`.setDesc`、`.setChevron` 和 `.setBody`。采用其实际值：`1px` 边框、`12px` 圆角、`14px 16px` 头部间距、`15px/600` 标题、`13px/1.5` 描述、`12px` 头部间距、卡片之间 `10px` gap、展开内容 `1px` 顶部分隔线并保持 `16px` 左右内缩。箭头使用 14px chevron 图标的细线轮廓，不使用文字字符替代。

- [dsh-market SettingsCard.tsx](https://github.com/dsh-market/dsh-market/blob/main/src/client/SettingsCard.tsx)
- [dsh-market Market.module.css](https://github.com/dsh-market/dsh-market/blob/main/src/client/Market.module.css)

深色模式遵循官方 `design-platform.css` 的语义 token，不直接写死面板色：卡片填充使用 `--dsw-alias-settings-card-fill`（官方映射到 `--dsw-alias-bg-layer-2`），嵌套控件使用 `--dsw-alias-bg-module-platform`，分隔线使用 `--dsw-alias-border-l2`，次级文字使用 `--dsw-alias-label-tertiary`。设置页外层保持透明，避免在深色主题产生一整块与官方背景不一致的矩形底色。

本地 Agent 卡片展示适配器的实际默认读取位置（例如 `~/.claude/projects`、`~/.codex/sessions`、`~/.cursor/projects`），用户配置了自定义目录时优先显示自定义目录。开关复用 DSH 黑白语义：轨道约 `54×30px`、圆角 `999px`，启用时浅色轨道配黑色圆点，禁用时深灰轨道配中灰圆点，避免使用蓝色品牌色。

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
