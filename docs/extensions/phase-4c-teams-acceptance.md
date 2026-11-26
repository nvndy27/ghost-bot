# Phase 4C — Final Teams Security, Diagnostics & Integration Readiness

**Branch:** `feat/phase-4a-teams-foundation` (frozen after Phase 4C acceptance)  
**Worktree:** `/home/nguyenduy/Documents/Projects/ghost-bot-teams`  
**Package:** `@ghost-bot/teams` (`packages/teams/`)  
**Historical Baseline:** `07839ff` (Phase 4A: `1ab25bc`, Phase 4B: `780cf94`)

## 1. Confirmed Phase 4C Findings & Fixes

1. **Unsupported Future Schema Version:** `openTeamDatabase` previously ignored `currentVersion > 2`. Fixed to fail closed with `TeamError('UNSUPPORTED_SCHEMA_VERSION')` when opening a database newer than schema version `2`.
2. **Sender Identity Spoofing & Cross-Run Message Isolation:** `TeamRepository.postMessage` now binds `senderType` to authoritative identities (`user` → `ownerId`, `chief_of_staff` → `leadBotId`, `system` → `'system'`, `worker` → active `memberBotIds` with `untrusted: true`) and rejects cross-run or cross-team originating tasks (`SENDER_SPOOFING` / `SCOPE_FORBIDDEN`).
3. **Planner & Synthesizer Budget Accounting:** `TeamTaskPlan.estimatedUsage` and `TeamResultSynthesizer.synthesize` usage are persisted into `team_runs` and reported separately in `TeamRunAggregateResult` (`plannerTokensUsed`, `synthesizerTokensUsed`, `totalTokensUsed`, `providerInferenceCount`) without double-counting parent and child tasks.
4. **Synthesis Cancellation Race Guard:** `TeamCoordinator.synthesizeFinalResponse` re-checks `team_runs.status` inside a transaction before recording usage or posting `final_response`, preventing cancelled or uncertain runs from being overridden.
5. **Safe Bounded Retention:** `TeamRepository.pruneCompletedHistory` prunes old confirmed terminal runs/messages while strictly preserving active runs, `uncertain` tasks, locked `reserved_tokens`, and active deduplication records.

## 2. Diagnostics & Plan Preview

- **`TeamDiagnosticsService` (`src/engine/team-diagnostics.ts`):** Pure read-only diagnostics (`readOnly: true`) exposing structured reason codes (`TEAM_RUN_READY`, `WAITING_FOR_DEPENDENCIES`, `BLOCKED_PREREQUISITE`, `CONCURRENCY_LIMIT_REACHED`, `BUDGET_EXHAUSTED`, `MAX_DEPTH_REACHED`, `MEMBER_UNAVAILABLE`, `AWAITING_AUTHORIZATION`, `AWAITING_APPROVAL`, `CANCELLATION_PENDING`, `EXECUTION_UNCERTAIN`, `COMPLETED_WITH_PARTIAL_RESULTS`, `COMPLETED`) and a sanitized task ledger summary.
- **`previewTeamPlan` (`src/engine/team-plan-preview.ts`):** Pure, side-effect-free DAG preview returning topological execution layers, dependency edges, assigned members, `estimatedTokenAllocation` (`isEstimateOnly: true`), `maxPossibleConcurrency`, `unboundedPeakWidth`, and validation errors/warnings.

## 3. Remaining Security Limitations (Independent Package Scope)

- `@ghost-bot/teams` relies on injected `TeamTaskPlanner`, `TeamTaskDispatcher`, and `TeamResultSynthesizer` doubles; hard provider-token enforcement, OS sandbox containment, and `RuntimePolicyBroker` enforcement occur in `apps/daemon` during Phase 4C+ production integration.
- Production `apps/daemon` integration, IPC channels, desktop UI, and live provider execution remain **unverified** until coordinated integration.
