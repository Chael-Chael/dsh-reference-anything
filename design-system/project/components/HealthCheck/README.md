# HealthCheck

The readiness checklist (dependencies, Chat Import API, OpenCLI) at the top of settings.

- Rows: min 64px, padding 12px 0, 0.5px `border-l2` dividers.
- Marker: 32px circle (`radius-round`). Passed: `label-primary` fill with a `label-primary-foreground` tick. Pending: `bg-module-platform`. Failed: error glyph in `state-error-primary`.
- Text: title `body`, detail `caption` in `label-tertiary`; actions are Buttons right-aligned.
- State always has a glyph and words, never color alone.

Consumer provides: items `{state, title, detail, action?}`.
