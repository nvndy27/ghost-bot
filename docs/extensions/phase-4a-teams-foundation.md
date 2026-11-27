# Phase 4A — Multi-Agent Teams Foundation (`@ghost-bot/teams`)

**Branch:** `feat/phase-4a-teams-foundation`  
**Worktree:** `/home/nguyenduy/Documents/Projects/ghost-bot-teams`  
**Package:** `@ghost-bot/teams` (`packages/teams/`)  
**Historical Baseline:** `07839ff`

## 1. Approved Scope & Slice Justification

Per `docs/ROADMAP.md` (Phase 4) and `docs/PRD.md`:

- **Chief of Staff & Team/Group Chat:** Multi-bot teams with a designated `leadBotId` (Chief of Staff), explicit `memberBotIds`, and an append-only team/direct message ledger preserving `authorBotId`, `targetBotId`, and `originatingTaskId`.
- **Task Delegation & Parallel Execution:** Hierarchical root and delegated subtasks (`rootTaskId`, `parentTaskId`, `depth`) with idempotency keys (`IDEMPOTENCY_CONFLICT` on mismatched replay) and bounded parallel dispatch via `TeamTaskDispatcher`.
- **Execution Bounds & Aggregate Usage:** Configurable bounds (`maxDepth`, `maxAttempts`, `maxTokens`, `maxDurationMs`, `maxConcurrentTasks`) enforced at creation, delegation, and dispatch boundaries, plus tree-level `getAggregateUsage(rootTaskId, ownerId)`.
- **Stop Propagation & Restart Reconciliation:** `cancelTaskWithPropagation` transitions the target task to `cancelled` and non-terminal descendants to `stopped_by_parent`; `reconcileOnRestart` fails orphaned `running` tasks with `DAEMON_RESTARTED` instead of auto-replaying side effects.

This slice is cleanly decoupled from Phase 3D (`apps/daemon/`, Memory/Knowledge/MCP integration, production migrations, and `pnpm-lock.yaml`) by using `node:sqlite` in an isolated package store and an injectable `TeamTaskDispatcher` interface.

## 2. Package Exports & Modules

- `@ghost-bot/teams/contracts` (`src/contracts/types.ts`): Core records, status union, bounds, aggregate usage, and `TeamTaskDispatcher` / `TeamDispatchContext`.
- `@ghost-bot/teams/security` (`src/security/validation.ts`): `TeamError`, secret redaction (`redactTeamSecrets`), control-character/size validation, bounds validation, and `assertTeamOwner`.
- `@ghost-bot/teams/repository` (`src/repository/sqlite-store.ts`, `src/repository/team-repository.ts`): Hardened SQLite store (`0700` dir, `0600` DB/WAL/SHM, symlink checks, `WAL`, `PRAGMA foreign_keys = ON`, re-entrant `BEGIN IMMEDIATE` transactions) and `TeamRepository`.
- `@ghost-bot/teams/engine` (`src/engine/delegation-engine.ts`): `DelegationEngine`.

## 3. Security Guarantees & Boundaries

1. **No Implicit Memory Sharing:** `TeamRecord.memorySharingPolicy` is fixed to `'explicit-only'`, and `TeamDispatchContext` always sets `noImplicitMemorySharing: true`.
2. **No Permission Escalation or Approval Reuse:** `TeamDispatchContext` always emits `requirePolicyRevalidation: true`, `noPermissionEscalation: true`, and `reusePriorApprovals: false` so the future daemon integration must re-evaluate `RuntimePolicyBroker` per delegated task.
3. **Owner & Membership Isolation:** All reads, writes, delegations, dispatches, and cancellations verify `ownerId` (`SCOPE_FORBIDDEN`) and team membership (`NON_MEMBER_BOT`).
4. **Secret Redaction & Bounded Inputs:** Messages, prompts, and `TeamError` messages pass through `redactTeamSecrets` and byte/character limits.
5. **Fail-Closed Restart Recovery:** In-flight `running` tasks are marked `failed` (`DAEMON_RESTARTED`) on startup rather than re-dispatched automatically.

## 4. Production Integration Handoff (Deferred to Coordinated Integration)

- **Database Migrations:** Coordinate with Phase 3D (`0005`–`0006`+) and Phase 5B scheduler (`0007+`) before adding `teams`, `team_tasks`, and `team_messages` to `apps/daemon` production migrations.
- **Daemon & Policy Integration:** Wire `TeamTaskDispatcher` inside `apps/daemon` to `RuntimePolicyBroker` and the runtime adapter pool, enforcing `requirePolicyRevalidation`, `noPermissionEscalation`, and `reusePriorApprovals: false` at actual execution boundaries.
- **IPC & Desktop UI:** Expose typed IPC contracts for Chief of Staff chat, team management, and task ledger inspection after daemon integration.
