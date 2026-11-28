# RC2.2 — Real Workspace

## Checkpoint

- Branch: `fix/rc2-real-world-usability`
- Worktree: `/home/nguyenduy/Documents/Projects/ghost-bot-worktrees/ghost-bot-rc2`
- Frozen parent: `3af223e2f680df8facee143d6210aefd190ce0ef`
- Routing evidence correction: `b4137002c9c37de7696316b0228b6fb1d4b90d0b`
- RC2.2 implementation: the separate follow-up commit on the same branch; the final exact SHA is reported in the PR #54 checkpoint.
- Scope: personal bot workspace selection and existing native read/write grant workflow.

## Implementation

The Files Explorer now exposes **Open folder** for personal bots both when no usable workspace is authorized and in the Explorer toolbar. It uses the existing Electron native directory picker and validated bot update route to persist the selected root. The daemon continues to own path canonicalization and invalidates prior read/write grants when the root changes. No authorization is granted by selecting a folder.

Read consent now uses an explicit native confirmation that names the daemon-resolved canonical folder. The main process submits that same canonical root to the existing daemon grant route; it no longer asks the user to select the configured folder a second time. Read consent remains separate from the native write prompt. Renderer input does not provide a path to the grant route.

This also provides a recovery path for existing seeded literal-tilde roots: the user selects a real folder in Explorer, replacing the invalid setting explicitly. No stored bot identity or conversation changes, automatic path rewrite, database migration, IPC contract, dependency or daemon authorization rule was added. Ctrl+S, revision validation, external-change detection and conflict protection use the existing editor/store/service paths.

The selected root and editor data remain personal-bot scoped. Root changes revoke the old grants and workspace context. Group filesystem access still requires the existing authorized task scope; Private Task Chat retains the existing workspace denial. No terminal or AI-mediated filesystem capability was enabled.

## Verification

- `tests/rc2-workspace-real-electron.test.ts` — 1/1 actual source-Electron scenario: legacy root recovery, mocked native folder selection, denied then granted read consent, file listing/open, explicit write consent, Ctrl+S disk verification, external modification conflict protection, and root switching with old-grant revocation.
- `tests/alpha2a-workspace-panel-shell.test.ts` — 3/3, including actual Electron shell and read-grant flow.
- `tests/alpha2b-workspace-files-editor.test.ts` — 7/7 service/store and security regressions.
- `tests/alpha2c2-safe-file-operations.test.ts` — 5/5, including actual Electron native consent/save/revocation.
- `tests/alpha2cd-discovery-electron.test.ts` — 1/1.
- `tests/alpha2d1-git-changes.test.ts` — 2/2.
- `tests/alpha4b-workspace-ui.test.ts` — 1/1.
- `tests/alpha1d-private-task-chat.test.ts` — 3/3; private task/session isolation, gated execution, restart recovery and duplicate delegation remain intact.
- Desktop typecheck, repository lint, desktop source build, and `git diff --check` passed.

Actual source Electron was launched with the test helper, Chromium sandbox enabled, mock runtime, and disposable synthetic profile/projects. Native dialogs were controlled by test doubles; no live provider inference or credentials were used. The desktop build was a source build for Electron E2E, not an AppImage/RPM or distributable package build.

The affected layout assertions now allow less than 0.5 CSS px error for target widths and control dimensions. Electron reported fractional flex geometry such as 399.996 px for a 400 px target and 31.992 px for a 32 px control. These test-only tolerances retain the intended bounds and selection/geometry checks; no production layout was changed.

## Remaining gates

- Exact published PR #54 hosted CI and focused independent acceptance remain separate gates.
- No authenticated real provider, live inference, package, or target-host acceptance was performed.
- Group task workspace access, AI-mediated filesystem operations, terminal access, rename/delete, and other previously gated capabilities remain gated.

## RC2.2B conflict-integrity CI correction

At `25c669191ec2b84e16ab0a254dbc423a5c854da2`, hosted CI reported that the synthetic external modification appeared to be overwritten by the draft. The inspected production path had two revision validations (before staging and immediately before atomic replacement), with per-file save serialization. The Electron test had not synchronized on the first Ctrl+S acknowledgement, and its post-save generic conflict-banner wait could match the pre-existing banner instead of the daemon rejection. This was a test synchronization defect; no production integrity regression was demonstrated.

The revised actual Electron scenario waits for the clean save acknowledgement, verifies the saved bytes on disk, waits for a clean external edit to reconcile into the editor (thereby establishing the new base revision), then edits a distinct draft and changes the disk externally. It checks that the editor retains the draft, waits for the daemon's exact revision-conflict error after attempting Save, and verifies the external bytes remain on disk. `tests/rc2-workspace-save-concurrency.test.ts` adds deterministic in-flight store coverage for preserving edits and refusing duplicate concurrent saves. Focused Electron/store and daemon revision/concurrency tests passed. No production source, permissions, schema, dependency or migration changed. Exact-head hosted checks remain pending.
