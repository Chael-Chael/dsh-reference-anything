# AgentPreview

The recent-messages peek shown with a highlighted local Agent session in the @ menu.

- Block: padding 12px, 0.5px `border-l2` bottom, `menu-meta` text. Header (最近对话 · 最后 4 条) in weight 500 `label-secondary`.
- Body: max height min(240px, 30vh), scrolls on its own with `overscroll-behavior: contain`.
- Messages: `bg-module-platform` bubbles, `radius-sm`, padding 8px 12px. User messages indent 24px left, assistant messages 24px right. Role label weight 500 `label-secondary`; text clamps at 3 lines.
- Loading, failed and empty states are a single `menu-meta` line: 正在读取最近消息… / 无法读取预览 / 没有可预览的消息.

Consumer provides: up to 4 messages `{role, text}` or a state.
