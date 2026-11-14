# PreferenceRow

One setting per row: title and description on the left, the control on the right.

- Grid `minmax(0,1fr) control-width`, column gap `space-6`, `row-min-height`, padding 12px 0, 0.5px `border-l2` divider; the last row has none.
- Title `body` in `label-primary`; description `caption` in `label-tertiary`, `space-1` below.
- Control is a Select, TextField, Switch or Button, centred over both text lines. Use `is-auto` when the control is a switch or a button group.
- Rows live inside a settings card (`radius-xl`, 0.5px `border-l4`, `bg-layer-2`, 16px inset).
- Under 640px the control drops below the text at full width.
- Write the description only when the title cannot explain the setting.

Consumer provides: title, optional description, and the control.
