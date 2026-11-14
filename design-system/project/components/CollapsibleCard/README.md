# CollapsibleCard

The shell for each @ source project in settings (网页端 AI 对话, 本地 Agent 对话, 网盘文件, 同步, 存储).

- A `button` header with `aria-expanded` and `aria-controls`; the body uses `hidden`, so a collapsed card takes no layout space. Never a native `<details>`.
- Header: `card-head-min-height`, padding 14px 16px, gap 12px. Title `body`, description `caption` in `label-tertiary`, a 7px drawn chevron on the right.
- Collapsed: 1px `border-l2`, `radius-xl`, `bg-layer-2`; hover stroke `label-dimmed`. Open: 0.5px `border-l4`, chevron rotated 180° (240ms, `cubic-bezier(.2,.8,.2,1)`).
- Body inset `space-4` left and right, 16px bottom.
- Cards stack with a `space-4` gap. General settings are open by default; the rest start collapsed.

Consumer provides: title, one-line description, open state, and body content.
