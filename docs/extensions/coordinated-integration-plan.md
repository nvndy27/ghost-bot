# Ghost Bot — Coordinated Product Integration Plan

**Staging Branch:** `feat/integration-staging`  
**Staging Worktree:** `/home/nguyenduy/Documents/Projects/ghost-bot-integration-staging`  
**Base Commit:** `9b6ba1b` (Phase 3D.2 accepted Knowledge integration)  
**Merged Frozen Foundations:**
1. `484fe5b` (`feat/phase-4a-teams-foundation`) — `@ghost-bot/teams`
2. `465ec19` (`feat/phase-5a-scheduler-foundation`) — `@ghost-bot/scheduler`
3. `4fe63e1` (`feat/computer-use-foundation`) — `@ghost-bot/computer-use`

> [!IMPORTANT]
> This staging branch is a disposable integration candidate. Do not merge into `main` until Agent 2 completes Phase 3D.3 MCP integration and merges Phase 3D into `main`.

## 1. Workspace & Dependency Reconciliation

- `pnpm-workspace.yaml` discovers `apps/*` and `packages/*`, registering `@ghost-bot/teams`, `@ghost-bot/scheduler`, and `@ghost-bot/computer-use` automatically.
- **Confirmed Finding & Staging Fix:** `packages/computer-use/src/browser/playwright-browser-backend.ts` previously fell back to a hardcoded path in another worktree's `node_modules`. Reconciled in staging by declaring `"playwright-core": "^1.65.1"` in `packages/computer-use/package.json` (matching root `package.json` and `pnpm-lock.yaml`) and resolving `'playwright-core'` directly from workspace `node_modules`.
- Preserved pinned `zod` (`4.6.7`), `electron-builder`, and native RPM packaging scripts.

## 2. Production Integration Dependency Matrix

### A. Teams (`@ghost-bot/teams`) — Recommended First After Phase 3D
- **Persistence:** Extend existing Phase 1C `teams` and `team_members` tables in `apps/daemon/src/db/migrations.ts` (next available migration number after Phase 3D.3) rather than duplicating `member_bot_ids_json`. Add `team_runs`, `team_task_dependencies`, `team_tasks`, and `team_messages`.
- **Orchestration & Policy:** Wire `TeamCoordinator` inside `apps/daemon` to `RunOrchestrator` (`apps/daemon/src/execution/orchestrator.ts`) and `RuntimePolicyBroker` (`apps/daemon/src/runtime/policy-broker.ts`) via `DaemonTeamBridgeContract`.
- **Authorization:** Every delegated worker task creates a child daemon `run` linked to `teamRunId`, revalidates `RuntimePolicyBroker` independently, never inherits broader permissions, and never reuses prior approvals (`reusePriorApprovals: false`).
- **Memory/Knowledge/MCP:** `memorySharingPolicy` remains `'explicit-only'`; per-worker memory/knowledge/MCP scopes are constructed exclusively inside `apps/daemon`.

### B. Scheduler (`@ghost-bot/scheduler`) — Recommended Second
- **Persistence:** Add `routines`, `routine_runs`, `routine_notifications`, and `routine_approvals` in the next available daemon migration after Teams.
- **Lifecycle:** `apps/daemon` owns scheduler tick loop, `ExecutionQueue`, and `reconcileOnStartup` alongside `RunOrchestrator.reconcileOnStartup()`.
- **Team-Targeted Routines:** A routine with `targetKind: 'team'` dispatches through `RunOrchestrator` -> `TeamCoordinator.startTeamRun` -> `RuntimePolicyBroker` (never directly to workers or runtimes).

### C. Computer Use (`@ghost-bot/computer-use`) — Recommended Third
- **Browser Worker Ownership:** `apps/daemon` owns `PlaywrightBrowserBackend` (`chromiumSandbox: true`) and `BubblewrapIsolationRunner` (`bwrap --unshare-all --cap-drop ALL`).
- **Policy & Approvals:** Every `observe_screen`, `pointer_control`, `keyboard_control`, and browser `allowNavigation` / `allowInteraction` grant requires single-use `RuntimePolicyBroker` approval; Teams and Scheduler cannot inherit interactive desktop consent (`inheritedFromTeamOrRoutine: false`).
- **Live Viewer & Quarantine:** Stream `LiveViewerFrame` metadata over authenticated preload IPC without persisting raw screenshots; `emergencyStop` revokes consent, terminates owned browser/Weston/bwrap processes, and quarantines `uncertain` actions (`replayAllowed: false`).
- **Gated Capabilities:** Keep native host Wayland portal capture/input and virtual-desktop frame streaming disabled by default until VNC/PipeWire consumers are implemented and verified.

## 3. Recommended Integration Order & Acceptance Gates

1. **Gate 0 (Agent 2):** Complete Phase 3D.3 MCP integration and merge Phase 3D into `main`.
2. **Gate 1 (Teams):** Rebase/port `@ghost-bot/teams` into `main`, add coordinated migration, wire `TeamCoordinator` + `RuntimePolicyBroker`, verify offline + live smoke.
3. **Gate 2 (Scheduler):** Port `@ghost-bot/scheduler`, add coordinated migration, wire daemon tick + team-targeted routines, verify restart/idempotency/approval tests.
4. **Gate 3 (Computer Use):** Port `@ghost-bot/computer-use` (with `playwright-core` dependency declaration), wire `DaemonBrowserBridgeContract` + `RuntimePolicyBroker` + live viewer IPC, verify sandboxed browser E2E.
