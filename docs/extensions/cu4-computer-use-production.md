# CU.4 — Computer Use Production Daemon Integration

- **Branch**: `feat/cu4-computer-use-production`
- **Accepted Scheduler Baseline**: `e46dd67` (`origin/feat/phase-5d-scheduler-acceptance`)
- **Preserved Foundations**: `4fe63e1` (CU.3), `232f89c` (Composed browser containment), `b0545f9` (Unified integration)
- **Production Migrations**: `0001`–`0011` preserved unchanged; added `0012_computer_use_sessions_audit`
- **Verdict**: **PASS — Offline Computer Use Production Daemon Candidate** (live model-driven Computer Use and unsupported virtual-desktop frame capture/input remain disabled)

## 1. ComputerUseService & Policy Integration

- **`ComputerUseService` (`apps/daemon/src/computer-use/service.ts`)**:
  - Daemon-owned lifecycle for capability discovery, isolated browser session creation (`BwrapIsolatedBrowserWorker`), tab observation, single-use action approvals, authorized action execution, sanitized action ledger inspection, session close, emergency stop, startup reconciliation (`reconcileOnStartup`), and bounded audit retention (`pruneAuditRetention`).
  - Reuses `@ghost-bot/computer-use` (`BwrapIsolatedBrowserWorker`, `PlaywrightBrowserBackend`, `WestonHeadlessVirtualDesktop`).
- **`RuntimePolicyBroker.evaluateComputerUsePolicy` (`apps/daemon/src/runtime/policy-broker.ts`)**:
  - Denies `full-access`, inherited Teams/Scheduler consent (`inheritedFromTeamOrRoutine !== false`), missing explicit consent (`explicitConsent !== true`), `liveModelDriven === true` (`LIVE_MODEL_DRIVEN_CU_DISABLED`), and `read-only` mutations (`CU_READ_ONLY_BLOCKS_MUTATION`).
  - Separates `allowObservation` from `allowNavigation` and `allowInteraction`.
  - Binds each action approval to `(ownerId, botId, runId, cuSessionId, tabId, observationId, navigationGeneration, actionId, actionKind, actionHash, expiresAt)` and atomically consumes single-use approvals (`pending -> approved -> consumed`) after revalidating live tab observation/navigation generation.

## 2. Persistence & Audit Guarantees (`0012_computer_use_sessions_audit`)

- Added `cu_sessions`, `cu_action_approvals`, and `cu_action_ledger` in `apps/daemon/src/db/migrations.ts`.
- Never persists raw screenshot PNG bytes, typed secrets (`type_text` redacted to length), cookies, or browser storage.
- All ledger entries enforce `replayAllowed: false`; `pruneAuditRetention` never deletes active sessions or `uncertain` records.

## 3. Packaged Browser Worker & Protocol Hardening (CU4-PKG-01/02, CU4-WRK-01/02)

- Extracted `packages/computer-use/src/browser/worker-entry.ts` and updated `BwrapIsolatedBrowserWorker` (`packages/computer-use/src/browser/bwrap-browser-worker.ts`):
  - Resolves `computer-use-worker.mjs` + `vendor/playwright-core` in packaged Electron builds (`apps/desktop/scripts/bundle-daemon.mjs` -> `resources/daemon/`) without workspace `node_modules` or `.ts` assumptions.
  - Explicitly verifies `bwrap` availability (fails closed without unisolated fallback), replaces `pgrep` with `/proc/<pid>/cmdline` inspection, bounds `stdout` before parsing (`4 MiB`), handles malformed JSON without crashing the daemon, drains/bounds `stderr` (`8 KiB`), and settles all pending requests on worker error/exit.
- Built `GhostBot-0.1.0-x86_64.AppImage` and `ghost-bot-0.1.0-1.x86_64.rpm`, extracted the AppImage, and verified real `bwrap` + Chromium (`chromiumSandbox: true`, `hasNoSandboxFlag: false`) fixture navigation and screenshot capture (`PACKAGED_APPIMAGE_CU_WORKER_E2E_PASSED`).

## 4. Typed HTTP & Electron IPC

- Added 12 authenticated `/computer-use/...` routes in `apps/daemon/src/server.ts`, strict Zod schemas + `COMPUTER_USE_*` channels in `packages/shared-types/ipc.ts`, bounded IPC handlers in `apps/desktop/electron/main.ts`, and preload bindings in `apps/desktop/electron/preload.cts`.

## 5. Verification Evidence

- **`corepack pnpm lint`**: PASS
- **`corepack pnpm -r --if-present typecheck`**: PASS (11/11 projects)
- **`corepack pnpm -r --if-present build`**: PASS
- **3 Consecutive Full-Workspace Regression Runs** (`198/198` per run, `0` failures):
  - `root`: `105/105` (×3, including 3 CU.4 tests in `tests/cu4-computer-use-production.test.ts`)
  - `@ghost-bot/teams`: `20/20` (×3)
  - `@ghost-bot/scheduler`: `17/17` (×3)
  - `@ghost-bot/computer-use`: `16/16` (×3)
  - `@ghost-bot/memory`: `14/14` (×3)
  - `@ghost-bot/knowledge`: `12/12` (×3)
  - `@ghost-bot/mcp`: `14/14` (×3)
- **Electron E2E & IPC**:
  - `node scripts/verify-cu4-computer-use-ipc.mjs`: PASS
  - `node scripts/verify-phase-5b-scheduler-ipc.mjs`: PASS
  - `node scripts/verify-phase-5c-routines-desktop.mjs`: PASS
  - `node scripts/verify-phase-4d3-teams-acceptance.mjs`: PASS
  - `node scripts/verify-phase-2e-acceptance.mjs`: PASS (`consoleErrors: 0`, `daemonExitedCleanly: true`)
- **MCP Concurrency Stress (4 parallel workers)**: `4/4` each, `0` failures.
- **Packaged AppImage CU Worker E2E**: `PACKAGED_APPIMAGE_CU_WORKER_E2E_PASSED { bytes: 9462, hasNoSandboxFlag: false }`.
