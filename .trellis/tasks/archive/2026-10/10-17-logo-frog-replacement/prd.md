# Replace logo with frog mark, theme-aware variants

## Goal

Replace the Cuepoint logo with the approved frog-hat mark everywhere it ships (Web, desktop, landing page, native bundle icons), and make the logo read well on both light and dark surfaces. The old logo (neon glow, semi-transparent) is illegible on light backgrounds and at small sizes.

The application itself stays dark-only in this task. A light theme for the whole application is a separate follow-up task (see Deferred).

## Source artwork (approved by owner)

Asset pack `~/Desktop/cuepoint-logo/v7-pack/` (outside the repo). Provenance copied into `research/`: pack README, source stencil, build and trace scripts, two preview sheets.

- Mark: black stencil disc with the frog-hat character cut out, so it works on any background. Colour variant: black disc, frog green `#7FB53B` hat, cream `#FFF1D6` face. The palette is a proposal, not a ratified brand palette.
- Ready in the pack: SVG (black / white / colour; auto-traced; 0.041% pixels differ from source), PNG marks, three app-icon tiles, favicon set, apple-touch and PWA icons.
- Known limits: auto-trace is not a designer master; the source is AI generated (copyright uncertain); 16 px is a plain downsample; no lockup exists for the new mark; the camera replaced the headphones, so the character leans video while the product also covers audio and music.

## Decisions (owner, 2026-10-17)

- **Scope A now, B after.** This task replaces the logo and makes assets light/dark-aware; the application's light theme is a separate later task.
- **In-app placements use the colour mark on both themes** (top bar, sidebar, agent avatar). No theme-switching logic. On dark surfaces the black disc blends into the background and the hat and face stay visible (`research/preview-in-app.png`).
- **Native desktop icon tile: cream `#F4F0E8` with the colour mark.**
- Proposed by the assistant, confirmed by approving the final summary: About page shows the symbol plus live text instead of a lockup image; `og:image` becomes a mark-only 1200 × 630 card.

## Confirmed facts (repository)

- Brand constants and assets: `packages/distribution/src/brand.ts` (`LOGO_SRC`, `LOGO_LOCKUP_SRC`, both `?v=20260922`) and `packages/distribution/public/brand/` (`logo.webp`, `logo-16/32/256.png`, `logo-lockup.webp`, `README.md`, `sponsor-wechat.jpg`). The directory is the shared `publicDir` for web, site and root Vite configs.
- Symbol consumers: `packages/studio/src/app/layout/AppFrame.tsx:170,203`, `features/agent/ui/HomeWelcome.tsx:52,97` (agent avatar), `features/agent/ui/TopicSidebar.tsx:133`; topbar image style `theme.css:176`. Lockup consumers: `features/settings/ui/AboutPage.tsx:51-55` (on a black box), `apps/site/landing.html:17,21` (`og:image`, `twitter:image`), asserted by `tests/landingEntry.test.ts:79`.
- Favicon links: `apps/web/index.html:7-9`, `apps/desktop/index.html:7-9`, `apps/site/landing.html` head.
- Native icons: `apps/desktop/scripts/generate-native-icons.py` composites `public/brand/logo.webp` over opaque `#0c0c0c` (lines 37-41); `--check` asserts alpha 255, corner RGB `[12,12,12,255]`, and artwork presence by red channel max `> 12` (lines 50-62); provenance hashes in `apps/desktop/src-tauri/icons/provenance.json`. Contract text: `.trellis/spec/frontend/native-workspace.md:128-152`.
- **The new stencil breaks that contract**: black ink over `#0c0c0c` is invisible, so the native source must be a dedicated tile.
- **The application is dark-only today**: `<html class="dark">` in both `index.html` files; `LobeChatTheme.tsx` forces `appearance="dark"`; Settings states "当前版本只提供深色主题" (`settingsModel.ts:24`); the landing page declares `color-scheme: dark` and `theme-color #101010`.
- Concurrent tasks `10-16-ui-ux-overhaul`, `10-16-composer-chat-copy`, `10-16-context-usage-compaction` are in progress on nearby UI.

## Requirements

- **R1 Web assets.** `public/brand` ships the new set: `logo.webp` (1024 px, alpha), `logo-16/32/48.png`, `favicon.ico`, `apple-touch-icon.png`, `og-card.png`, rewritten `README.md`; `logo-256.png` and `logo-lockup.webp` are removed.
- **R2 Constants.** `LOGO_SRC` version query bumped to `?v=20261017`; `LOGO_LOCKUP_SRC` deleted.
- **R3 In-app mark.** Top bar, mobile nav, sidebar, home and About use the colour mark; no theme-dependent switching.
- **R4 About page.** Replace the lockup image with the symbol next to live name text using existing tokens and the `font-display` stack. Tagline, GitHub link and sponsor sections unchanged.
- **R5 Heads.** The three HTML heads link `favicon.ico`, 32 and 16 px PNGs and `apple-touch-icon`; the landing page points `og:image` and `twitter:image` at `og-card.png`. Landing `theme-color` and `color-scheme` stay.
- **R6 Native icon.** Commit the cream 1024 px opaque tile as `apps/desktop/assets/app-icon-cream-1024.png`; change the generator and its checks to the new contract (design.md); regenerate every native member and provenance; keep the ICNS and ICO structure and reproducibility.
- **R7 Docs and spec.** Rewrite the "Native bundle icon" section of `.trellis/spec/frontend/native-workspace.md`, `public/brand/README.md`, and `apps/desktop/src-tauri/icons/README.md`.
- **R8 Tests.** New `tests/brandAssets.test.ts` (referenced brand URLs exist, dimensions, ICO sizes, no references to removed files); update `tests/landingEntry.test.ts:79`.
- **R9 Light/dark evidence.** The colour mark is shown legible on `#0c0c0c`, `#151515` and `#ffffff` at 24/48/96 px, rendered from the shipped `logo.webp`, plus an About page screenshot; saved under `research/`.

## Acceptance Criteria

- [ ] `public/brand` contains exactly `logo.webp` (1024 × 1024, RGBA), `logo-16/32/48.png`, `favicon.ico` (16, 32, 48), `apple-touch-icon.png` (180, opaque), `og-card.png` (1200 × 630), `README.md`, `sponsor-wechat.jpg`; `logo-256.png` and `logo-lockup.webp` are gone.
- [ ] No reference to `logo-256`, `logo-lockup` or `LOGO_LOCKUP_SRC` remains outside archived tasks and `tests/fixtures`.
- [ ] About shows the symbol with live text and no black-boxed image; top bar, mobile nav, sidebar and home show the new mark.
- [ ] `generate-native-icons.py --check` passes; a second generation changes no bytes; every native member is opaque with corner pixels `(244, 240, 232, 255)`; `source.png` equals the committed tile.
- [ ] `tests/brandAssets.test.ts`, `tests/landingEntry.test.ts`, `tests/aboutPageSponsorSave.test.ts`, `tests/settingsNavigation.test.ts` pass; `pnpm lint`, `pnpm test`, `pnpm quality`, `pnpm build` pass or any skipped gate is reported.
- [ ] R9 evidence saved; the mark is recognisable on all three backgrounds.
- [ ] The diff touches no application theme: no change to `theme.css`, `LobeChatTheme.tsx`, or Settings appearance.
- [ ] Spec and READMEs updated as in R7.
- Owner-run, outside this gate: packaged-app icon check (`--check --bundle`), signed installs on macOS and Windows.

## Out of scope

- The application light theme and any change to the `--brand` token or UI palette.
- A designer-grade vector master, trademark or similarity review, hand-tuned 16 px art.
- Reworking the audio and music narrative of the character.

## Deferred

- **Task B: application light theme** (`theme.css`, Lobe UI and antd forced dark, native shell surfaces, landing `color-scheme`). Create and plan it after this task, coordinated with the in-progress UI tasks. The colour mark needs no change when it lands.
- Text lockup (mark + names) and a richer social card, needing a designer and font decision.
- `docs/assets/installation/*` screenshots still show the old icon.
- macOS before Tahoe renders the opaque full-bleed icon as a square (existing behaviour).
