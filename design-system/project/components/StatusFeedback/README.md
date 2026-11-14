# StatusFeedback

Badges, notices and progress: the monochrome ways settings report state.

- Badge: `label-primary` fill, `label-primary-foreground` text, `caption`, padding 1px 7px. Import states: 已导入, 部分导入, 未导入, 已归档.
- Notice: one line of `caption` on a `label-primary` fill (`radius-md`). Use for completed actions such as 重新扫描完成; errors stay inline.
- Progress: 6px `bg-module-platform` track, `label-primary` fill, label `caption` in `label-tertiary`. Partial at 70% opacity, failed or cancelled at 40%.
- No green, amber or red fills in settings; state words carry meaning.

Consumer provides: text, and for progress a ratio plus status.
