# Phase 4D.3: Final Teams Production Acceptance

- **Branch**: `feat/phase-4d3-teams-acceptance`
- **Base Checkpoint**: `1047f03` (`feat/phase-4d2-teams-desktop`)
- **Migrations**: `0001–0008` preserved unchanged; forward migration `0009_teams_legacy_leader_fix` added for F4
- **Verdict**: **PASS (Offline Teams Production Acceptance)** — Live multi-agent execution remains gated by `LIVE_TEAMS_GATED`

## 1. Confirmed Findings and Fixes
1. **F1 — In-Flight Cancellation & Timeout Cancellation (`apps/daemon/src/teams/execution-bridge.ts`)**:
   - Added `inFlightDispatches` tracking keyed by `${taskId}:${attempt}` plus pre/post-`startRun` parent cancellation checks so `cancelExecution()` never returns `confirmed: true` while child-run creation is in flight (returns `confirmed: false`). On `DISPATCH_TIMEOUT`, `orchestrator.cancelRun(run.id)` is invoked and the task preserves `{ status: 'uncertain', code: 'DISPATCH_TIMEOUT' }`.
2. **F2 — Planner & Synthesizer Callback Gating (`apps/daemon/src/teams/service.ts`)**:
   - Default `startTeamRun` planning is deterministic structural DAG construction (zero LLM inference); custom `planner` and `synthesizer` callbacks are explicitly rejected with `LIVE_TEAMS_GATED` outside `mock` mode.
3. **F3 — Strict Teams IPC Contracts & Payload Bounds (`packages/shared-types/ipc.ts`, `apps/desktop/electron/main.ts`)**:
   - Replaced all `LooseRecordSchema` usages on Teams IPC handlers with strict DTO schemas (`TeamPlanPreviewDtoSchema`, `TeamRunDtoSchema`, `TeamTaskDtoSchema`, `TeamStartRunResponseDtoSchema`, `TeamDiagnosticsDtoSchema`, `TeamAggregateUsageDtoSchema`, `TeamRunApprovalDtoSchema`, `TeamMessageDtoSchema`) and added `assertBoundedTeamsIpcPayload()` pre-validation bounds (<= 256 KB, depth <= 12, array <= 200, keys <= 64).
4. **F4 — Legacy NULL Leader Migration & `viewerBotId` Authorization (`apps/daemon/src/db/migrations.ts`, `apps/daemon/src/teams/service.ts`)**:
   - Added forward migration `0009_teams_legacy_leader_fix` (preserving `0001–0008`) to safely repair or archive legacy teams with empty/missing `lead_bot_id` while preserving historical records. `TeamsService.listMessages` enforces non-archived `viewerBotId` existence and maps `NON_MEMBER_BOT` to HTTP `403`.
5. **F5 — Shared Wall-Clock Deadline (`packages/teams/src/engine/delegation-engine.ts`)**:
   - Enforced `team.bounds.maxDurationMs` as a shared wall-clock deadline from `team_runs.created_at` alongside per-task `durationBudgetMs` (`reserveDuration = Math.min(taskRemainingDuration, sharedWallClockRemaining)`), bounding `ctx.remainingDurationMs` to `task.durationReservedMs`.
6. **P3 — Phase 2E Reference Screenshots Restored**:
   - Restored `design/reviews/phase-2e/` from `b0545f9` unchanged.
7. **Crash-Window Link Recovery & Stale UI State**:
   - `TeamsService.reconcileOnStartup()` recovers crash-window `team_execution_links` orphans with authoritative task/team/session/agent/attempt validation, and `App.tsx` clears team workspace state synchronously on team/bot switch.

## 2. Authorization, Budgets, and Isolation Evidence
- **Authoritative Path**: Planner preflight (`TeamsService.startTeamRun`), worker dispatch (`TeamsExecutionBridge.dispatch` -> `RunOrchestrator.startRun`), and policy checks (`revalidateWorkerPolicy` / `RuntimePolicyBroker`) all execute inside `@ghost-bot/daemon`; renderer has no direct provider path.
- **Bounds & Usage Separation**: Tree-wide `maxDepth`, `maxAttempts`, `maxTokens`, `maxDurationMs`, `maxConcurrentTasks`, and `maxTasksPerRun` are validated at Zod IPC and daemon boundaries. `TeamRightPanel` separates estimated budget caps from actual reported usage and unknown usage counts without treating estimated token reservations as hard provider-enforced limits.
- **Worker & Cross-Team Isolation**: `dispatch` revalidates non-archived team status, current `member_bot_ids_json` membership (`MEMBER_REMOVED`), and non-archived bot existence (`BOT_NOT_FOUND`). `memorySharingPolicy` is locked to `'explicit-only'`, and `listMessages(teamId)` enforces team-scoped isolation.

## 3. Approval Lifecycle & Crash Recovery Evidence
- Verified in `tests/phase-4d3-teams-acceptance.test.ts` (3/3 pass):
  - `approve_once` (`approved`) and `deny` (`denied`) bound to exact `runId`, `approvalId`, and `argsHash`; duplicate submissions and expired approvals fail closed (`INVALID_RUN_TRANSITION` / `APPROVAL_EXPIRED`).
  - No reusable or team-wide permission grants exist.
  - Crash-window `team_execution_links` recovery (`recoveredLinks === 1`), `uncertain` marking on restart, and idempotent repeated `reconcileOnStartup()` (0 additional mutations on second call, no auto-replay).

## 4. Electron E2E & Regression Results
- **Teams Acceptance Electron E2E**: `node scripts/verify-phase-4d3-teams-acceptance.mjs` — **PASS** (team create, DAG preview, multi-worker run completion, light/dark screenshots in `design/reviews/phase-4d3/`, active run stop + uncertain-termination banner, single-bot chat switch, Electron restart persistence with exact 2 runs and no auto-replay).
- **Single-Bot Electron Smoke**: `node scripts/verify-phase-2e-acceptance.mjs` — **PASS** (`dailyUseUx: "passed"`, `consoleErrors: 0`, `daemonExitedCleanly: true`).
- **MCP Concurrent Stress Test**: 4 parallel workers running `bounded-stdio-transport.test.ts` + `hardening-regression.test.ts` — **PASS** (`4/4` each, 0 failures).
- **Lint, Typecheck & Build**: `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build` — **PASS**.
- **3 Consecutive Full Regression Runs** (`0 fail`, `0 skipped` across all 3 runs):
  - `root`: **91/91**
  - `@ghost-bot/teams`: **20/20**
  - `@ghost-bot/scheduler`: **17/17**
  - `@ghost-bot/computer-use`: **16/16**
  - `@ghost-bot/memory`: **14/14**
  - `@ghost-bot/knowledge`: **12/12**
  - `@ghost-bot/mcp`: **14/14**
  - **Total**: **184/184** across 3 consecutive runs.

## 5. Live Teams Readiness (`LIVE_TEAMS_GATED`)
Live multi-agent Teams execution remains **disabled** (`LIVE_TEAMS_GATED` in `TeamsExecutionBridge.revalidateWorkerPolicy` whenever `runtimeMode !== 'mock'`). Before enabling live Codex multi-agent execution under explicit user authorization, the following requirements must be implemented and live-verified:
1. **Planner Output Validation**: Strict schema, cycle, depth, and member-allowlist validation on LLM-generated DAG plans before any reservation or dispatch.
2. **Per-Worker Runtime Authorization**: `RuntimePolicyBroker.authorize()` per worker with verified Codex version, `chatgpt` subscription auth, and canonicalized per-worker workspace containment.
3. **Runtime Thread Concurrency**: Bounded parallel Codex App Server child-thread/client lifecycle management without cross-worker thread or event bleed.
4. **Usage Accounting**: Authoritative provider token/duration reconciliation distinguishing reported usage from unknown/interrupted usage.
5. **Approval Correlation**: End-to-end correlation of concurrent server-initiated `requestApproval` items across multiple active worker `daemon_run_id`s to worker-specific UI cards.
6. **Cancellation Acknowledgement**: Confirmed runtime child-turn interruption (`turn/interrupt` / process exit) before clearing `uncertain` quarantine.
7. **Maximum Inference-Attempt Budget**: Hard cap on total live planner + worker + retry + synthesizer inference attempts per team run.

## 6. Recommended Phase 5B Scheduler Integration Scope
- Wire `@ghost-bot/scheduler` into `@ghost-bot/daemon` (`SchedulerService`, SQLite migration `0009`, typed IPC channels, and desktop Scheduler UI) using the same daemon-owned authorization, `RuntimePolicyBroker` boundary, single-use approvals, and restart-reconciliation patterns verified in Phase 4D.1–4D.3.
