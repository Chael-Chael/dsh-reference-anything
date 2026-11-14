# Switch

The monochrome on/off control used for every source, agent and option toggle.

- Track `switch-width` × 20px, `radius-pill`, 2px inset; thumb 16px `radius-round`.
- Off: track `border-l3`, thumb `switch-thumb`. On: track `brand-primary` (black in light, near-white in dark), thumb `label-primary-foreground`, moved 16px.
- 160ms ease on track and thumb; none under reduced motion.
- Render as `button[role="switch"]` with `aria-checked`; the visible text label sits beside it in `body`.
- Never tint it blue: blue is reserved for focus and links.

Consumer provides: `checked`, `onChange`, and an accessible label.
