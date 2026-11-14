# ReferenceMenu

The @ menu above the composer, extended by Reference Anything with sessions, external conversations, local Agents, drives, commands and skills.

- Surface: full composer width, max 400px tall, `menu-surface` fill, `radius-lg`, 4px padding, `elevation-prominent` plus a 0.5px `border-l1` frame. A 16px fade marks more content below.
- Section title: `menu-section` in `label-tertiary`, padding 5px 8px 2px; 3px extra space above every section but the first.
- Item: `menu-item-height`, padding 6px 8px, gap 6px, `radius-md`. Order: 16px icon in `label-secondary` (command glyph 18px, dual Agent marks 36px wide), name (≤40% width, ellipsis), optional alias, then the description right-aligned in `menu-meta` / `label-tertiary`.
- One highlight, `interactive-bg-hover`, shared by pointer and keyboard; keyboard focus adds a 2px `state-business-primary` inset ring.
- Action rows (显示更多, 依赖有更新) use `label-tertiary` text and drop the description.
- Drillable rows reveal a Tab keycap (`menu-hint`, `label-caption`) and an 18px chevron only while highlighted.
- Pending sources show 18px skeleton bars that pulse over 2s.
- RA changes only the visual glyph inside reference chips; native text keeps caret, selection and wrapping.

Consumer provides: grouped candidates `{icon, name, alias?, description}` and the active index.
