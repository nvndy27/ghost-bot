# Phase 4D.2: Teams Desktop Integration & Security Hardening

- **Branch**: `feat/phase-4d2-teams-desktop`
- **Base Checkpoint**: `707ab1f` (`feat/phase-4d1-teams-production`)
- **Status**: Verified (Offline Mock & Electron E2E) / Live Teams Gated (`LIVE_TEAMS_GATED`)

## 1. Summary of Changes

### Daemon & IPC Hardening
- **`apps/daemon/src/teams/execution-bridge.ts`**:
  - Added fail-closed `LIVE_TEAMS_GATED` enforcement when `runtimeMode !== 'mock'`, ensuring live Teams execution cannot run silently or bypass runtime policy checks.
  - Updated `awaiting_approval` child run polling to continue polling up to deadline so child approval resolution completes cleanly.
- **`apps/daemon/src/teams/service.ts`**:
  - Added `updateTeam` with strict validation of lead/member membership and bounds.
  - Added single-flight `activeRunExecutions` guard and Chief of Staff `leadPolicy` preflight check in `startTeamRun` + `autoExecute`.
  - Added `listRunsForTeam` and `listPendingApprovalsForRun` (fixed SQL query to map `approvals.action_type` / `action_summary` and filter `a.status = 'pending'`).
- **`packages/shared-types/ipc.ts`**, **`apps/daemon/src/server.ts`**, **`apps/desktop/electron/preload.cts`**, **`apps/desktop/electron/main.ts`**:
  - Added `TEAMS_UPDATE`, `TEAMS_RUN_LIST`, `TEAMS_RUN_APPROVALS` IPC channels, HTTP daemon routes (`PATCH /teams/:teamId`, `GET /teams/:teamId/runs`, `GET /teams/runs/:teamRunId/approvals`), and `autoExecute` support on `StartTeamRunIpcInputSchema`.

### Desktop UI Integration
- **`apps/desktop/src/components/TeamEditorModal.tsx`**: Create, edit, and archive (with confirmation) teams, assign Chief of Staff (`leadBotId`), manage members (`memberBotIds`), and configure execution bounds.
- **`apps/desktop/src/components/TeamWorkspaceView.tsx`**: Team header with `Simulated (Mock)` / `Live Teams Unavailable` badge, run selector, collapsible DAG Plan Preview & Task Ledger, worker-specific single-action approval cards (`Approve once` / `Deny`), untrusted worker output badges, cancellation/uncertainty banner, and composer with IME composition guard.
- **`apps/desktop/src/components/TeamRightPanel.tsx`**: Chief of Staff, member role/permission list, task progress & concurrency counts, explicit **Estimated Budget vs Actual Reported vs Unknown Usage**, and cancellation/quarantine status.
- **`apps/desktop/src/components/LeftSidebar.tsx`** & **`apps/desktop/src/App.tsx`**: Replaced static `MOCK_TEAMS` with daemon-backed `listTeams`, team creation/selection, bounded polling for active team runs, and stale-response sequence guards (`teamRequestSeqRef`).

## 2. Verification Evidence
- **Workspace Lint, Typecheck & Build**: `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build` — **PASS** (12/12 workspace projects).
- **MCP Concurrent Stress Test**: 4 parallel workers running `packages/mcp/tests/unit/bounded-stdio-transport.test.ts` + `packages/mcp/tests/integration/hardening-regression.test.ts` — **PASS** (4/4 each, 0 failures).
- **3 Consecutive Full Regression Runs**: `corepack pnpm test && corepack pnpm -r --if-present test` — **PASS** across 3 consecutive runs (87/87 root tests + all workspace package suites, 0 failures, 0 skipped).
- **Offline Electron E2E & Visual Review**: `node scripts/verify-phase-4d2-teams-desktop.mjs` — **PASS** (team create/edit, DAG preview, mock run execution & completion, light/dark screenshots in `design/reviews/phase-4d2/`, single-bot chat switch, Electron restart persistence).

## 3. Known Limitations & Next Steps
- **Live Teams Execution**: Intentionally gated behind `LIVE_TEAMS_GATED` outside `mock` mode until live multi-agent orchestration quotas, approvals, and recovery are explicitly enabled.
- **Next**: Independent read-only review by Agent 2; do not merge into `main` or start Scheduler integration until approved.
