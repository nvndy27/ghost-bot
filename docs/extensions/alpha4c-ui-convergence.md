# Alpha.4C — Shared UI convergence

Status: **Tested** on isolated integration branch `integration/alpha4-unified`; hosted CI and CodeQL passed on `117a0c208247439f47442404e0cbdace92477806`. Independent review blocked that exact head on four release-tooling findings, now addressed by a focused correction that requires fresh checks and delta acceptance. Maintainer visual acceptance remains pending.

## Inputs and history

- Accepted Alpha.3C base: `5a8c69dc1b9a6d590273dcd05f0d54629127fb47` (PR #49).
- Alpha.4A: `3d35918bfbb208d12fa8005425ec49da4dd4af30` (PR #50).
- Alpha.4B: `41623c5deee82f82188a689beebb69a8403a1ea6` (PR #51).
- Shared V03.2 contract: `85f4b7f2c486ece800a82e8dd7f9c450d7389647`.
- Approved source archive SHA-256: `85f495035c61f2387b215de983c09249baa6f69b3c3e9920c82d215410b6bd67`.

Both implementation histories are preserved by merge commits. PR #51 already contains the shared contract through its ancestry. Source and checksums were re-verified from the approved archive; the handoff, reference CSS, prototype and PNGs remain the V03.2 visual authority.

## Integration changes

- Settings validation now defaults new profiles to a 400 px Workspace and accepts saved widths through 2048 px. Existing saved widths are retained. Effective desktop display and resize limits are 220 px minimum and 65 percent of the viewport; at <=760 px the panel overlays the center area and is capped at 90 percent. Effective clamping does not rewrite a saved width when the viewport shrinks.
- `RightPanel.onOpenTools` navigates to the existing Tools & MCP Settings section.
- Workspace Overview no longer duplicates provider quota. The sidebar Usage Center is the quota and refresh surface. Runtime details retain actual runtime/connection state and reconnect action.
- Browser native-view bounds now close for modal/dialog, menu, popover and composer popover surfaces and restore when they close. Existing authorization, isolation and native-view lifecycle remain in the existing services.
- Added focused settings/effective-width checks and integrated narrow viewport, tools, usage, and modal overlap assertions.

No daemon, IPC, migration, provider, permission, package or runtime capability changed. Existing native grants and all Files, Git, Browser, Output, Group and Private Task gates remain unchanged.

## Focused verification

- `pnpm lint` — passed.
- `pnpm -r --if-present typecheck` — passed for all 11 packages.
- `pnpm --filter @ghost-bot/desktop build` — passed. This is the source build, not package generation.
- `node --experimental-strip-types --test tests/alpha4c-ui-convergence.test.ts` — 2/2 passed.
- `node --experimental-strip-types --test tests/alpha4b-workspace-ui.test.ts` — 1/1 passed on the final screenshot-enabled run. Covers the five Workspace tabs, group Files denial, initial width, resize bounds, narrow overlay, Settings route and quota deduplication.
- `node --experimental-strip-types --test tests/alpha2e1-workspace-browser.test.ts` — 2/2 passed, including actual Electron native Browser view hide/restore beneath Usage and Settings.
- `node scripts/verify-alpha4a-electron.mjs` — passed on the integrated worktree: Personal and Group Chat, drafts, responsive shell, Settings, Accounts, Usage, avatar presets and persistence.
- `git diff --check` — passed.

Tests ran with the offline mock runtime and synthetic local workspace files; no provider inference occurred. The Electron binary was reused from the accepted local development worktree because the offline install intentionally skipped lifecycle scripts. No package was rebuilt.

## Integrated screenshots

All files below are actual Electron captures from this integration worktree, using synthetic conversation/team/workspace data:

- Shared UI: [Personal Dark](../../design/reviews/alpha4c-shared/personal-dark-1440.png), [Group Light](../../design/reviews/alpha4c-shared/group-light.png), [Settings Light](../../design/reviews/alpha4c-shared/settings-light.png), [Usage Light](../../design/reviews/alpha4c-shared/usage-light.png).
- Workspace tabs: [Overview Dark](../../design/reviews/alpha4c-workspace/overview-dark-1440x900.png), [Files Dark](../../design/reviews/alpha4c-workspace/files-dark-1440x900.png), [Changes Dark](../../design/reviews/alpha4c-workspace/changes-dark-1440x900.png), [Browser Dark](../../design/reviews/alpha4c-workspace/browser-dark-1440x900.png), [Output Dark](../../design/reviews/alpha4c-workspace/output-dark-1440x900.png).
- Light Workspace: [Overview](../../design/reviews/alpha4c-workspace/overview-light-1440x900.png), [Files](../../design/reviews/alpha4c-workspace/files-light-1440x900.png), [Changes](../../design/reviews/alpha4c-workspace/changes-light-1440x900.png), [Browser](../../design/reviews/alpha4c-workspace/browser-light-1440x900.png), [Output](../../design/reviews/alpha4c-workspace/output-light-1440x900.png).
- Narrow layouts: [Personal workspace overlay at 720 px](../../design/reviews/alpha4c-workspace/workspace-overlay-narrow.png), [Group workspace overlay at 720 px](../../design/reviews/alpha4c-workspace/team-workspace-overlay-narrow.png), [Explorer overlay at 220 px](../../design/reviews/alpha4c-workspace/files-explorer-overlay-220.png).

## Visual comparison and remaining limitations

The integrated shell follows V03.2's 224/56 px sidebar, 58 px headers, 400 px new Workspace default, neutral surfaces, compact five-icon Workspace tabs and 220 px minimum. At <=760 px Workspace overlays rather than compressing Chat; Files Explorer overlays at its existing narrow threshold. Original Ghost Bot branding, all avatar artwork, production content and real control states are retained.

The prototype's sample quota, activity and repository content are intentionally absent; actual provider snapshot and runtime diagnostics are shown. Account-level quota beyond the existing runtime snapshot remains unavailable. Existing saved widths may display below the new default by design. Group Workspace Files remains unavailable without its authorized task scope. These are capability/data differences, not substituted UI fixture content.

Hosted CI and CodeQL passed on the original unified SHA `117a0c208247439f47442404e0cbdace92477806`; independent review then blocked it on release-tooling findings. The corrected head must pass its own hosted checks and focused independent delta review. Maintainer visual approval also remains open. No PR was merged.
