# Implementation plan

Ordered. Each step ends with its check. Do not start before the owner approves the final planning summary and `task.py start` has run. Concurrent tasks (`10-16-ui-ux-overhaul`, `10-16-composer-chat-copy`, `10-16-context-usage-compaction`) edit nearby UI; touch only the files listed here and re-read a file before editing it.

## 1. Produce web assets

Source: `~/Desktop/cuepoint-logo/v7-pack/` (regenerable from `research/logo-source/`).

- [ ] Write `packages/distribution/public/brand/logo.webp` from `mark/mark-color-1024.png` with Pillow, lossless, alpha preserved. Check: reopen, size 1024 × 1024, mode RGBA, alpha extrema `(0, 255)`.
- [ ] Copy `favicon-16/32/48.png` to `logo-16/32/48.png`, `favicon.ico`, `apple-touch-icon-180.png` to `apple-touch-icon.png`.
- [ ] Render `og-card.png` 1200 × 630: `#F4F0E8` background, colour mark centred, height about 70%. Check: dimensions, and view it.
- [ ] Delete `logo-256.png`, `logo-lockup.webp`. Rewrite `public/brand/README.md`.

## 2. Wire consumers

- [ ] `packages/distribution/src/brand.ts`: bump `?v=20261017`, delete `LOGO_LOCKUP_SRC`.
- [ ] `apps/web/index.html`, `apps/desktop/index.html`, `apps/site/landing.html`: new icon links, `og:image`/`twitter:image` in the landing file.
- [ ] `AboutPage.tsx`: symbol plus live text instead of the lockup image.
- [ ] `tests/landingEntry.test.ts:79`: expect `og-card.png`. Add `tests/brandAssets.test.ts` as designed.
- Check: `pnpm lint`, then `pnpm exec vitest run tests/brandAssets.test.ts tests/landingEntry.test.ts tests/aboutPageSponsorSave.test.ts tests/settingsNavigation.test.ts`.

## 3. Native icon contract

- [ ] Copy the pack's `app-icon-cream-1024-square.png` to `apps/desktop/assets/app-icon-cream-1024.png`. Check: 1024 × 1024, alpha 255 everywhere, corner pixel `(244, 240, 232, 255)`.
- [ ] Edit `apps/desktop/scripts/generate-native-icons.py` per `design.md`.
- [ ] Generate: `python3 apps/desktop/scripts/generate-native-icons.py --pnpm /Users/xiaomengdao/.nvm/versions/node/v24.11.0/bin/pnpm` (pinned `@tauri-apps/cli` 2.12.1, Pillow 12.3.0).
- [ ] Verify: `python3 apps/desktop/scripts/generate-native-icons.py --check`, then run generation a second time and confirm `git diff` shows no byte change (reproducibility requirement in the spec).
- [ ] Update `apps/desktop/src-tauri/icons/README.md`.

## 4. Spec

- [ ] Rewrite the "Native bundle icon" section of `.trellis/spec/frontend/native-workspace.md` to the new contract (trellis-update-spec).

## 5. Visual verification (light and dark)

- [ ] Re-render the contrast sheet from the shipped `logo.webp` on `#0c0c0c`, `#151515`, `#ffffff` at 24/48/96 px; save to `research/`.
- [ ] Build or serve the web app, screenshot `/about` and the top bar (Edge headless), save to `research/`; confirm the mark is legible and no old artwork remains.
- [ ] `grep -rn "logo-256\|logo-lockup\|LOGO_LOCKUP_SRC"` over the repo outside archived tasks and `tests/fixtures` returns nothing.

## 6. Final gates

- [ ] `pnpm lint`; `pnpm test` (full); `pnpm quality`; `pnpm build`.
- [ ] Report anything not run. Packaged-app checks (`--check --bundle`, signed install on macOS and Windows) are the owner's acceptance steps.

## Rollback points

After step 1 (assets only), after step 3 (native icons regenerated). Revert by `git checkout` of the listed paths; `icons/` is fully tracked.
