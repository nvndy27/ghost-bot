# Phase 4 — Teams Production Integration Handoff

**Source Package:** `@ghost-bot/teams` (`feat/phase-4a-teams-foundation`)  
**Status:** Independent package acceptance PASS; production integration NOT STARTED.

## 1. Team Execution Wiring (`apps/daemon`)

- **Coordinator Ownership:** `apps/daemon` instantiates `TeamCoordinator` backed by daemon-owned SQLite persistence and `RunOrchestrator`.
- **Injected Interfaces:**
  - `TeamTaskPlanner`: backed by an authorized Chief of Staff runtime turn (`read-only` planning mode, structured JSON schema validation via Zod).
  - `TeamTaskDispatcher`: routes each claimed worker task through `RunOrchestrator` + `RuntimePolicyBroker` as a child daemon `run` linked to `teamRunId` and `taskId`.
  - `TeamResultSynthesizer`: backed by an authorized Chief of Staff synthesis turn treating all worker outputs as untrusted data.
- **Policy Revalidation & Per-Worker Authorization:** Every worker dispatch must pass `RuntimePolicyBroker` independently using `DaemonTeamBridgeContract`, selecting per-worker runtime, account, and canonical workspace without inheriting broader parent permissions or reusing prior approvals (`reusePriorApprovals: false`).
- **Provider Concurrency:** Effective parallelism is `min(team.bounds.maxConcurrentTasks, runtimePoolLimit)`.

## 2. Security Boundaries

- **Daemon-Generated Contexts:** `ownerId`, `senderType`, `authorBotId`, and `teamRunId` are constructed exclusively inside `apps/daemon`, never trusted from renderer IPC or worker output.
- **Explicit Memory & Knowledge Sharing:** `memorySharingPolicy` remains `'explicit-only'`; Phase 3 memory/knowledge/MCP grants are scoped per worker bot and revalidated per task.
- **Approval Correlation & Quarantine:** Approvals correlate `(approvalId, teamRunId, taskId, daemonRunId, argsHash)` as single-use grants. Unconfirmed cancellations or crashes quarantine the child `daemonRunId` and keep the task `'uncertain'` with `reserved_tokens` locked until reconciled.

## 3. Persistence & Schema Compatibility

Existing Phase 1C production migrations (`apps/daemon/src/db/migrations.ts`) already define:
- `teams (id, name, leader_agent_id)`
- `team_members (team_id, agent_id, role)`

**Coordinated Integration Strategy (use the next available production migration number after Phase 3D / Scheduler):**
- **Extend, do not duplicate:** `ALTER TABLE teams` to add `description`, `owner_id`, `memory_sharing_policy`, `bounds_json`, `archived_at`, `created_at`, `updated_at`, and continue using `team_members` as the canonical membership table (avoiding duplicate `member_bot_ids_json`).
- **Add coordination tables:** `team_runs`, `team_tasks`, `team_task_dependencies`, and `team_messages` with foreign keys to `teams(id)` and `agents(id)`.

## 4. Proposed Desktop & IPC Contracts

Typed preload/daemon IPC contracts to add during production integration (not implemented here):
- `teams:list`, `teams:create`, `teams:updateMembers`, `teams:archive`
- `teams:previewPlan` (`TeamPlanPreview`)
- `teams:startRun`, `teams:cancelRun`, `teams:getRun`, `teams:getDiagnostics` (`TeamRunDiagnosticsReport`)
- `teams:listMessages` (enforcing `visibility` and `untrusted` rendering), `teams:postUserMessage`
- `teams:getAggregateResult` (`TeamRunAggregateResult` + usage/recovery/quarantine status)

## 5. Scheduler Integration (`@ghost-bot/scheduler`)

- A future routine target (`targetKind: 'team'`, `teamId`, `goalTemplate`) invokes `TeamCoordinator.startTeamRun` inside `apps/daemon` through `RunOrchestrator` and `RuntimePolicyBroker`.
- No direct scheduler-to-worker or scheduler-to-runtime path is permitted; `@ghost-bot/scheduler` remains unmodified and frozen at `465ec19`.
