# Phase 4B — Chief of Staff & Multi-Agent Coordination

**Branch:** `feat/phase-4a-teams-foundation`  
**Worktree:** `/home/nguyenduy/Documents/Projects/ghost-bot-teams`  
**Package:** `@ghost-bot/teams` (`packages/teams/`)  
**Historical Baseline:** `07839ff` (Phase 4A HEAD: `1ab25bc`)

## 1. Confirmed Phase 4A Findings & Hardening Fixes

1. **TOCTOU Budget Reservation Defect:** Phase 4A `delegateSubtask` and `runReadyTasksParallel` only checked `tokens_used` after dispatch rather than reserving budget before parallel dispatch. Fixed by tracking `reserved_tokens` and `reserved_duration_ms` atomically inside the `BEGIN IMMEDIATE` claim transaction and accounting for `tokens_used + reserved_tokens` across the `root_task_id` tree.
2. **Uncertain Outcome / Dispatcher Exception Handling:** Phase 4A marked dispatcher exceptions and restart-interrupted tasks as `failed` and did not distinguish unconfirmed external stops. Fixed by introducing `'uncertain'` (`termination_confirmed = 0`) and keeping `reserved_tokens` / `reserved_duration_ms` locked on uncertain tasks so uncontrolled additional dispatches cannot occur.
3. **Active Membership Re-validation:** `runReadyTasksParallel` now re-checks `team.memberBotIds` inside the claim transaction and cancels queued tasks assigned to removed members (`MEMBER_REMOVED`).
4. **Late Callback Guard:** Outcome persistence now requires `latest.status === 'running' && latest.attempt === task.attempt`, preventing late callbacks from reopening terminal or cancelled tasks.
5. **Versioned SQLite Migrations:** Replaced unconditional DDL in `sqlite-store.ts` with a versioned migration runner (`0001_teams_foundation` -> `0002_team_coordination`) verified against existing Phase 4A v1 databases.

## 2. Chief of Staff Coordination Architecture

`TeamCoordinator` (`src/engine/team-coordinator.ts`) orchestrates multi-agent runs on top of `TeamRepository` and `DelegationEngine` (single execution authority, no duplicate runner):

- **Injected Planning & Synthesis:** Uses `TeamTaskPlanner` for structured DAG planning and `TeamResultSynthesizer` for final response synthesis without connecting to any live LLM.
- **Run Lifecycle:** `startTeamRun` -> `executeTeamRunStep` / `runTeamRunToCompletion` -> `collectAggregateResult` -> `synthesizeFinalResponse` (or `cancelTeamRun`).
- **Idempotency:** `team_runs` enforces `UNIQUE(team_id, idempotency_key)` with `goal_hash` conflict detection (`IDEMPOTENCY_CONFLICT`).

## 3. Task Dependency Graph & Parallel Execution

`validateTaskPlan` (`src/security/validation.ts`) validates plans before persistence:

- Rejects empty plans, `PLAN_TOO_LARGE` (`tasks.length + 1 > maxTasksPerRun`), `DUPLICATE_PLAN_KEY`, `NON_MEMBER_BOT`, `SELF_DEPENDENCY`, `MISSING_DEPENDENCY`, `CIRCULAR_DEPENDENCY` (3-color DFS), and `MAX_DEPTH_EXCEEDED`.
- `DelegationEngine.runReadyTasksParallel` enforces `team_task_dependencies`: tasks with pending prerequisites wait; tasks whose prerequisites ended in `failed`, `cancelled`, `budget_exhausted`, `stopped_by_parent`, `blocked`, or `uncertain` transition to `blocked` (`PREREQUISITE_FAILED`).

## 4. Budget Enforcement

`TeamExecutionBounds` now enforces:
- `maxDepth`, `maxAttempts`, `maxTokens`, `maxDurationMs`, `maxConcurrentTasks`
- `maxTasksPerRun` (default `25`, `1..100`)
- `maxMessages` (default `200`, `1..2000`)
- `maxResultBytes` (default `65536`, `1024..524288`)

Token counts remain strictly separate from provider quotas/monetary costs; omitted dispatcher usage is recorded as `usageReported: false` and listed in `unavailableUsageTaskIds` rather than fabricated.

## 5. Inter-Agent & Group Conversation Boundaries

`TeamMessageRecord` supports `teamRunId`, `conversationId`, `senderType`, `messageType`, `visibility` (`'team' | 'direct' | 'user_and_cos'`), and `untrusted` (`true` for all worker messages). `listMessages` enforces visibility filtering so workers cannot read another bot's private direct messages or private session history, while `memorySharingPolicy` remains `'explicit-only'`.

## 6. Result Aggregation, Cancellation & Recovery

- `collectAggregateResult` deterministically aggregates completed, failed, cancelled, blocked, and uncertain tasks, provenance, actual usage, `unavailableUsageTaskIds`, and bounds output to `maxResultBytes`.
- `cancelTeamRun` and `cancelTaskWithPropagationAsync` stop queued/blocked work (`terminationConfirmed: true`), request cancellation of active executions via `dispatcher.cancelExecution`, mark unconfirmed terminations `'uncertain'`, and preserve committed results.
- `reconcileOnRestart` marks active tasks and runs as `'uncertain'` (`DAEMON_RESTARTED`) without auto-replaying side effects.

## 7. Future Daemon Integration Contracts

`src/contracts/daemon-integration.ts` defines narrow typed interfaces (`DaemonPolicyRevalidationRequest`, `DaemonRuntimeSelection`, `DaemonWorkspaceGrant`, `DaemonTeamRunMapping`, `DaemonApprovalCorrelation`, `DaemonCancellationAck`, `DaemonResultStreamEvent`, `DaemonUsageReport`, `DaemonExecutionQuarantineEntry`, `DaemonTeamBridgeContract`) for future Phase 4C+ `apps/daemon` integration.
