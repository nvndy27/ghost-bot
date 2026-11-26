# Phase 5B — Daemon Scheduler Integration Handoff

Target Integration Baseline: Coordinated after Phase 3D completion on `main` (Phase 3D.1 `0ae82ed` / `0005_memory_core`, Phase 3D.2 `0006_knowledge_core` informational).  
Source Package: `@ghost-bot/scheduler` (`feat/phase-5a-scheduler-foundation`)

## 1. Persistence & Migration Planning
- **Independent Scheduler Migrations**: `0001_scheduler_foundation` through `0004_scheduler_phase5a4` (`scheduler_schema_migrations`).
- **Production Integration**: Add `scheduler_routines`, `scheduler_tasks`, `scheduler_occurrence_dedup`, and `scheduler_notifications` in the next available `@ghost-bot/daemon` migration (`0007+` or next sequential after Phase 3D) with foreign keys to `agents(id)`. Do not reserve a hardcoded number before Phase 3D merges.
- **Retention**: `pruneCompletedHistory()` deletes terminal `scheduler_tasks` without deleting `scheduler_occurrence_dedup`; `pruneExpiredDedup()` advances `dedup_watermark_at`.

## 2. Daemon Service & Authorization Ownership
- **Timer & Clock**: `@ghost-bot/daemon` owns the bounded periodic `SchedulerEngine.tick()` loop and `Clock`.
- **Execution Bridge (`FutureRoutineDispatcher`)**: Must revalidate current owner, bot, account, workspace, `RuntimePolicyBroker`, and `RunOrchestrator.startRun()` on every dispatch. Never hold SQLite transactions across async `dispatch()`.
- **Approval Coordination**: Bind `RunOrchestrator` approval requests via `RoutineApprovalCoordinator.bindApprovalRequest()` and feed `denied`/`expired`/`revoked`/`provider_delivery_unknown`/`approved_for_continuation` via `applyApprovalEvent()` on the SAME `taskId` and `daemonRunId` without replaying prompts.
- **OpenClaw Exclusion**: Keep `ownership !== 'ghost-bot'` excluded from `tick()`, `triggerManual()`, and `ingestSyntheticEvent()`.

## 3. Proposed IPC & Desktop UI Contracts
- Typed Zod IPC channels in `packages/shared-types/ipc.ts` (daemon-validated): `ghost:routines:list|create|update|enable|disable|archive|delete|trigger|preview|diagnose|simulate|export|import-preview|import-commit|stats` and `ghost:routine-notifications:list|unread-count|mark-read|dismiss`.
- Desktop UI (`SettingsModal.tsx` Routines section & `RightPanel.tsx`) renders diagnostics, previews, and notifications without storing credentials or bypassing daemon policy.
