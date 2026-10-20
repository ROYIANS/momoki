# Momoki brand assets

Frog-hat mark (black stencil disc with the character cut out), approved 2026-10-17.
The colour mark works on light and dark surfaces, so in-app placements use it on
both and no theme switching exists. Replace assets together with the `?v=` query in
`packages/distribution/src/brand.ts` and the icon links in `apps/web/index.html`,
`apps/desktop/index.html` and `apps/site/landing.html`.

- `logo.webp`: 1024 × 1024 lossless colour mark with alpha (`LOGO_SRC`): top bar,
  sidebar, agent avatar, About page.
- `logo-16.png`, `logo-32.png`, `logo-48.png`: bare colour mark, transparent, for favicons.
- `logo-loop.mp4`: 360 × 360, 24 fps, 5.2 s, H.264, no audio track (`LOGO_LOOP_SRC`). Home hero hover
  animation; opens on the `logo.webp` composition, holds its last frame. Opaque pure-black background,
  removed in CSS with `mix-blend-mode: lighten` (dark surface only; a light theme needs an alpha WebM).
- `favicon.ico`: 16, 32 and 48 px for legacy browsers.
- `apple-touch-icon.png`: 180 × 180 opaque cream tile with the colour mark.
- `og-card.png`: 1200 × 630 social card, cream `#F4F0E8`, centred mark, no text.
- `sponsor-wechat.jpg`: user-supplied 1152 × 1152 appreciation code, preserved without
  modification; the About page shows it in a dialog and offers the original for download.

Palette (proposal, not a ratified brand palette): ink `#111111`, frog green `#7FB53B`,
cream `#FFF1D6`, light tile `#F4F0E8`.

Provenance: generated from the owner-approved asset pack v7. The source stencil, build
and trace scripts and preview sheets are kept in
`.trellis/tasks/10-17-logo-frog-replacement/research/`. Caveats: the source is an
AI-generated bitmap (copyright unreviewed); vector tracing is automatic, not a designer
master; 16 px is a plain downsample. There is no text lockup for this mark.

The native desktop icon is a separate asset owned by `apps/desktop/assets/`.
