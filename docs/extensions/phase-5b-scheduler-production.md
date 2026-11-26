# Phase 5B: Production Scheduler & Routines Daemon Integration

- **Branch**: `feat/phase-5b-scheduler-production`
- **Ancestry**: Includes accepted Teams hardening `f5dc1e9` (`ANCESTOR_OK`), preserving all Teams F1–F5 & P3 invariants
- **Production Migrations**: `0001–0009` preserved unchanged; added `0010_scheduler_routines`
- **Verdict**: **PASS (Offline Scheduler Production Integration)** — Live autonomous inference and live Teams execution remain gated

## 1. Pre-Integration Findings and Fixes
1. **Deduplication Watermark Semantics (`packages/scheduler/src/queue/execution-queue.ts`, `sqlite-store.ts`)**:
   - Added `scheduled_for TEXT` to `scheduler_occurrence_dedup` and updated `pruneExpiredDedup()` to advance `dedup_watermark_at` using `MAX(COALESCE(scheduled_for, created_at))` **only** for `trigger_source IN ('schedule', 'event')` (never `manual` keys).
2. **Concurrent Tick Guard & Re-entrant Borrowed Transactions (`scheduler-engine.ts`, `sqlite-store.ts`)**:
   - Added single-flight `tickInProgress` guard in `SchedulerEngine.tick()`.
   - Added re-entrant `txDepth` wrapper to `createBorrowedSchedulerDatabaseHandle()` so nested `SchedulerEngine` + `ExecutionQueue` transactions compose safely on the daemon SQLite handle.
3. **Authoritative Execution-Link Recovery (`apps/daemon/src/teams/service.ts`, `apps/daemon/src/scheduler/execution-bridge.ts`)**:
   - Hardened both `TeamsService.reconcileOnStartup()` and `DaemonRoutineDispatcher.recoverMissingExecutionLinks()` to validate authoritative task, routine/team, session, agent, active status, creation timestamp, and exact `attempt` relationships so user-created sessions/runs cannot spoof team or routine execution links via string prefixes.

## 2. Production Migration `0010_scheduler_routines`
- Added forward migration `0010_scheduler_routines` (`apps/daemon/src/db/migrations.ts`) creating `scheduler_routines`, `scheduler_tasks`, `scheduler_occurrence_dedup`, `scheduler_notifications`, `scheduler_execution_links`, and `scheduler_approval_links` with foreign keys to `agents(id)`, `teams(id)`, `sessions(id)`, `runs(id)`, `team_runs(id)`, and `approvals(id)`.
- Verified actual `v9 -> v10` upgrade, legacy bot/team preservation, foreign-key integrity (`PRAGMA foreign_key_check`), and idempotent migration reruns (`runMigrations() === 0`).

## 3. SchedulerService, Timer Lifecycle & Execution Bridge
- **`SchedulerService` (`apps/daemon/src/scheduler/service.ts`)**:
  - Daemon-owned routine CRUD, enable/disable/archive, manual trigger, schedule preview, diagnostics, dry-run simulation, import preview/commit, export, execution statistics, task history, notification management, and startup reconciliation (`reconcileOnStartup()`).
  - Bounded `setInterval` timer (`startTimer()`, `stopTimer()`) with single-flight `cycleInFlight` guard, injectable `Clock`, clock rollback protection, clean shutdown (zero dispatch after shutdown begins), and exclusion of `ownership !== 'ghost-bot'` (OpenClaw) routines.
- **`DaemonRoutineDispatcher` (`apps/daemon/src/scheduler/execution-bridge.ts`)**:
  - Routes `targetType: 'bot'` through `RunOrchestrator.startRun()` and `targetType: 'team'` through `TeamsService.startTeamRun()` + `TeamsExecutionBridge`.
  - Fails closed with `AUTONOMOUS_LIVE_EXECUTION_GATED` / `LIVE_TEAMS_GATED` outside `mock` mode and `AUTONOMOUS_FULL_ACCESS_DENIED` on `full-access` bots.
  - Binds pending daemon approvals via `RoutineApprovalCoordinator.bindApprovalRequest()` and `scheduler_approval_links` without creating reusable grants or replaying prompts.

## 4. Verification Results
- **Lint, Typecheck & Build**: `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build` — **PASS**.
- **3 Consecutive Full Regression Runs** (`0` failures, `0` skipped across all 3 runs):
  - `root`: **96/96** (includes all Teams F1–F5 regressions + 5 new Phase 5B tests)
  - `@ghost-bot/teams`: **20/20**
  - `@ghost-bot/scheduler`: **17/17**
  - `@ghost-bot/computer-use`: **16/16**
  - `@ghost-bot/memory`: **14/14**
  - `@ghost-bot/knowledge`: **12/12**
  - `@ghost-bot/mcp`: **14/14**
  - **Total**: **189/189** across 3 consecutive runs.
- **Offline Electron IPC Verification**: `node scripts/verify-phase-5b-scheduler-ipc.mjs` — **PASS**.
- **Teams Acceptance Electron E2E**: `node scripts/verify-phase-4d3-teams-acceptance.mjs` — **PASS**.
- **Single-Bot Electron Smoke**: `node scripts/verify-phase-2e-acceptance.mjs` — **PASS** (`consoleErrors: 0`, `daemonExitedCleanly: true`).
- **MCP Concurrency Stress Test**: 4 parallel workers running `bounded-stdio-transport.test.ts` + `hardening-regression.test.ts` — **PASS** (`4/4` each).

## 5. Remaining Limitations & Next Scope
- **Live Autonomous Execution**: Disabled (`AUTONOMOUS_LIVE_EXECUTION_GATED` / `LIVE_TEAMS_GATED`) outside `mock` mode; no live inference or paid API quota is consumed.
- **Next (Phase 5C)**: Routines Desktop UI (Settings Routines management, `RightPanel` routine/notification surfaces, and approval/uncertainty badges) without weakening daemon authorization boundaries.
