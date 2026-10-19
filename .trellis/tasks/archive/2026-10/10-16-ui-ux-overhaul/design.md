# Design (draft for review)

References: `research/screens/*` (Cursor sidebar; Codex sidebar, settings, effort slider popover, sub-agent panel), `research/reference-ux-patterns.md`, `research/copy-and-state-audit.md`, `research/popover-model-composer-audit.md`.

## Screenshot takeaways adopted
- Codex: single-line list items; compact composer footer with model+effort at right; effort as a slider popover with the current level labelled; settings rows are title + one muted line + control (we keep only the line when it adds information); errors/status are not stacked above the input.
- Cursor: tiny leading dot per conversation, trailing relative time; attached queue above the composer only for queued follow-ups.

## Sidebar marker (R1)
- Leading 16px cell, 3x3 dot-matrix (existing ThinkingMatrix pattern) for running; shared ticker (one timer for all rows) exposed by a small `useSharedTick`; static frame under reduced motion; dot for unread; amber marker for approval; red for error; precedence approval > running > error > unread.
- Trailing area: time on idle, actions on hover; no status in the trailing box.

## Shared status vocabulary (R3)
Running, Needs your approval, Needs input, Failed, Done. One `statusCopy` module consumed by sidebar, run details, batches, jobs; `版本 N` only where comparing versions; recovery wording: "Not confirmed - Check / Retry / Skip".

## Error placement (R4)
Composer-attached strip: queue only. Run error: inline in failing turn with one action. Persistent page failures: inline at control/region; toasts only for transient success/info. Single helper for backup-failure messaging.

## Popover system (R6)
- One shared `PopoverSurface` contract in `ui/`: `max-height: var(--radix-popover-content-available-height)`, overflow auto, collisionPadding incl. 52px top bar, `avoidCollisions`, width `min(--w, available-width)`; submenus scroll.
- Migrate the antd/lobehub menus in the composer (model settings, permission, "+") to the same Radix wrappers; one portal root and z-index scale.
- Truncated labels get tooltip or two-line wrap; model rows show full id on hover/title and in detail.

## Model + effort popover (R7)
- Trigger: `<model short name> <effort>` chip. Popover: searchable model list (grouped, scroll), selected check mark, below it an effort control (segmented for <=4 levels, slider for more) shown only when the model supports reasoning.
- Effort capability resolved in a new `reasoningCapability(model, connector)`: sources in order user override, provider `/models` metadata, models.dev `reasoning`, built-in table (replaces six-id allowlist). Level set per provider adapter (e.g. aihubmix drops `max`); request mapping unchanged and tested per adapter. Stored in `ChatThread.reasoningSelection` as today.
- Decision (owner): models.dev `reasoning: true` with unknown level support defaults to low/medium/high; user override allowed.

## Composer strip relocation (R8)
| Item | New home |
| --- | --- |
| attention queue (approvals/confirmations) | attached strip above composer |
| run status + Stop | turn footer / composer send button becomes Stop |
| run error | inline in failing turn |
| project unavailable | thread header notice |
| 需求沟通中 hint | removed (empty-state line only if needed) |
| task summary | header chip -> side panel; plan card in stream |

## Copy cleanup (R2/R3)
Applied from the audit top-10 first; every removed sentence is listed in `research/deferred.md` if it needs a later pass. Settings rows keep a description only when it adds non-obvious info.

## Risks
- Many tests assert Chinese copy; update, do not weaken. Visual verification by screenshots in the real app.
- Effort mapping per provider needs transport tests; real providers not exercised here.

## Refined surfaces, settings entry, MCP/Skills sections (R9-R11)
- Selected style token: soft background (`--surface-selected`), foreground weight, trailing check where confirmation is needed. Remove `border-left` / `::before` active bars across sidebar, settings nav, lists, model picker, tabs; verify by grep for border-left/inline-start accent and screenshots.
- Settings: button pinned in the lower-left of the module rail/sidebar; the top entry removed.
- Settings sections become: General, Appearance, Models (providers/models), MCP, Skills, Storage, Update. MCP moves out of ConnectorsSection; Skills management (currently InstalledSkillsPanel dialog opened from AgentControls) gets a section reusing the same controller, while the composer menu keeps a per-thread toggle/shortcut.

## Tool-call rows (R12)
Introduce `--text-secondary`/size tokens for tool rows (about 12-13px vs body 14-15px, line spacing reduced ~25%); verb in secondary, object in tertiary; failed/awaiting-approval/active keep stronger color or icon accent. Applies to grouped tool rows and single calls in run details and the message stream.

## Turn problem bubble (R13)
- Model: `turnProblem = {kind: 'unsent'|'interrupted'|'failed'|'stopped', reason, action}` derived from the E02 submission attempt state and the run outcome; one per thread, latest wins; `dismissed` stored per problem id in memory (not persisted).
- Component: `ComposerNotice` (icon, one-line reason, primary button, close) rendered at the top of the composer card attachment area, below it the approval/confirmation queue stays a separate list. Replaces `turnStatus` error row, SubmissionMessage inline text, the corner error text and the 'needs attention: interrupted' card.
- Actions map to existing behaviours: unsent -> retry (admission re-read as in E02), interrupted -> continue (existing continuation), failed -> retry/regenerate. 'Restore draft' disappears: the unsent text is back in the composer.

## Composer cards (owner, 2026-10-16)

Replaces the fused status bar (`ours-composer-notice.png`). Target: `cursor-agents-card.png`, `cursor-canvas-card.png`.

The composer box holds only the draft, attachments, and footer controls. A decision, a result, or a failure is a separate card 8px above it: own radius, own surface, own shadow, one close control. At most one card is visible. When two or more card kinds exist, a row of small pills sits between the card and the composer. With nothing to show, the area above the composer is empty. Running work stays in the sidebar and the stop button.

| Kind | Header | Body | Action |
| --- | --- | --- | --- |
| Decision | the action name, e.g. tool approval | one muted line naming the target | one button: 允许 or 查看 |
| Result | the artifact title | two muted lines of preview | 打开, bottom right |
| Problem | none | one short reason | 重试 or 继续 |

No "needs attention", "progress saved", or stacked banners. Pending approvals stay a decision card, not mixed into the problem card.

## Plus secondary sheets

Skills / MCP / parameters share one toolbar (back + search + optional 管理 link). No titles. One inner scroller. Remaining composer/chat copy lives in child `10-16-composer-chat-copy`.
