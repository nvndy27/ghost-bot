# Phase 4D.3: Final Teams Production Acceptance

- **Branch**: `feat/phase-4d3-teams-acceptance`
- **Base Checkpoint**: `1047f03` (`feat/phase-4d2-teams-desktop`)
- **Migrations**: `0001–0008` preserved (no forward migration required)
- **Verdict**: **PASS (Offline Teams Production Acceptance)** — Live multi-agent execution remains gated by `LIVE_TEAMS_GATED`

## 1. Confirmed Findings and Fixes
1. **Crash-Window Link Recovery (`apps/daemon/src/teams/service.ts`)**:
   - `TeamsService.reconcileOnStartup()` now scans `runs` for `idempotency_key LIKE 'team:%:attempt:%'` joined with `sessions` (`title LIKE 'team:%'`) that lack a corresponding `team_execution_links` row (if a crash occurs between `orchestrator.startRun()` and link insertion), deterministically inserts the missing `team_execution_links` row when the `(teamTaskId, teamRunId)` exists, and then executes `TeamCoordinator.reconcileOnRestart()` idempotently.
2. **Awaiting-Approval Cancellation Exit (`apps/daemon/src/teams/execution-bridge.ts`)**:
   - Inside `TeamsExecutionBridge.dispatch()`, when a child run is `awaiting_approval`, the poll loop now checks `team_runs.status` and immediately cancels the child daemon run (`orchestrator.cancelRun(run.id)`) and returns `TEAM_RUN_CANCELLED` if the parent team run entered `cancelling` or `cancelled`.
3. **Stale Approval Card Prevention (`apps/desktop/src/App.tsx`)**:
   - Added `clearTeamWorkspaceState()` invoked synchronously in `handleSelectTeam()` and `handleSelectBot()`, incrementing `teamRequestSeqRef` and clearing `teamRuns`, `activeTeamRun`, `teamTasks`, `teamApprovals`, `teamMessages`, `teamDiagnostics`, and `teamAggregateUsage` so switching teams never displays stale approval cards from a previous team.

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
  - `root`: **90/90**
  - `@ghost-bot/teams`: **20/20**
  - `@ghost-bot/scheduler`: **17/17**
  - `@ghost-bot/computer-use`: **16/16**
  - `@ghost-bot/memory`: **14/14**
  - `@ghost-bot/knowledge`: **12/12**
  - `@ghost-bot/mcp`: **14/14**
  - **Total**: **183/183** across 3 consecutive runs.

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
