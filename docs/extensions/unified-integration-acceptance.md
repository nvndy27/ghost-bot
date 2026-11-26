# Ghost Bot — Unified Integration Foundation Acceptance

**Branch:** `feat/unified-integration`  
**Worktree:** `/home/nguyenduy/Documents/Projects/ghost-bot-unified`  
**Base Commit:** `a475033` (Phase 3D.4 accepted integration)  
**Merged Convergence Commit:** `232f89c` (`feat/browser-containment-verification`, ancestor of `484fe5b`, `465ec19`, `4fe63e1`, `d10df20`)

## 1. Git Ancestry & Dependency Reconciliation

Verified ancestors of `HEAD`: `a475033`, `04e324c`, `484fe5b`, `465ec19`, `4fe63e1`, `d10df20`, `232f89c`.  
`corepack pnpm install --offline` succeeded across all 12 workspace projects, preserving `zod` (`4.6.7`), MCP SDK/JSON Schema dependencies, `electron-builder` pinning, native RPM packaging, declared `playwright-core` (`^1.65.1`) in `@ghost-bot/computer-use`, and production SQLite migrations `0001`–`0007`.

## 2. Confirmed Findings & Fixes

1. **Pre-existing Phase 3D.4 Lint Errors:** `corepack pnpm lint` reported 1 unused variable (`safeMsg` in `apps/daemon/src/execution/orchestrator.ts:2197`, prefixed to `_safeMsg`) and 7 `no-undef` errors in `tests/fixtures/mcp-test-server.mjs` (added `/* global process, setTimeout */`).
2. **MCP Timing Assertions Under CPU Contention:** `packages/mcp/tests/unit/bounded-stdio-transport.test.ts:32` (`250 ms` fixed sleep) and `packages/mcp/tests/integration/hardening-regression.test.ts:221` (`150 ms` fixed sleep) can race child-process startup when multiple heavy suites run concurrently. Both assertions were preserved without weakening; sequential execution passed 3 consecutive times (`174/174`).

## 3. Verification Summary

- **Workspace Lint (`corepack pnpm lint`):** PASS (0 errors).
- **Workspace Typecheck & Build (`corepack pnpm -r --if-present typecheck && build`):** PASS across all 11 projects with scripts (including `apps/desktop` and `apps/daemon`).
- **Per-Package Test Breakdown (174/174):**
  - Core (`tests/*.test.ts`): **81/81**
  - `@ghost-bot/memory`: **14/14**
  - `@ghost-bot/knowledge`: **12/12**
  - `@ghost-bot/mcp`: **14/14**
  - `@ghost-bot/teams`: **20/20**
  - `@ghost-bot/scheduler`: **17/17**
  - `@ghost-bot/computer-use`: **16/16** (includes sandboxed Chrome `chromiumSandbox: true` inside `bwrap --unshare-all`)
- **Three Consecutive Sequential Full-Suite Runs (`174/174`):**
  - Run A: `174/174` passed (`18310.61 ms`)
  - Run B: `174/174` passed (`18209.87 ms`)
  - Run C: `174/174` passed (`17603.99 ms`)

## 4. Production Integration Roadmap & Ownership

Agent 1 is now the sole implementation owner of shared production components (`feat/unified-integration`):
1. **Teams Integration (Next):** Migration `0008+` extending Phase 1C `teams` & `team_members` (no duplicate tables), wiring `TeamCoordinator` to `RunOrchestrator` & `RuntimePolicyBroker`.
2. **Scheduler Integration:** Migration `0009+`, daemon-owned `ExecutionQueue` tick loop, restart reconciliation, and team-targeted routines via `RunOrchestrator`.
3. **Computer Use Integration:** `DaemonBrowserBridgeContract` + `RuntimePolicyBroker` single-use approvals (`inheritedFromTeamOrRoutine: false`), live viewer IPC, and `BwrapIsolatedBrowserWorker` packaging resolution.
4. **Carried-Forward Release Blockers:** Native Codex host-mediated MCP, OS Secret Service integration for MCP secrets, unsandboxed STDIO MCP permission acceptance, live Memory/Knowledge interoperability, native FUSE AppImage, installed RPM verification, package signing, and virtual-desktop VNC/PipeWire frame streaming.
