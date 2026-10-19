# Deferred items (Batch 6, non-chat copy/error pass)

## Kept on purpose
- `版本 N` where users compare or pin versions: material history select / "用于项目 · 版本固定" / use list (`MaterialDetailPanel`), memory 历史版本 list rows (`ProjectMemoryPage`). Header-only revision labels were removed.

## Left for the chat-UI owner (features/agent/ui, out of scope here)
- `TaskBoard` header description, `TaskWrapup` / `TaskRecords` / `MemoryContextDetails` / `MusicGenerationReview` revision labels, `AgentGenerationBatches` / `AgentGenerationResults` / `AgentRunDetails` / `AgentJobReport` / `AgentDesktopMediaReport` unknown-outcome wording, `SubmissionMessage`, `AgentControls` uncertain-write text, `ReferenceLibrary` helper lines, `ContextUsagePanel` mechanics text.
- The uncertain-outcome vocabulary there should match the wording used here: "未确认 …" plus one action (核对 / 重试 / 跳过). `tests/desktopMediaUi.test.ts` still asserts `导入结果待核对` for `AgentDesktopMediaReport`.

## Not changed
- `WorkspaceChrome` cover upload/clear failures and backup failures stay as toasts: they are one-shot user actions with no persistent state to show; backup logic is now a single helper (`platform/runtime/backupFeedback.ts`).
- `ShotEditorPage` relation-dialog "close while unsaved" toast stays (transient guard message).
- `ConnectorsPage` model probe failure still uses `showError` (transient discovery result); test/save/disconnect failures are now inline in the editor dialog.
- `settingsModel.ts` search descriptions (not rendered rows) still carry the longer wording.
- Smaller helper lines elsewhere (e.g. `ProjectSettingsPanel` section descriptions, `MemoryContextDetails`, audio batch dialogs) shortened only where listed in the audit.
