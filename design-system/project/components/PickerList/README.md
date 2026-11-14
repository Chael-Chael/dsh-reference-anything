# PickerList

The ordered list of @ menu sources under General settings: drag to reorder, switch to show, expand for limits and aliases.

- Frame: 1px `border-l2`, `radius-xl`, `bg-layer-2`; rows padding 12px 16px with 1px `border-l2` dividers.
- Row grid: 36px drag handle, then `20px icon · text · 36px switch · 36px expand`, gap 8px.
- Drag handle: ghost 36px square, `label-tertiary` grip, hover `interactive-bg-hover`; the dragged row drops to 55% opacity.
- Text: name `body`, description `caption` in `label-tertiary`. Icons are the same Lucide glyphs the menu uses, 2px stroke.
- Expanded fields start under the name (28px inset), divided by a hairline; three equal columns of compact fields, one column under 640px.

Consumer provides: ordered sources `{id, icon, name, description, enabled, limits, aliases}` and reorder/toggle handlers.
