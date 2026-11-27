# Phase 5A.1 — Independent Scheduler & Routines Foundation

Branch: `feat/phase-5a-scheduler-foundation` (worktree `ghost-bot-automation`, from `main` `07839ff`)  
Package: `@ghost-bot/scheduler` (`packages/scheduler/`)

## 1. Architecture & Contracts
- **`src/contracts/types.ts`**: Defines `RoutineRecord`, `TriggerConfig` (`one-time`, `interval`, `daily`, `weekly`), `MissedRunPolicy` (`skip`, `run-once`, `bounded-catch-up`), `ConcurrencyPolicy` (`forbid`, `allow-bounded`), `RetryPolicy` (`retryNonIdempotent: false`), `RoutineTaskDefinition` (untrusted data), `ScheduledTaskRecord`, `FutureExecutionAuthorizationContext`, and `FutureRoutineDispatcher`.
- **`src/security/validation.ts`**: Enforces bounds (`MAX_PROMPT_BYTES = 16KB`, `MAX_METADATA_BYTES = 4KB`, `MAX_CATCHUP_RUNS = 10`, `MAX_CONCURRENT_RUNS = 5`, `DEFAULT_QUEUE_CAPACITY = 1000`), control-character/NUL rejection, IANA timezone validation, scope isolation (`ownerId` + `botId`), and `redactSchedulerSecrets()`.
- **`src/schedules/calculator.ts`**: Deterministic `Intl.DateTimeFormat` timezone & DST calculation (`computeNextRunMs`, `evaluateDueOccurrences`) with injectable `Clock`, O(1) interval jump, <=14-day calendar search, DST spring-forward skip, DST fall-back single-fire, and clock-rollback protection.
- **`src/repository/sqlite-store.ts` & `routine-repository.ts`**: Isolated `node:sqlite` persistence (`0700` dir / `0600` DB, symlink checks, `PRAGMA foreign_keys = ON`, `BEGIN IMMEDIATE` transactions, parameterized SQL, bounded pagination, corrupt JSON rejection).
- **`src/queue/execution-queue.ts`**: Durable task queue with `UNIQUE(occurrence_key)` deduplication, atomic `claimNext()` respecting concurrency policy, lease expiration (`uncertainExecution = true`), terminal-state immutability, restart reconciliation (`reconcileOnRestart()`), and explicit retry confirmation.
- **`src/engine/scheduler-engine.ts`**: Separates schedule evaluation (`tick()`) from task dispatch (`dispatchNext()`), routing through `FutureRoutineDispatcher` with `requirePolicyRevalidation: true` and `reusePriorApprovals: false`.

## 2. Security Guarantees & Limitations
- Routine definitions and task prompts are strictly untrusted data and never grant tool, file, shell, or network permissions.
- `packages/scheduler` has zero direct runtime dependencies (`CodexAppServerAdapter`, `OpenClawGatewayAdapter`, `OllamaLocalAdapter`, `RunOrchestrator`, MCP, or Electron IPC).
- Lease expiration and restart reconciliation mark in-flight tasks `interrupted` with `uncertainExecution = true` and never auto-replay non-idempotent work.
- Limitation: Cron expression parsing, webhook/file triggers, production daemon timer loops, and desktop Routines UI are intentionally deferred to subsequent Phase 5 slices.

## 3. Future Production Integration Requirements
- **Production SQLite Migration (`0005+` / coordinated with Phase 3D)**: Add `scheduler_routines` and `scheduler_tasks` tables to `@ghost-bot/daemon` migrations with foreign keys to `agents(id)`.
- **Daemon Dispatch Bridge**: Wire `FutureRoutineDispatcher` in `@ghost-bot/daemon` to revalidate owner, bot, account, workspace, `RuntimePolicyBroker`, and `RunOrchestrator.startRun()`, entering `awaiting_approval` for `ask-approval` or sensitive actions.
- **IPC & Settings Integration**: Add Zod-validated `ghost:routines:*` IPC channels in `packages/shared-types/ipc.ts` and wire the `Routines` section in `SettingsModal.tsx` and `RightPanel.tsx`.
- **Shared Dependencies**: `@ghost-bot/scheduler` uses Node.js 24 built-ins only (`node:sqlite`, `node:crypto`, `node:fs`, `Intl`); zero `pnpm-lock.yaml` or root `package.json` changes are required.
