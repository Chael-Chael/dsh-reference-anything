# TextField

A 36px input wrapped in a hairline frame.

- Wrapper: `control-height`, padding 0 `space-3.5`, 0.5px `border-l4`, `radius-md`, `bg-layer-1`. Focus moves the stroke to `border-l3`; there is no outline ring inside settings.
- Input: 22px line, no border, inherits `body`. Placeholder in `label-tertiary`.
- Compact (`is-compact`, 56px wide, centered) for numeric limits in the picker list.
- Invalid: stroke `state-error-primary` and an inline `caption` message under the row, never a toast.

Consumer provides: value, placeholder, and validation message.
