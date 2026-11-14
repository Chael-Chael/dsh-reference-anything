# ReferenceChip

The inline token a chosen @ candidate becomes in the composer and in sent messages.

- Inline-flex, baseline aligned, gap 3px, max 240px, text in `state-business-primary`.
- Marker (@) weight 500; 16px icon centred; label ellipsizes.
- Invalid (source closed or path gone): `state-error-primary`, line-through, 70% opacity.
- RA replaces only the glyph through a CSS mask on the host's icon slot; never re-render the chip's text or change its geometry.

Consumer provides: source kind (for the glyph) and label.
