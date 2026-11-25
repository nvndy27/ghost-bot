# Changelog

## Unreleased

### Phase 2E — Multi-Runtime Completion, Packaging & Functional MVP Acceptance
- Added `OpenClawGatewayAdapter` (`packages/runtime-adapters/openclaw/openclaw-gateway.ts`) with loopback-only validation, `health`/`status`/`models.list` discovery, normalized streaming/tool/approval protocol support, and fail-closed `RuntimePolicyBroker` execution gating.
- Added optional `OllamaLocalAdapter` (`packages/runtime-adapters/ollama/ollama-adapter.ts`) with loopback HTTP validation, `/api/version` + `/api/tags` discovery, bounded stateless `/api/chat` NDJSON streaming, `AbortController` cancellation, and `read-only` enforcement.
- Hardened `JsonRpcClient.close()` to wait for actual child process exit and reject on failed termination, and updated `RunOrchestrator.reconcileOnStartup()` to reconstruct durable quarantine for interrupted `cancelling` runs.
- Polished `RightPanel.tsx` and `SettingsModal.tsx` usage/rate-limit displays (source, account/plan, used/remaining %, reset timestamp, last refresh, stale status) and increased `ghost:providers:list` timeout to 15s.
- Added `tests/openclaw-adapter.test.ts`, `tests/ollama-adapter.test.ts`, `tests/phase-2e-mvp.test.ts` (61/61 unit tests across 3 consecutive runs), `scripts/verify-phase-2e-acceptance.mjs` (4 screenshots in `design/reviews/phase-2e/`), `verify:offline` script, and `docs/PHASE2_RELEASE_REPORT.md`.

### Phase 2D — Runtime Recovery, Reconnect, Resume & Release Preparation
- Added `RuntimeLifecycleState`, deduplicated `RuntimeRegistry.reconnect()`, and `closeOwnedClient()` (`apps/daemon/src/runtime/registry.ts`).
- Hardened `RunOrchestrator` quarantine (`sessionsWithUnconfirmedStop`) and added `inspectSession()`, `retryRun()`, and `reconnectRuntime()` behind `SESSIONS_INSPECT`, `RUNS_RETRY`, and `RUNTIME_RECONNECT` IPC/daemon routes.
- Added recovery banner (`Retry prompt`, `Reconnect runtime`, `New chat`) and usage refresh/reset timestamps in `App.tsx` and `RightPanel.tsx`.
- Prepared Fedora/Linux packaging (`apps/desktop/electron-builder.yml`, `apps/desktop/build/icon.svg`, `apps/desktop/scripts/bundle-daemon.mjs`, pinned `electron-builder@26.0.12`), durable quarantine persistence (`execution.quarantinedSessions.v1`) preserved on termination failure (`RUNTIME_TERMINATION_FAILED`), `RETRY_CONFIRMATION_REQUIRED` + two-step UI confirmation for tool-activity retries, `CodexAppServerAdapter.readThread()` (`thread/read`) + account ownership validation in `inspectSession()`, 25s daemon timeout for runtime reconnect/inspect, `tests/phase-2d-recovery.test.ts` (56/56 unit tests), `scripts/verify-phase-2d-electron.mjs`, `scripts/verify-packaged-appimage.mjs`, and opt-in 2-turn `scripts/verify-phase-2d-live.mjs`.

### Phase 2C — Live Tools, Interactive Approvals & Workspace Permissions
- Added SQLite migration `0004_durable_approvals` (`approvals` table) and durable approval lifecycle (`pending`, `resolving`, `approved`, `denied`, `expired`, `revoked`, `resolution_failed`) in `RunOrchestrator`.
- Unlocked verified `ask-approval` and `workspace` execution modes in `RuntimePolicyBroker.authorizeLiveExecution()` (`networkAccess: false`, `excludeSlashTmp: true`, `excludeTmpdirEnvVar: true`) while keeping `full-access` disabled.
- Updated `ApprovalCard`, `ChatComposer`, `App.tsx`, and `shared-types/ipc.ts` for `Approve once` / `Deny`, duplicate-click prevention, `argsHash` verification, and clear mock vs live approval labels.
- Added `tests/phase-2c-approvals.test.ts` (52/52 unit tests), `scripts/verify-phase-2c-ui.mjs` (3 screenshots in `design/reviews/phase-2c/`), and opt-in `scripts/verify-phase-2c-live.mjs` (`GHOST_BOT_RUN_LIVE_TOOLS=1`).

### Phase 2B — Live Codex Execution & Streaming
- Connected `CodexAppServerAdapter` to `RunOrchestrator` via `RuntimeRegistry.getExecutionAdapter()` and `RuntimePolicyBroker.authorizeLiveExecution()`, enforcing verified `0.172.0` Codex version, ChatGPT subscription auth, canonical workspace, and `read-only` mode for Phase 2B.
- Persisted `sessions.external_session_id` and `account_id` before `turn/start`, supporting same-thread `thread/resume` continuation, instruction composition (`bot.instructions` + `settings.personalization`), end-to-end `turn/interrupt` cancellation, and automatic denial of unexpected live approval requests (`approval.denied`).
- Updated `ChatComposer.tsx` and `App.tsx` for live read-only Codex execution while keeping `ask-approval` and `workspace` gated for Phase 2C.
- Added `tests/live-codex-execution.test.ts` (50/50 total unit tests) and opt-in `scripts/verify-phase-2b-live.mjs`.

### Phase 2A — Session, Run, Event and Message Persistence Foundation
- Documented [ADR 0006](docs/adr/0006-daemon-execution-foundation.md) and added SQLite migration `0003_execution_foundation` (`runs`, `run_events`, updated `sessions` and `messages` with `ON DELETE RESTRICT` and monotonic sequence/idempotency indexes).
- Added daemon-owned `RunStateMachine`, `RunEventStore`, `SessionRepository`, deterministic `mock-scenarios`, and `RunOrchestrator` with startup crash recovery (`interrupted` reconciliation), concurrency/idempotency enforcement, bounded message batching, and Phase 2A live inference guard (`LIVE_INFERENCE_DISABLED`).
- Added 11 Zod-validated IPC channels and daemon HTTP routes for sessions, messages, runs, cursor-based events, cancellation, and mock approval resolution.
- Replaced React's `setInterval` mock timer in `App.tsx` with daemon-owned sessions, persisted chat history, session switcher / `+ New chat` in `ChatHeader.tsx`, and `120ms` `afterSeq` cursor polling.
- Added `tests/execution-foundation.test.ts`, `scripts/verify-phase-2a-ui.mjs` (4 screenshots in `design/reviews/phase-2a/`), and `scripts/verify-phase-2a-electron.mjs`.

### Phase 1D — Settings & Runtime Bridge
- Added SQLite-backed `SettingsRepository` (`apps/daemon/src/settings/repository.ts`) with Zod schemas, atomic updates, corrupt JSON recovery, reset-to-defaults, and idempotent `localStorage` migration.
- Completed all 13 Settings sections in `SettingsModal.tsx` with explicit persisted, runtime-managed, read-only, and deferred Phase 3/5 classifications.
- Added daemon-owned `RuntimeRegistry` (`apps/daemon/src/runtime/registry.ts`) and `RuntimePolicyBroker` (`apps/daemon/src/runtime/policy-broker.ts`) with request deduplication, 30s cache, stale fallback, secret redaction, and version-bound Codex enforcement.
- Wired live Codex `0.172.0` account, model/effort discovery, and rate-limit windows into Electron IPC (`ghost:runtime:snapshot`) without inference or modifying `~/.codex`.
- Added `tests/settings-runtime.test.ts` (37/37 unit tests), `scripts/verify-phase-1d-electron.mjs`, `scripts/verify-phase-1d-ui.mjs`, and 5 review screenshots in `design/reviews/phase-1d/`.

### Phase 1C — Bot management, SQLite persistence, and Avatar Editor
- Added SQLite persistence in `@ghost-bot/daemon` using `node:sqlite` (`DatabaseSync`) + `drizzle-orm` ([ADR 0005](docs/adr/0005-node-sqlite-and-drizzle.md)) with `0700`/`0600` permissions, `PRAGMA foreign_keys = ON`, transactional migrations (`schema_migrations`), and single-time first-launch seeding.
- Added Bot CRUD (`list`, `create`, `update`, `duplicate`, `delete`, `setActiveBot`), audit logging, and directory picker IPC behind Zod validation (`packages/shared-types/ipc.ts`).
- Added full Ghost Avatar Editor (`BotEditorModal.tsx`) with 12 presets, 12-color palette, 4 eye styles, rotation, randomize, reset, 7-state preview, and strict custom SVG sanitization (`packages/avatar/svg-sanitizer.ts`) rendered via inert `<img>` data URLs.
- Added `tests/db-persistence.test.ts`, `tests/svg-sanitizer.test.ts`, `scripts/verify-electron-persistence.mjs`, and `scripts/verify-phase-1c-ui.mjs` (32/32 unit tests + real 3-launch Electron persistence E2E passing).

### Phase 1B — Main workspace UI & Phase 1A hardening
- Hardened Phase 1A daemon runtime dir (`0700`) and Unix socket (`0600`), exact URL/origin navigation checks, loopback-only dev URLs, WebContents + mainFrame IPC sender validation, version-bound Codex permission evidence, and enhanced Electron smoke verification; merged Phase 1A into `main`.
- Implemented the three-panel React workspace (`LeftSidebar`, `ChatHeader`, `MessageList`, `ChatComposer`, `RightPanel`, `DiffPreviewModal`, `SettingsModal`, `BotAvatar`) using `design/tokens.json` and all 12 `avatarPresets`.
- Added Light/Dark/System themes, `prefers-reduced-motion` support, draggable + keyboard sidebar resize/collapse, and Zod-validated UI preferences.
- Added `scripts/verify-phase-1b-ui.mjs` Playwright UI verification and captured 6 review screenshots in `design/reviews/phase-1b/`.

### Phase 1A — Desktop scaffold & Step 0 hardening
- Hardened `CodexAppServerAdapter` (same-thread run lock, `turnId` notification correlation, pre-`turnId` cancellation, boundary auth revalidation, `realpath` workspace canonicalization, pending approval revocation) and `verify-codex-live.mjs` assertions/symlink check; merged Phase 0 into `main`.
- Added pnpm workspace (`pnpm-workspace.yaml`, `pnpm-lock.yaml`), ESLint + TypeScript strict pipeline, and `@ghost-bot/shared-types/ipc` Zod contracts.
- Added `@ghost-bot/daemon` with Unix socket + Bearer token auth, centralized error normalization, secret redaction, and explicit `MockRuntimeAdapter`.
- Added `@ghost-bot/desktop` (Electron 36 + React 19 + Vite 6) with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, restrictive CSP, validated IPC, controlled navigation, and Fedora GTK3/Wayland support.

### Phase 0B & 0C
- Added reusable newline-delimited JSON-RPC 2.0 stdio client (`packages/runtime-adapters/json-rpc-client.ts`) with concurrent request correlation, server-initiated request handling, timeouts, `AbortSignal` cancellation, malformed payload resilience, and graceful shutdown.
- Added `CodexAppServerAdapter` (`packages/runtime-adapters/codex/codex-app-server.ts`) using an isolated persistent profile (`~/.config/ghost-bot/codex-profile`), ChatGPT subscription auth, live rate-limit normalization, streaming, cancellation, session resume, `argsHash`-bound approvals, and `excludeSlashTmp: true` workspace containment.
- Added 12 new offline unit tests (`tests/json-rpc-client.test.ts`, `tests/codex-adapter.test.ts`) bringing total offline tests to 16/16 passing.
- Added opt-in live Codex verification harness (`scripts/verify-codex-live.mjs`) and verified all Phase 0 exit gate criteria.
- Documented [ADR 0004](docs/adr/0004-codex-jsonrpc-and-sandbox-containment.md) and updated provider matrix, security, roadmap, progress, and test plan.

### Phase 0A
- Initialized the ghost-bot repository from the starter kit with the original offline prototype and avatar system.
- Added opt-in Codex App Server, OpenClaw Gateway and Ollama discovery probes.
- Added normalized model discovery, versioned runtime events and tested permission preflight.
- Documented provider evidence, SQLite design, security boundaries and the Phase 0 handoff.
