# Button

A 36px neutral action button; the settings surface has no blue buttons.

- Default: `bg-module-platform` fill, `label-primary` text, `body` style, `radius-md`, padding 0 `space-3.5`. Hover swaps the fill to `interactive-bg-hover`.
- Primary (`is-primary`): `label-primary` fill with `label-primary-foreground` text, so it inverts in dark. Hover uses `label-secondary`. Use it for one action per card at most (connect account, recheck, install).
- Disabled: opacity .42 and `not-allowed`; keep the label so the reason stays readable.
- Ghost (`is-ghost`): transparent until hover; only for icon buttons such as the drag handle or the 28px dismiss.
- Height stays `control-height` whatever the label; long labels wrap the row, not the button.

Consumer provides: the label (verb first, e.g. 重新检查, 连接账号) and the click handler. Source: `.dsh_ref_settings button` and the `*_actions button` rules in `src/client/styles.ts`.
