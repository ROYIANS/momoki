# UI/UX overhaul: concise copy, clear states, sidebar status indicators

## Goal

Make Studio and the Agent chat feel like Cursor / Codex / deepseek-harness (dsh): little text, states a user can act on, errors where the user is looking. Inputs: `research/copy-and-state-audit.md` (our inventory) and `research/reference-ux-patterns.md` (rules R1-R15).

## Requirements

### R1. Conversation sidebar item
- Status marker moves to a fixed leading cell (about 16px) before the title; the trailing area keeps only time/actions.
- Running uses the existing dot-matrix animation (`ThinkingMatrix`-style 3x3), not the rotating ring; one shared timer for all rows, static pattern under reduced motion.
- Unread dot is in the same leading cell. Precedence: needs-your-action, then running, then error, then unread, then none (dsh `Rows.tsx:345-398`, Cursor conventions).
- Waiting for approval gets a visible marker (today screen-reader only). The read-failure `!` glyph becomes a proper error marker.
- No layout shift between states; row height unchanged; the delete/time affordance still works.

### R2. Remove redundant text
- Drop page-header and empty-state descriptions that restate the title or read like tutorials (about 20 sites); keep one short line only where an action is needed.
- Trim explanatory settings rows (Update, Storage, Appearance, General) to label + control.
- Remove duplicated helper/“can't confirm the save” paragraphs where a single status suffices.

### R3. Plain-language states
- Replace internal wording (`受理`, `待核实`, `修订`, `版本 N`, 'uncertain outcome', submission-recovery jargon) with short user terms and one clear action (e.g. Retry / Check / Skip). Keep revision numbers only where users compare versions.
- Shared status vocabulary (Running, Needs your approval, Needs input, Failed, Done) used by sidebar, run details, batches and jobs.

### R4. Error placement
- One error surface per context: inline at the failing control or a single strip above the composer; persistent failures are not toast-only; transient confirmations may be toasts. Dedupe stacked messages (composer strip showing 4+ items; `AgentGenerationBatches` ~7 alert surfaces; duplicated backup-failure toast logic).
- Errors are one short sentence plus one action; details expandable, not inline.

### R5. Consistency
- Central copy/status tokens so the same state reads the same everywhere; i18n resources stay in the existing mechanism.

### R6. Popovers never clip
- Every popover/menu/select has a viewport-aware max-height with internal scroll, collision padding that respects the top bar, and works in a right-docked panel and small windows. Truncated text (model names, project names, titles) is readable in full via tooltip or wrapping. One popover stack (z-index, portal root) instead of four libraries' conflicting layers; submenus scroll.

### R7. Model and effort selection (composer lower right)
- One compact trigger shows model + effort (Codex style: `Model  Effort`); one popover selects both, with effort as a short segmented/slider control and a clear selected state; no two-step nested antd-to-Radix flow; preview is not hover-only.
- Effort is selectable for every model that supports reasoning: the hard-coded six-model allowlist is replaced by model metadata (models.dev `reasoning`, provider `/models`, user override) per connector, with safe request mapping per provider; unsupported levels are hidden, not disabled with explanations.

### R8. Composer attachment strip
- The strip above the input is only for the composer-attached queue (pending approvals/confirmations, queued messages, attachments). Run status + Stop go to the message stream/turn footer, run errors to the failing turn inline, 需求沟通中 hint removed or moved to the empty/stream area, project-unavailable to the thread header, task progress to a header chip or side panel / plan card. Placement table in `design.md`.

### R9. Refined surfaces (no left-border accents)
- Active/selected states stop using a left border line or bar as decoration (sidebar items, settings nav, list rows, model-picker selected model, tabs). Use background tint, weight/contrast, and a check mark where a selection needs confirmation; one consistent selected style from the design tokens. Audit all `border-left`/`inset-inline-start` accent patterns and `::before` bars.
- Overall polish: consistent radius/spacing/elevation, subtle layered surfaces, restrained borders.

### R10. Settings entry
- Settings opens from a button at the lower left of the main navigation (as in the Codex screenshot), not from the top/other positions.

### R11. Independent MCP and Skills management
- Today MCP is rendered under the model connectors inside the `connections` ("连接与模型") settings section (SettingsPage.tsx:83-86), and installed-skills management exists only as a dialog opened from the composer's controls menu (AgentControls.tsx:354). Both become their own settings sections (MCP, Skills), with the composer menu keeping only a shortcut/toggle for the current thread. Connections section keeps providers and models only.

### R12. Tool-call rows are secondary text
- Tool-call titles (`agent-tool-verb` in `AgentRunDetails.tsx:130,185` and sibling tool/step rows) currently use the same white and size as body text. Make them secondary: smaller font size than the body, tighter row spacing, muted gray from the theme tokens (not hard-coded), while keeping light/dark contrast (verb slightly stronger than its object, hover/expanded and failed/awaiting-approval states regain emphasis). Contrast must stay >= WCAG AA for the text that carries meaning.

### R13. Interrupted / failed / unsent turns: one dismissible bubble
- Screenshot `research/screens/ours-interrupted-run-before.png` shows one event told three times (red corner text, 'unsent / retry / restore draft' beside the message, an attached card 'needs your attention - interrupted, progress saved').
- Replace all of it with ONE dismissible bubble attached above the composer: short reason on the left (e.g. 网络中断, 模型返回错误, 消息未发送), one primary button on the right (继续 / 重试), a close control. One bubble at a time (latest wins); dismissed stays dismissed until a new failure.
- No status text in the message stream for these cases, no red corner text, no 'progress saved' or 'needs your attention' wording. When a send fails before acceptance the text returns to the composer automatically (no separate 'restore draft' action). Pending approvals/confirmations keep their own attached queue and are not mixed with this bubble.
- Reasons come from a small mapped set (network, model error, unsent, stopped by you, app restarted); unknown errors show a generic short reason with details in a tooltip/expandable.

## Constraints

- No behaviour change to data, execution, or the E01-E11/E16 guarantees; accessibility labels kept (and added for new markers); reduced-motion honoured; existing tests updated rather than weakened.
- Visual changes verified in the real UI (screenshots) for sidebar states, composer errors, batch review, settings.

## Acceptance Criteria

- [ ] Sidebar states (idle, running, unread, approval, error, running+unread) render with a leading marker; screenshots attached; no layout shift.
- [ ] Audit top-10 offenders resolved or explicitly deferred in `research/deferred.md`.
- [ ] No stacked duplicate error messages in the composer strip; persistent failures have an inline surface.
- [ ] Copy changes covered by updated tests; `tsc -b`, affected vitest lanes and lint pass.
- [ ] No popover clips at 720px window height and in the docked panel (screenshots); full text reachable for truncated labels.
- [ ] Effort chosen from the composer popover for a reasoning-capable model, and the provider request carries it (test); unsupported models show no effort control.
- [ ] Composer strip holds only the attached queue; relocated items verified.
- [ ] No left-border accent remains on active/selected states (grep + screenshots); selected model in the picker uses the new style.
- [ ] Settings button at the lower left; MCP and Skills have their own settings sections.
- [ ] Tool-call titles render smaller/tighter in a muted gray with preserved light/dark contrast in both themes (screenshots).
- [ ] An interrupted, failed and unsent turn each show exactly one dismissible bubble above the composer with a short reason and one button; nothing else in the stream or corner (screenshots).
- [ ] Reduced-motion and a11y labels verified.

## Out of scope

- E11 process boundary; new product features; visual redesign of brand/theme beyond the listed items.
