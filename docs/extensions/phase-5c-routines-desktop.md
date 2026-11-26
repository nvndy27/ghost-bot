# Phase 5C — Routines Desktop Integration & Production Hardening

- **Branch**: `feat/phase-5c-routines-desktop`
- **Base Commit**: `69d4670` (`feat(scheduler): Phase 5B Production Scheduler & Routines Daemon Integration`)
- **Accepted Teams Hardening Ancestor**: `f5dc1e9`
- **Production Migrations**: `0001`–`0011` (`0001`–`0010` preserved unchanged; forward migration `0011_scheduler_task_approval_cols` adds `daemon_run_id TEXT` and `daemon_approval_id TEXT` to `scheduler_tasks`).

## 1. Phase 5B Production Hardening

1. **In-flight Dispatch Cancellation (`apps/daemon/src/scheduler/execution-bridge.ts`)**
   - Added `inFlightDispatches` (`Map<string, { botId, cancelRequested }>`) keyed by `${taskId}:${attempt}` around child run creation in `DaemonRoutineDispatcher.dispatch`.
   - `cancelTaskExecution` refuses false `{ confirmed: true }` while child-run creation is still in flight (`confirmed: false`, `reason: 'Cancellation requested while dispatch is in flight'`).
   - On dispatch timeout (`DISPATCH_TIMEOUT`), `DaemonRoutineDispatcher` requests cancellation via `orchestrator.cancelRun` or `teamsService.cancelTeamRun`.

2. **Durable Approval & Execution Link Correlation (`apps/daemon/src/db/migrations.ts`, `apps/daemon/src/scheduler/service.ts`, `apps/daemon/src/server.ts`)**
   - Forward migration `0011_scheduler_task_approval_cols` adds `daemon_run_id` and `daemon_approval_id` to `scheduler_tasks`.
   - `SchedulerService.getTask` returns persisted `executionLink` and `approvalLink`.
   - `SchedulerService.handleDaemonApprovalResolved` updates linked `scheduler_tasks` when `POST /runs/:runId/approvals/:approvalId` resolves an approval.

3. **Strict Routine IPC Contracts & Bounded Payloads (`packages/shared-types/ipc.ts`, `apps/desktop/electron/main.ts`)**
   - Replaced loose routine DTOs with strict Zod DTO schemas (`RoutineRecordDtoSchema`, `RoutineTaskDtoSchema`, `RoutineTriggerResponseDtoSchema`, `RoutinePreviewDtoSchema`, `RoutineDiagnosticsDtoSchema`, `RoutineSimulationDtoSchema`, `RoutineStatsDtoSchema`, `RoutineImportPreviewDtoSchema`, `RoutineImportCommitDtoSchema`, `RoutineExportBundleDtoSchema`, `RoutineNotificationDtoSchema`).
   - Added `assertBoundedRoutinesIpcPayload` in `apps/desktop/electron/main.ts` enforcing max payload size (`300 KiB`) and max nesting depth (`12`).

## 2. Desktop Routines UI Integration

- Added `apps/desktop/src/components/RoutinesSettingsSection.tsx` wired to the typed `window.ghostBot` routine IPC channels:
  - Create / edit routines (interval, cron with IANA timezone validation, event-driven, expiration, missed-run policy, bounded retry policy, concurrency policy).
  - Enable / disable / archive / manual trigger (`Run now`) / task cancellation.
  - Schedule preview (`Preview Schedule`), diagnostics (`Diagnose`), dry-run simulator (`Simulate (Dry Run)` with `Simulated Only · No Tasks Enqueued`), and execution history (`Execution History`).
  - Routine notifications inbox with unread count, mark-read, and dismiss (`Dismissal does not approve, deny, or cancel tasks.`).
  - Portable JSON export and import with conflict policy (`skip` / `overwrite` / `rename`) and disabled-by-default imports.
  - Explicit `Simulated (Mock)` badge and notice that schedule eligibility does not grant autonomous live provider execution.
- Updated `apps/desktop/src/components/SettingsModal.tsx`, `apps/desktop/src/components/RightPanel.tsx`, and `apps/desktop/src/App.tsx`:
  - `RightPanel` displays live daemon routines and unread notifications for the active bot and opens Settings directly to the `routines` section (`Manage`).

## 3. Verification Summary

- `corepack pnpm lint`: PASS
- `corepack pnpm -r --if-present typecheck`: PASS (11/11 projects)
- `corepack pnpm -r --if-present build`: PASS
- Full workspace regression (3 consecutive runs):
  - `root`: `98/98` (3/3 runs)
  - `@ghost-bot/teams`: `20/20` (3/3 runs)
  - `@ghost-bot/scheduler`: `17/17` (3/3 runs)
  - `@ghost-bot/computer-use`: `16/16` (3/3 runs)
  - `@ghost-bot/memory`: `14/14` (3/3 runs)
  - `@ghost-bot/knowledge`: `12/12` (3/3 runs)
  - `@ghost-bot/mcp`: `14/14` (3/3 runs)
  - **Total**: `191/191` across 3 consecutive runs.
- Electron E2E & acceptance:
  - `node scripts/verify-phase-5b-scheduler-ipc.mjs`: PASS
  - `node scripts/verify-phase-5c-routines-desktop.mjs`: PASS (light/dark screenshots captured in `design/reviews/phase-5c/routines-light.png` and `design/reviews/phase-5c/routines-dark.png`)
  - `node scripts/verify-phase-4d3-teams-acceptance.mjs`: PASS
  - `node scripts/verify-phase-2e-acceptance.mjs`: PASS (`consoleErrors: 0`)
- MCP concurrency stress (4 parallel workers): `4/4` each, `0` failures.
- Live autonomous inference (`AUTONOMOUS_LIVE_EXECUTION_GATED`) and live Teams execution (`LIVE_TEAMS_GATED`) remain gated.
