# Design: frog-mark logo replacement

Static asset replacement plus two contract changes (native icon source, About page lockup). No change to application theming, tokens or runtime behaviour.

## Principle

One colour mark serves every in-app surface, so there is no theme-switching code. "Light-aware" is achieved by asset choice and proven by verification on light and dark backgrounds, not by branching on the theme. This keeps task B (application light theme) free of any logo work.

## Web brand assets (`packages/distribution/public/brand/`)

| File | Source (asset pack `~/Desktop/cuepoint-logo/v7-pack/`) | Use |
|---|---|---|
| `logo.webp` | `mark/mark-color-1024.png`, lossless WebP, alpha kept | `LOGO_SRC`: top bar, sidebar, agent avatar, About |
| `logo-16.png`, `logo-32.png`, `logo-48.png` | `favicon/favicon-16/32/48.png` (bare colour mark, transparent) | favicons |
| `favicon.ico` | `favicon/favicon.ico` (16/32/48) | legacy browsers |
| `apple-touch-icon.png` | `favicon/apple-touch-icon-180.png` (cream, opaque) | iOS home screen |
| `og-card.png` | new, 1200 × 630, cream `#F4F0E8`, colour mark centred, no text | `og:image`, `twitter:image` |
| `README.md` | rewritten for the new set | provenance |
| `sponsor-wechat.jpg` | untouched | About page |

Removed: `logo-256.png` (its favicon role is taken by `apple-touch-icon.png`), `logo-lockup.webp` (it contains the old mark).

Why bare colour for favicons: tile versions collapse to a block at 16 px; the bare colour mark stays recognisable on light and dark tab strips (see `research/preview-sizes-and-variants.png`).

Why a mark-only OG card: no lockup exists for the new mark and the card cannot depend on a licensed or locally installed CJK font. A text lockup is deferred to a designer pass.

## Consumers

- `packages/distribution/src/brand.ts`: `LOGO_SRC` stays, version query bumped to `?v=20261017`; `LOGO_LOCKUP_SRC` is deleted (its only consumer is the About page). The header comment stays accurate.
- `AppFrame.tsx`, `HomeWelcome.tsx`, `TopicSidebar.tsx`: no code change; they already consume `LOGO_SRC`. The black disc blends into dark surfaces and the hat and face remain visible (owner decision; `research/preview-in-app.png`).
- `AboutPage.tsx` (lines 51-55): replace the lockup `<img class="bg-black">` with the symbol (`LOGO_SRC`, about `size-20`, decorative `alt=""`) next to live text: `PRODUCT_NAME_ZH` in the existing `font-display` stack and `PRODUCT_NAME_EN` in muted foreground. Text uses theme tokens, so it is correct on any future theme and needs no image lockup. Tagline, GitHub link and sponsor sections are unchanged.
- `apps/web/index.html`, `apps/desktop/index.html`, `apps/site/landing.html`: replace the three `rel="icon"` lines with `favicon.ico` (`sizes="any"`), 32 px and 16 px PNGs, plus `apple-touch-icon`; bump `?v=`. In `landing.html` point `og:image` and `twitter:image` to `og-card.png`. `theme-color` and `color-scheme: dark` on the landing page stay (task B).

## Native desktop icon (contract change)

Current contract: composite web `logo.webp` over opaque `#0c0c0c` (`generate-native-icons.py:37-41`), corners must equal `[12,12,12,255]`. The new stencil would be black on that tile, so the contract cannot stand.

New contract:

- New committed source tile: `apps/desktop/assets/app-icon-cream-1024.png`, from the pack's `app-icon-cream-1024-square.png`: 1024 px, fully opaque, full-bleed `#F4F0E8`, colour mark about 58% of the width. Same opaque full-bleed shape as today, so Tauri and platform behaviour does not change.
- Script `generate-native-icons.py`: `SOURCE` points at that file; `BACKGROUND` becomes `(244, 240, 232, 255)`; `opaque_source()` validates 1024 × 1024 and alpha 255 and returns the pixels unmodified (no compositing); the "logo artwork is absent" test (`image_check`, red channel max `<= 12`) becomes "artwork present" (red channel minimum well below the tile value, since the mark has black ink); provenance `background`, `composition`, `source` fields updated. Generation, ICNS canonicalisation, ICO size set, `--check`, and `--bundle` logic are unchanged.
- Regenerated: `icons/source.png`, `16x16`, `32x32`, `64x64`, `128x128`, `128x128@2x`, `icon.png`, `icon.icns`, `icon.ico`, `provenance.json`; `icons/README.md` updated.
- Spec `.trellis/spec/frontend/native-workspace.md` "Native bundle icon" section rewritten to the new contract. The retained rule: never edit Web branding to fix the native tile; regenerate and check the real bundle.

## Verification design

- `tests/brandAssets.test.ts` (new): every `/brand/...` URL in `brand.ts` and the three HTML heads resolves to a file in `public/brand`; `logo.webp` is 1024 × 1024 with alpha; PNG favicon dimensions from IHDR; `favicon.ico` directory lists 16, 32, 48; `og-card.png` is 1200 × 630; removed files are not referenced anywhere. Minimal binary header parsing, no new dependency.
- `tests/landingEntry.test.ts:79` updated to `og-card.png`.
- `generate-native-icons.py --check` (no bundle) must pass with the new contract.
- Visual: a static sheet of the colour mark on `#0c0c0c`, `#151515`, `#ffffff` at 24/48/96 px (done once in `research/preview-in-app.png`; re-render from the shipped `logo.webp`), plus a rendered About page screenshot. Real light-theme UI cannot be tested here (task B).

## Compatibility and risks

- Removed URLs `logo-256.png` and `logo-lockup.webp` will 404; previously cached social previews that point at them lose the image. Accepted: the old URL would show the retired mark.
- macOS before Tahoe shows an opaque full-bleed icon as a square (existing behaviour, unchanged). Not widened by this task.
- Source art is AI generated and auto-traced; copyright and trademark review are out of scope (owner aware).
- `docs/assets/installation/*` screenshots still show the old icon. Deferred, listed in the PRD.
- Packaged-app icon verification (`--check --bundle <App.app>`) needs a built app on macOS and Windows installed-state checks; left to the owner as in earlier tasks.

## Rollback

Everything is static files and one script contract. Reverting the commit restores the old assets, script and spec; native icons are regenerated artifacts tracked in git.
