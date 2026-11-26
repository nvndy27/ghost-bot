# Phase 5A.4 — Routine Notifications, Approval Contracts & Final Scheduler Acceptance

Branch: `feat/phase-5a-scheduler-foundation` (worktree `ghost-bot-automation`)  
Package: `@ghost-bot/scheduler` (`packages/scheduler/`)  
Verdict: **PASS** (independent scheduler foundation frozen at Phase 5A acceptance gate)

## 1. Cumulative Phase 5A.1–5A.4 Capability Summary
- **5A.1 Foundation**: Typed contracts, `one-time`/`interval`/`daily`/`weekly` scheduling with `Intl.DateTimeFormat` + DST handling, isolated `node:sqlite` repository (`0700`/`0600`), durable execution queue, concurrency/lease/restart reconciliation, and strict security bounds.
- **5A.2 Advanced Scheduling**: Re-entrant `txDepth` atomic `tick()`, schema versioning (`0001`–`0002`), bounded 5-field cron parser/calculator (`MAX_CRON_SEARCH_DAYS = 1466`), manual trigger & synthetic event matching, routine revisions, and `ghost-bot` vs `openclaw` ownership exclusion.
- **5A.3 Diagnostics & Portability**: Durable `scheduler_occurrence_dedup` (`0003`), dispatch-boundary revision revalidation, manual `IDEMPOTENCY_CONFLICT`, pure schedule preview, read-only diagnostics, execution statistics, isolated dry-run simulator, and `ghost-bot.scheduler.routines.v1` export/import.
- **5A.4 Notifications & Approval Coordination**: Durable `dedup_watermark_at` advancement (`0004`), `unknown` dispatcher outcome handling (`uncertainExecution = true`), import overwrite active/uncertain guard, `NotificationRepository` (`scheduler_notifications`), `NotificationPolicy` (overnight quiet hours, timezone/DST, rate limits, critical in-app visibility), and `RoutineApprovalCoordinator`.

## 2. Security Guarantees & Remaining Limitations
- Routine prompts, metadata, event payloads, and imports are untrusted data and never grant runtime/tool permissions.
- `SchedulerEngine` and `RoutineApprovalCoordinator` never invoke Codex, OpenClaw, MCP, shell, network, or external notification channels.
- Credential-pattern detection on export/import is defense-in-depth and cannot guarantee arbitrary natural-language prompts contain no secrets; explicit user export selection and import preview remain required.
- Deduplication storage is bounded; after explicit `pruneExpiredDedup()`, `dedup_watermark_at` prevents stale schedule/event replay (`STALE_OCCURRENCE_BEFORE_WATERMARK`). Unlimited exactly-once execution across arbitrary external failures is not claimed.
