# SourceCard

One provider or local Agent inside a project card: identity and count on top, controls in the foot.

- Card: 0.5px `border-l2`, `radius-xl`, `bg-layer-2`, no shadow.
- Main: grid `source-mark` + text, gap 12px, padding 16px. Mark 44px on `bg-module-platform`; Agent logos render monochrome (`filter: brightness(0)`, inverted in dark).
- Summary: name `body-strong` (ellipsis), count `metric` right-aligned with a `caption` unit, status line `caption` in `label-tertiary`.
- Foot: min 68px, padding 16px, 0.5px `border-l2` top; switch on the left, buttons right-aligned.
- Errors: a `caption` line in `state-error-primary` under a 28% error hairline, inside the card.
- While listing, a 6% `label-primary` wash fills the card from the left; reduced motion holds it still.
- Agent cards show the detected default path (e.g. `~/.claude/projects`) in `code`, or the custom path if set.

Consumer provides: mark, name, count, status line, enabled state, actions, optional error.
