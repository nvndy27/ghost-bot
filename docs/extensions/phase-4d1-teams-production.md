# Phase 4D.1 — Production Teams Daemon Integration

**Branch:** `feat/phase-4d1-teams-production`  
**Worktree:** `/home/nguyenduy/Documents/Projects/ghost-bot-phase-4d1`  
**Base Commit:** `b0545f9` (`feat/unified-integration`)

## 1. Production Persistence & Migration `0008_teams_coordination`

- Added migration `8` (`0008_teams_coordination`) in `apps/daemon/src/db/migrations.ts`, preserving `0001`–`0007` untouched.
- Extended existing Phase 1C `teams` (`description`, `owner_id`, `lead_bot_id`, `member_bot_ids_json`, `memory_sharing_policy`, `bounds_json`, `archived_at`, `created_at`, `updated_at`) and synchronized `team_members` without creating duplicate team tables.
- Added `team_runs`, `team_tasks`, `team_task_dependencies`, `team_messages`, and `team_execution_links` (linking `team_run_id`, `team_task_id`, `agent_id`, `session_id`, `daemon_run_id`, `runtime_id`, `account_id`, `attempt`, `role`).
- `@ghost-bot/teams` borrows the single daemon SQLite handle via `createBorrowedTeamDatabaseHandle`.

## 2. `TeamsService` & `TeamsExecutionBridge`

- `TeamsService` (`apps/daemon/src/teams/service.ts`) enforces `LOCAL_USER_ID` as authoritative owner, validates bots via `BotRepository`, syncs `team_members`, and exposes Team CRUD, plan preview, run lifecycle, diagnostics, usage, messages, and `reconcileOnStartup()`.
- `TeamsExecutionBridge` (`apps/daemon/src/teams/execution-bridge.ts`) implements `DaemonTeamBridgeContract` + `TeamTaskDispatcher`, revalidating membership, bot archive status, and `RuntimePolicyBroker` immediately before dispatching child daemon runs through `RunOrchestrator` in isolated per-`(teamRunId, agentId)` sessions.

## 3. Daemon Routes & Typed IPC

- Added strict Zod schemas & `IPC_CHANNELS` in `packages/shared-types/ipc.ts` (`TEAMS_LIST`, `TEAMS_CREATE`, `TEAMS_UPDATE_MEMBERS`, `TEAMS_ARCHIVE`, `TEAMS_PREVIEW_PLAN`, `TEAMS_RUN_START`, `TEAMS_RUN_GET`, `TEAMS_RUN_CANCEL`, `TEAMS_RUN_TASKS`, `TEAMS_RUN_DIAGNOSTICS`, `TEAMS_RUN_USAGE`, `TEAMS_MESSAGES_LIST`).
- Wired authenticated `/teams/*` HTTP routes in `apps/daemon/src/server.ts` and IPC handlers + preload bridge in `apps/desktop/electron/main.ts` and `preload.cts`.

## 4. MCP Timing-Test Fix

- Replaced fixed `150 ms` / `250 ms` sleeps in `packages/mcp/tests/integration/hardening-regression.test.ts` and `packages/mcp/tests/unit/bounded-stdio-transport.test.ts` with deterministic event-driven promises bounded by a `3000 ms` timeout without weakening assertions.

## 5. Remaining Live Limitations

- Live multi-agent Codex inference execution, desktop Teams UI, and Scheduler/Computer Use production wiring remain deferred to subsequent coordinated phases.
