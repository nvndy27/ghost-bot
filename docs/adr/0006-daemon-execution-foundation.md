# ADR 0006 — Daemon-Owned Execution, Run State Machine, and Durable Event Replay

Status: Accepted for Phase 2A.

## Context

In Phase 1B–1D, mock chat streaming lived inside React `setInterval` timers in `App.tsx`, without persisted sessions, runs, or ordered event logs. Moving to Phase 2 requires a single daemon-owned execution pipeline that separates bot configuration, session identity, run lifecycle, messages, and normalized events while keeping Phase 2A strictly offline/mock-only (zero live AI inference).

## Decision

1. **Daemon Ownership**: `@ghost-bot/daemon` owns `SessionRepository`, `RunStateMachine`, `RunEventStore`, `DeterministicMockRuntime`, and `RunOrchestrator`. The Electron renderer never runs execution timers or owns run state.
2. **Schema & Migration `0003_execution_foundation`**: Extend `sessions` (`updated_at`, `archived_at`) and `messages` (`seq_order`, `status`, `updated_at`), and add `runs` (`UNIQUE(session_id, idempotency_key)`) and `run_events` (`UNIQUE(run_id, seq)`, `UNIQUE(run_id, event_key)`). All historical foreign keys use `ON DELETE RESTRICT`.
3. **Run State Machine**: Legal lifecycle states are `queued`, `starting`, `running`, `awaiting_approval`, `cancelling`, and terminal states `completed`, `cancelled`, `failed`, `interrupted`. Terminal states are immutable; duplicate terminal events are idempotent; late or out-of-order events cannot reactivate a terminal run.
4. **Concurrency & Idempotency**: At most one non-terminal run per session (`queued`/`starting`/`running`/`awaiting_approval`/`cancelling`). Retrying `runs.start` with the same `(session_id, idempotency_key)` returns the existing run.
5. **Event Durability & Bounded Batching**: Every accepted `run_event` is persisted immediately in a short SQLite transaction (never holding transactions open across async streaming). Assistant `messages` rows are created on run start, updated in bounded batches (every 120ms or 10 deltas), and flushed atomically on terminal transition.
6. **Transport**: Authenticated Unix-socket IPC with cursor-based replay (`afterSeq`) polled only while a run is non-terminal (`120ms` active, idle when terminal).
7. **Crash Recovery**: On daemon startup, any non-terminal run is reconciled conservatively to `interrupted` with a persisted `run.interrupted` event and `interrupted` assistant message status. Pending approvals and prompts are never auto-resumed.

## Consequences

- Switching conversations or restarting Electron preserves exact session, message, tool, approval, and run state.
- Phase 2B can plug `CodexAppServerAdapter` into `RunOrchestrator` behind `RuntimePolicyBroker` without changing UI contracts or SQLite tables.

### Hardening & Concurrency Model (Review Follow-up)
- **Single-daemon ownership**: `GhostBotDaemon.start()` acquires an `O_EXCL` `0600` `daemon.lock` file in `dataDir` (plus process-wide `ACTIVE_DAEMON_LOCKS` tracking) before `reconcileOnStartup()`, preventing a second daemon instance from corrupting or prematurely interrupting live runs.
- **Idempotency conflict detection**: Reusing `(session_id, idempotency_key)` with a different prompt payload returns `409 IDEMPOTENCY_CONFLICT` rather than silently returning the earlier run.
- **Active-run archival guard**: `BotRepository.deleteBot()` rejects soft-archival with `409 ACTIVE_RUN_EXISTS` while any run for that bot is non-terminal.
- **Event transport**: Renderer polling uses self-scheduling `120ms` `setTimeout` after `pollOnce()` completes (with pagination draining), preventing overlapping in-flight IPC requests. Phase 2B can keep cursor polling or add an optional push wake-up without altering persistence invariants.
