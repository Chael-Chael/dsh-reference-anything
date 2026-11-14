# Select

A selector pill that opens an official-style menu (the `DshMenuSelect` pattern).

- Trigger: `control-width` × `control-height`, `bg-module-platform`, `radius-md`, value left, drawn chevron right at 75% opacity. Hover: `interactive-bg-hover`.
- Menu: portal-mounted so cards cannot clip it; `menu-surface` fill, `radius-lg`, 4px padding, `elevation-prominent`.
- Items: `menu-item-height` min, padding 6px 8px, `menu-item` text, `radius-md`. One shared highlight for pointer and keyboard (`interactive-bg-hover`); the selected item carries a trailing check.
- The chevron rotates 180° in 240ms `cubic-bezier(.2,.8,.2,1)` while open.
- Keep a native `<select>` underneath as the state and accessibility layer.

Consumer provides: options `{value,label}`, the value and `onChange`.
