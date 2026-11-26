# Phase 5A.3 — Routine Diagnostics, Export/Import & Dry-Run Engine

Branch: `feat/phase-5a-scheduler-foundation` (worktree `ghost-bot-automation`)  
Package: `@ghost-bot/scheduler` (`packages/scheduler/`)

## 1. Confirmed Phase 5A.2 Findings & Fixes
- **Durable deduplication across history pruning**: Added `scheduler_occurrence_dedup` in migration `0003_scheduler_phase5a3` (`sqlite-store.ts`). `pruneCompletedHistory()` deletes terminal `scheduler_tasks` rows only, preserving `scheduler_occurrence_dedup` so pruned occurrences cannot be re-enqueued; `pruneExpiredDedup()` cleans only explicitly expired keys.
- **Dispatch-boundary revision revalidation**: `SchedulerEngine.dispatchNext()` revalidates the routine's `enabled`, `archivedAt`, `ownership`, and `revision` immediately before calling `dispatcher.dispatch()`, failing stale tasks with `STALE_ROUTINE_REVISION` / `ROUTINE_UNAVAILABLE` without executing them.
- **Manual idempotency conflict detection**: `enqueueOccurrence()` stores `payload_hash` (`sha256` of `{ routineRevision, trigger, timezone, task }`) and throws `IDEMPOTENCY_CONFLICT` if a manual `idempotencyKey` is reused after the routine changes.
- **Event provenance**: `trustedSource` is an identifier only; production daemon integration must establish event provenance before calling `ingestSyntheticEvent()`.
- **Non-leap century `2100`**: Verified `0 12 29 2 *` across `2100` returns `null` within `MAX_CRON_SEARCH_DAYS = 1466`, while Vixie-cron `0 0 30 2 1` remains valid when DOW is restricted.

## 2. Schedule Preview, Diagnostics & Statistics
- **Schedule Preview (`src/diagnostics/preview.ts`)**: Pure, read-only `previewRoutineSchedule()` returning `scheduledAtUtc`, `localDateTime`, `timezone`, `routineRevision`, `dstTransitionNote`, `truncatedByExpiration`, and `truncatedByHorizon` (`count <= 25`, `event` triggers return `status: 'event_driven'` with `[]`).
- **Routine Diagnostics (`src/diagnostics/diagnostics.ts`)**: Read-only, scope-aware `diagnoseRoutine()` emitting machine-readable reason codes (`ELIGIBLE`, `NOT_YET_DUE`, `DISABLED`, `ARCHIVED`, `EXPIRED`, `EXTERNALLY_MANAGED`, `BLOCKED_BY_CONCURRENCY`, `BLOCKED_BY_QUEUE_CAPACITY`, `HAS_UNCERTAIN_EXECUTION`, `STALE_TASK_REVISION`, `AWAITING_EXECUTION_AUTHORIZATION`, `EVENT_DRIVEN_ONLY`) and explicitly noting that eligibility never grants daemon execution authority.
- **Execution Statistics (`src/diagnostics/statistics.ts`)**: `getRoutineStatistics()` aggregates counts, `successRate` (`completed / (completed + failed + cancelled + interrupted)`, or `null` when `0`), `averageDurationMs` (from tasks with both `startedAt` and `endedAt`), and notes retention boundaries without fabricating token/cost/quota data.

## 3. Dry-Run Simulator & Portable Export/Import
- **Dry-Run Simulator (`src/simulator/dry-run.ts`)**: `runDryRunSimulation()` runs in an isolated temporary SQLite store (`MAX_SIM_ROUTINES = 20`, `MAX_SIM_TICKS = 100`, `MAX_SIM_OCCURRENCES = 200`, `MAX_SIM_WINDOW_MS = 30d`), never mutating source data or calling external runtimes.
- **Export/Import (`src/portability/export-import.ts`)**: Versioned `ghost-bot.scheduler.routines.v1` (`schemaVersion: 1`, `MAX_IMPORT_BYTES = 256 KB`, `MAX_IMPORT_ROUTINES = 50`). Rejects unknown fields, credentials (`CREDENTIAL_EXPOSURE_BLOCKED`), `full-access` hints, and external ownership; imports disabled-by-default (`enabled: false`), remaps IDs, binds strictly to `receivingScope`, and commits transactionally under `skip | rename | overwrite`.
