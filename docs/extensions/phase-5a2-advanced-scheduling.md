# Phase 5A.2 — Advanced Scheduling, Cron & Trigger Validation

Branch: `feat/phase-5a-scheduler-foundation` (worktree `ghost-bot-automation`)  
Package: `@ghost-bot/scheduler` (`packages/scheduler/`)

## 1. Confirmed Phase 5A.1 Findings & Fixes
- **Atomic `tick()` enqueue + cursor advancement**: `SchedulerEngine.tick()` now wraps `enqueueOccurrence` and `updateScheduleCursor` in a single `db.transaction()` (with re-entrant `txDepth` support in `sqlite-store.ts`), so queue capacity errors roll back schedule cursor updates.
- **Schema versioning & WAL/SHM permissions**: Added `scheduler_schema_migrations` (`0001_scheduler_foundation`, `0002_scheduler_phase5a2`) and enforced `0600` permissions on `-wal`/`-shm` files.
- **Queue retention & routine revisions**: Added `pruneCompletedHistory({ olderThanIso })` (never deleting active or `uncertainExecution = true` tasks) and `revision` tracking (`claimNext()` cancels stale-revision, disabled, archived, or externally owned queued tasks instead of executing obsolete definitions).

## 2. Cron Syntax, Semantics & Search Bounds
- **Dialect**: Standard 5-field cron (`minute hour dayOfMonth month dayOfWeek`). Supports `*`, lists, ranges, steps, month aliases (`JAN`–`DEC`), weekday aliases (`SUN`–`SAT`), and Sunday `0`/`7` normalization to `0`.
- **Rejected syntax**: Rejects 6/7-field expressions, `@macros`, `L`, `W`, `#`, `?`, and impossible calendar dates (`Feb 30`, `Apr 31`, etc.) with `SchedulerError('INVALID_CRON')`.
- **DOM/DOW semantics**: When both `dayOfMonth` and `dayOfWeek` are restricted (neither `*`), matches on `domMatch || dowMatch`; otherwise `domMatch && dowMatch`.
- **Timezone & DST**: Evaluates wall-clock times in the routine's IANA timezone via `Intl.DateTimeFormat`. Skipped spring-forward hours return `null` and advance cleanly; repeated fall-back hours resolve to the earlier instant and never fire twice.
- **Search bound**: Day-by-day bounded search up to `MAX_CRON_SEARCH_DAYS = 1466` (4 years + leap margin), avoiding minute-by-minute scans.

## 3. Manual, Event & OpenClaw Ownership Boundaries
- **Manual triggers (`triggerManual`)**: Require explicit `{ routineId, scope, idempotencyKey }`, validate `enabled`, `!archivedAt`, `!expired`, `ownership === 'ghost-bot'`, queue capacity, and `routineRevision`.
- **Event triggers (`ingestSyntheticEvent`)**: Validate flat `SyntheticEventEnvelope` (`<= 24` keys, `<= 4 KB`, no control chars), match only explicit operators (`eq`, `neq`, `prefix`, `contains`, `in` — no `eval`, `Function`, regex, or shell), and deduplicate by `(routineId, trustedSource, eventId)`.
- **OpenClaw ownership**: Only `ownership === 'ghost-bot'` routines are evaluated or dispatched; `openclaw` and `external-unknown` routines are excluded to prevent double-scheduling.

## 4. Future Daemon Integration Requirements
- Wire `FutureRoutineDispatcher` inside `@ghost-bot/daemon` (`RunOrchestrator` + `RuntimePolicyBroker`) without holding SQLite locks across async dispatch; add production migrations (`0005+`), `ghost:routines:*` IPC, and webhook/FS auth in Phase 5B/5C.
