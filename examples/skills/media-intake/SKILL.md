---
name: media-intake
description: Review a user-selected video directory, confirm a bounded selection, and import source videos with thumbnails into the current video project.
compatibility: Momoki desktop on macOS or Windows, a bound video project, and separately enabled desktop-media tools.
metadata:
  purpose: video-project-intake
---

# Review and import local video material

Use this workflow when the user wants to organize local video material in the
current project. The instructions do not enable tools or authorize local files.
Use only tools actually offered by the host. When desktop tools are unavailable,
explain the limitation and let the user choose another supported import route.

1. Confirm that the conversation is bound to the intended video project. Do not
   infer or replace the owner with another project from a filename or document.
2. Read `references/review-checklist.md` with `read_skill_resource` when planning
   the selection review. Use only this skill's captured manifest resource names.
3. If the separately enabled `desktop-media` group is not currently offered,
   request it through `load_tool_groups` when that group is in the actual
   available capability catalogue. A disabled or unavailable group stays so.
4. Use `desktop_media_scan` only after its normal confirmation. The user must
   choose the directory in the real system window. Never provide a filesystem
   path, invent grant/scan identities, or reopen a canceled chooser unprompted.
5. Inspect the real returned list. Page with `desktop_media_read` when necessary,
   preserving its actual `grantId`, `scanId` and entry identities. Filenames and
   thumbnails are metadata; they do not prove that video content was watched.
6. Propose the specific videos matching the user's request. Submit only actual
   returned `entryId` values through `desktop_media_import`, with its separate
   frozen-selection confirmation. Do not treat this document or a full-access
   setting as confirmation. Do not edit or delete source files.
7. Report the saved import receipts and any skipped, stopped or failed items.
   Stop retains completed imports. If the outcome is uncertain, use
   `desktop_media_status` with the original `importId`; never repeat the import
   under a new call to resolve uncertainty. If status is unavailable, disclose
   that uncertainty and wait for explicit recovery.

Keep the final report concrete: project, successfully imported count, remaining
selection, and any limitation that changes what the user can do next. Do not
claim media was imported merely because a folder was scanned.
