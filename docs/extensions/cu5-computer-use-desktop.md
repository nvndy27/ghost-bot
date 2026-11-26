# CU.5 & CU.4 Hardening: Computer Use Desktop Live Viewer, Interactive Controls & P1 Closure

- **Branch**: `feat/cu5-computer-use-desktop` (branched from `6c72fce`)
- **Migrations**: `0001`–`0012` preserved unchanged.
- **Live model-driven Computer Use**: disabled (`liveModelDrivenEnabled: false`).
- **Native host desktop control & Virtual Desktop frame/input**: disabled (`hostDesktopControlSupported: false`, `frameCaptureSupported: false`, `inputInjectionSupported: false`).

## 1. CU.4 P1 Blockers Resolved

### `CU4-RUN-01` — Authoritative Daemon-Run, Bot, Archival & Permission Lifecycle
- Defined `PERMITTED_CU_RUN_STATES = new Set(['queued', 'running', 'awaiting_approval'])` in `apps/daemon/src/computer-use/service.ts`. Terminal and cancelling states (`completed`, `failed`, `cancelled`, `interrupted`, `cancelling`) are rejected.
- Added `revalidateAuthority(...)` checking active unarchived bot (`botRepo.getBot`), bot permission policy, authoritative `runs` row (`agent_id`, permitted status, `permission_mode` policy), unarchived parent `sessions` row, and `cu_sessions` + active worker identity.
- Enforced `revalidateAuthority(...)` at session creation, during worker startup (`start`, `createSession`, `openTab`), before `observeTab`, at approval issuance (`requestActionApproval`), at approval resolution (`resolveActionApproval`), before approval consumption (`executeAction`), and immediately before `worker.executeBatch(...)` dispatch.
- Added `revokeByRunId(runId, reason)` wired to `RunOrchestrator.setOnRunTerminated(...)` in `apps/daemon/src/execution/orchestrator.ts` and `apps/daemon/src/server.ts`, plus fail-closed `emergencyStop(...)` revocation on authority loss.
- Closed startup and dispatch cancellation races in `BwrapIsolatedBrowserWorker.start()`/`emergencyStop()` (`packages/computer-use/src/browser/bwrap-browser-worker.ts`) and `ComputerUseService.executeAction()`, preserving `uncertain` / `interrupted` outcomes when termination cannot be confirmed and preventing late callbacks or automatic replay (`replayAllowed: false`).

### `CU4-PKG-03` — Packaged Daemon Startup & Isolated Execution
- Fixed `apps/desktop/scripts/bundle-daemon.mjs` banner collision (`import { createRequire as __ghostCreateRequire } from 'node:module'; const require = __ghostCreateRequire(import.meta.url);`) eliminating `SyntaxError: Identifier 'createRequire' has already been declared` in `dist-daemon/daemon.mjs` and `dist-electron/main.js`.
- Verified actual packaged `dist-daemon/daemon.mjs` and extracted AppImage `squashfs-root/resources/daemon/daemon.mjs` startup, authenticated `/computer-use/capabilities`, isolated browser session creation, test-fixture navigation, PNG observation, and confirmed emergency stop.

## 2. CU.5 Desktop Live Viewer & Interactive Controls
- **Settings (`apps/desktop/src/components/ComputerUseSettingsSection.tsx`)**: Daemon-discovered capabilities, disabled VD/host/live-model indicators, explicit single-session consent form (never global or inherited by Teams/Routines), and session management (`Open Live Viewer`, `Close`, `Emergency Stop`).
- **Live Viewer Modal (`apps/desktop/src/components/ComputerUseLiveViewerModal.tsx`)**: Renders daemon-captured bounded PNG frames (`<= 2 MiB`, `<= 2 FPS` with backpressure drop counter and stale-frame indicator) without `<webview>` or `<iframe>`. Includes `mapScreenshotPointToViewport(...)` preview-only coordinate mapping, action preview form, single-use `Approve once` / `Deny` / `Execute Approved Action` cards, and sanitized action ledger (`replayAllowed: false`).
- **Right Panel & App Wiring (`RightPanel.tsx`, `SettingsModal.tsx`, `App.tsx`)**: Preserved three-panel shell, compact sidebar, and light/dark/system tokens.

## 3. Verification Evidence
- `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build`: PASS (11/11 projects).
- 3 consecutive full-workspace regression runs: **202/202** per run (`root` 109, `@ghost-bot/teams` 20, `@ghost-bot/scheduler` 17, `@ghost-bot/computer-use` 16, `@ghost-bot/memory` 14, `@ghost-bot/knowledge` 12, `@ghost-bot/mcp` 14).
- Electron E2E & IPC verification: `verify-cu4-computer-use-ipc.mjs`, `verify-cu5-computer-use-desktop.mjs`, `verify-phase-5b-scheduler-ipc.mjs`, `verify-phase-5c-routines-desktop.mjs`, `verify-phase-4d3-teams-acceptance.mjs`, `verify-phase-2e-acceptance.mjs` PASS.
- 4 parallel `@ghost-bot/mcp` concurrency stress workers: PASS.
- Installed RPM execution remains NOT VERIFIED (RPM package built without `sudo`/system install).
