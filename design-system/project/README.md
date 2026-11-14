Reference Anything is a DeepSeek Harness (DSH) plugin. Its UI is two surfaces that live inside the host: a **settings page** (project cards, preference rows, source cards, the @ source list) and the **@ menu** above the composer. Both borrow DSH's visual language. Use DSH's `--dsw-*` semantic tokens at runtime. The values here are the light and dark fallbacks, and they mirror `design.md` in the repository.

## Principles

- **Quiet hierarchy.** Build hierarchy from size, weight, spacing and grey steps. Avoid decoration and heavy shadows. Only menus cast a shadow (`elevation-prominent`).
- **Neutral surfaces, one accent.** Surfaces are white or blue-grey neutrals. `state-business-primary` is used only for links, the keyboard focus ring and reference chips. Never use it as a large fill or on a button.
- **Monochrome controls.** Primary buttons, switches, badges and progress bars use `label-primary`, so they invert in dark mode. DSH's `brand-primary` is black in light mode, not blue.
- **Hairlines, not boxes.** Rows are separated by a 0.5px `border-l2` line. Cards use a single stroke and are never nested inside another filled card.
- **One control language.** Selectors, inputs and buttons are `control-height` (36px) tall, with `radius-md` corners and `body` text. Icons are `icon` (16px).
- **Let the layout explain.** Write no slogans, no repeated labels and no description that only restates its title. Explain only abnormal states and required actions. Put secondary detail behind a disclosure.
- **Host owns the chrome.** Never restyle DSH's settings shell, nav, typography scale or native reference text. Reference Anything adds layout and business cards only.

## Content

- Settings copy is Chinese first, with an English locale. Keep it short and verb-first for actions: 连接账号, 重新扫描, 删除已存凭据.
- Name sources the way users do: 网页端 AI 对话, 本地 Agent 对话, DSH 对话, 网盘文件, 命令, 技能.
- State messages say what happened and what to do next in one sentence: "凭据已失效，请重新连接。"
- Show paths in `code` exactly as they appear on disk, for example `~/.claude/projects`. Show the user's custom directory instead when one is set.
- No emoji in settings. The only emoji in the UI is the 🎉 on the release-notes menu row, and that comes from the host.

## Color

- Text: use `label-primary` for titles and values, `label-secondary` for secondary text and menu icons, and `label-tertiary` for descriptions, placeholders, section titles and chevrons. `label-caption` is decorative metadata only.
- Surfaces, from back to front: `bg-base` → `bg-layer-1` (fields) → `bg-layer-2` (settings cards) → `bg-module-platform` (controls inside a card). Menus use the translucent `menu-surface`.
- Strokes: `border-l2` for dividers, `border-l4` for field and card strokes, `border-l3` for a focused field and the off-state switch track, and `label-dimmed` for card hover.
- Interaction: `interactive-bg-hover` is the single highlight for hover and keyboard. It changes the background only, never the size.
- Status colors (`state-error-primary`, `state-success-primary`, `state-warn-primary`) mark text, icons and hairlines. Use them as tints at 8% or less, never as solid fills. Always pair them with a word or glyph.
- Contrast: `label-tertiary` at 12px is 3.7:1 on white in light mode. That is the source value, so keep it to supporting text and never put actions in it.

## Type

- Use the `sans` family (the system stack with PingFang SC and Microsoft YaHei). Use `code` for paths and ids. `brand` (Montserrat) is only for the wordmark.
- Settings: `body` 14/22 is the default for row titles, card titles, buttons and inputs. Use `caption` 12/18 for descriptions and notes, `heading` 20/28 for the page header, and `metric` 18/24 for counts. Text in settings never goes below 12px.
- Menu: `menu-item` 13/20 for names, `menu-meta` 12/18 for descriptions, `menu-section` 11/16 500 for group titles, and `menu-hint` 10/16 for the Tab keycap.
- The medium weight is 500, never 510 or 650. Use normal letter-spacing for Chinese.

## Space, size and radius

- Spacing is on a 4px base: `space-1` … `space-12`. `space-3.5` (14px) is reserved for horizontal control padding.
- Settings rhythm: rows are `row-min-height` with 12px vertical padding, a `space-6` gap between text and control, and the control at `control-width`. Project cards stack with a `space-4` gap and have a 16px inset. The settings root has 24px top padding and 56px bottom padding.
- Radius: `radius-md` for controls and menu items, `radius-lg` for the @ menu, `radius-xl` for every card, `radius-panel` for the modal, and `radius-pill` and `radius-round` for switches and dots only. Use no other radius values.
- Fixed sizes come from the `size` family. A long label truncates or wraps. It never grows a control.

## Motion and states

- Hover and press take 140ms, card hover 160ms, chevrons 240ms `cubic-bezier(.2,.8,.2,1)`, and panels no more than 300ms. The DSH easing is `cubic-bezier(0.4, 0, 0.2, 1)`.
- Focus: inside settings, a field shows focus by moving its stroke to `border-l3`, and the host's outline is suppressed. In the @ menu, keyboard focus adds a 2px `state-business-primary` ring inset by 2px. Never remove keyboard feedback.
- Disabled controls use 0.42 opacity and keep their label.
- Respect `prefers-reduced-motion: reduce`: chevrons, switches, the listing wash and skeleton pulses stop.
- Under 640px, two-column grids drop to one column and row controls move below their text.

## Iconography

- Menu and picker glyphs are Lucide outlines at 2px stroke (MessageCircle for DSH sessions, Bot for local Agents, Cloud for drives, Command, ScrollText for skills), sized 16px (commands 18px) in `label-secondary`.
- The menu's official glyphs (drill chevron, breadcrumb separators) use `menu-icon`.
- Chevrons in settings are drawn: a 7px square with a 1.5px border, rotated. Never use a text character such as ⌄.
- Agent and provider marks are in the **Agents** asset group. Show them monochrome in settings (`brightness(0)`, inverted in dark mode) and in full color in the @ menu.
- The settings nav shows `logo-mono.png` at 16px, inverted in dark mode. The full-color logo is for the README, the banner and release cards only.

## Implementation checklist

- Use `--dsw-*` tokens through these roles, with no scattered literal colors.
- Spacing is on the 4px steps listed here. Control height, radius and icon size are from the `size` and `radius` families.
- Both light and dark are readable. Check dark-mode card fills against `bg-layer-2`.
- Focus, hover, disabled and error states are all present.
- The layout has been checked at narrow widths and with reduced motion.
- Changes extend existing components instead of redesigning the page around one local fix.
