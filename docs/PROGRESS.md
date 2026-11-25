# Progress log

## Phase 2D — Runtime Recovery, Reconnect, Resume & Release Preparation

2026-11-26. Phase 2C merged to `main` (`c7891af`); Phase 2D **Implemented & Offline-Tested** on `feat/phase-2d-recovery-resume` (**CONDITIONAL PASS**: `55/55` unit tests and Electron recovery E2E passed; `electron-builder` not installed for AppImage/RPM artifact build and `GHOST_BOT_RUN_LIVE_RECOVERY=1` not executed without new live budget).

| State | Evidence |
|---|---|
| Implemented | Extended `RuntimeRegistry` (`apps/daemon/src/runtime/registry.ts`) with explicit `RuntimeLifecycleState` (`unavailable`, `connecting`, `connected`, `disconnected`, `reconnecting`, `authentication_required`, `unsupported`, `failed`), deduplicated `reconnect()`, and `closeOwnedClient()`. |
| Implemented | Hardened `RunOrchestrator` quarantine (`sessionsWithUnconfirmedStop`) so generation changes alone cannot clear quarantine without confirmed provider termination or `reconnectRuntime()` closing the owned runtime; added `inspectSession()` and explicit manual `retryRun()` (`SESSIONS_INSPECT`, `RUNS_RETRY`, `RUNTIME_RECONNECT`). |
| Implemented | Extended `RightPanel.tsx` and `App.tsx` with recovery banners (`interrupted`, `failed`, `quarantined`), explicit `Retry prompt` / `Reconnect runtime` / `New chat` actions, and usage refresh + reset timestamp display without auto-replay. |
| Implemented | Added Fedora/Linux packaging configuration (`apps/desktop/electron-builder.yml`, `apps/desktop/build/icon.svg`); `rpmbuild` is present on host, `electron-builder` is absent (no AppImage/RPM artifact built yet). |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (**55/55** including `tests/phase-2d-recovery.test.ts`), Electron smoke, `verify-phase-1b-ui.mjs` through `verify-phase-2c-ui.mjs`, `verify-electron-persistence.mjs`, `verify-phase-1d-electron.mjs`, `verify-phase-2a-electron.mjs`, and `verify-phase-2d-electron.mjs` (2 screenshots in `design/reviews/phase-2d/`) all passed. |

### Phase 2D continuation — 2026-11-26

Phase 2D remains **Tested** with a **CONDITIONAL PASS**. Antigravity stopped at its quota limit. The continuation is recorded in `ea35db1` on the same feature branch.

| State | Evidence |
|---|---|
| Implemented | Persisted unconfirmed-stop quarantine and extended session inspection. An external thread ID plus a connected runtime still yields `providerThreadStatus: unknown` until provider-side thread access is checked. |
| Tested | Lint, typecheck, build, 55 unit tests, five Playwright UI suites (1B, 1C, 1D, 2A, 2C), and four Electron suites (persistence, 1D metadata, 2A execution, 2D recovery) passed. |
| Verified | Fedora x86_64 AppImage built and passed an isolated mock-mode smoke launch in extract-and-run mode. The packaged renderer, sandbox, preload IPC and daemon health responded. Local artifact `apps/desktop/release/GhostBot-0.1.0-x86_64.AppImage` is 121049800 bytes, SHA-256 `1796cb113c080c463e8982cd134a99b2d827a51564ef5a249cf30ad53935038f`. |
| Verified | Fedora RPM built with FPM 1.18.0 on PATH and `USE_SYSTEM_FPM=true`. Metadata query and the extracted package smoke launch passed without installation. Local artifact `apps/desktop/release/ghost-bot-0.1.0.x86_64.rpm` is 81472041 bytes, SHA-256 `08d4918a6b68408e39cff5de3e341f0b8fde1ccb68384ea41de40bab64a1be76`. |
| Blocked | Live Phase 2D recovery lacks a complete result. The prior terminal recorded failed probe runs and a reduced turn budget. No new inference turn was submitted during this continuation. |

## Phase 2C — Live Tools, Interactive Approvals & Workspace Permissions

2026-11-25. Phase 2B merged to `main` (`a144aaf`); Phase 2C **Verified** (`PASS` — all offline security/approval tests and authorized 3-turn live Codex approval/workspace verification passed).

| State | Evidence |
|---|---|
| Verified | Added SQLite migration `0004_durable_approvals` (`apps/daemon/src/db/schema.ts`, `migrations.ts`) creating the durable `approvals` table binding approval ID, run/session/agent IDs, runtime generation, account identity, thread/turn/provider request IDs (`turn_id` populated from `CodexAppServerAdapter`), action type, summary, redacted args, `args_hash`, `permission_mode`, lifecycle status (`pending`, `resolving`, `approved`, `denied`, `expired`, `revoked`, `resolution_failed`), expiry, and decision metadata. |
| Verified | Hardened `CodexAppServerAdapter.handleServerRequest()` to decline privilege/network escalation requests (`withEscalatedPermissions`, `escalated`, `networkAccess`, `additionalPermissions`, `grantRoot`) and duplicate/mismatched-turn approval IDs, and hardened `RunOrchestrator` `sessionsWithUnconfirmedStop` quarantine to remain active until provider termination or runtime generation reset. |
| Verified | Unlocked `ask-approval` (`workspace-write` + `untrusted`) and `workspace` (`workspace-write` + `on-request`, `networkAccess: false`, `excludeSlashTmp: true`, `excludeTmpdirEnvVar: true`) in `RuntimePolicyBroker.authorizeLiveExecution()`, while keeping `full-access` and `Approve Always` disabled. |
| Verified | Authorized live verification (`GHOST_BOT_RUN_LIVE_TOOLS=1 node scripts/verify-phase-2c-live.mjs`, 3 total turns consumed across session) passed: Scenario 1 `VERIFIED_DENIED` (`notes.md` unchanged), Scenario 2 `VERIFIED_APPROVED_ONCE` (`notes.md` updated to `# Initial Notes\nAPPROVED_ONCE_OK\n`), `unrelated.txt` and outside `canary.txt` untouched (`canaryIntact: true`), `approvalCount: 2` persisted in SQLite, Electron restart restoration verified, and screenshots saved in `design/reviews/phase-2c/`. |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (`53/53`), Electron smoke, `verify-phase-1b-ui.mjs`, `verify-phase-1c-ui.mjs`, `verify-phase-1d-ui.mjs`, `verify-phase-2a-ui.mjs`, `verify-phase-2c-ui.mjs`, `verify-electron-persistence.mjs`, `verify-phase-1d-electron.mjs`, and `verify-phase-2a-electron.mjs` all passed. |

## Phase 2B — Live Codex Execution & Streaming

2026-11-25. Phase 2A hardened (`6d132e1`) and merged to `main` (`2ffc521`); Phase 2B **Verified** (`PASS` — all offline checks and authorized 3-turn live Codex Electron E2E passed).

| State | Evidence |
|---|---|
| Verified | Connected `CodexAppServerAdapter` into daemon-owned `RunOrchestrator` (`apps/daemon/src/execution/orchestrator.ts`) via `RuntimeRegistry.getExecutionAdapter()` (with execution-time live `getAccountSummary(false)` check bypassing 30s cache) and `RuntimePolicyBroker.authorizeLiveExecution()` (`apps/daemon/src/runtime/policy-broker.ts`), restricting Phase 2B live execution to verified `0.172.0`, ChatGPT subscription auth, canonical workspace, and `read-only` permission mode. |
| Verified | Added Codex thread identity binding & continuation (`sessions.external_session_id` + `account_id` verified before `thread/start` and `thread/resume`), effective prompt composition (`bot.instructions` + `settings.personalization.defaultInstructions`/`responseStyle` on `thread/start` only), runtime generation checks, end-to-end cancellation (`turn/interrupt` + 8s `CANCEL_ACK_TIMEOUT` unconfirmed-stop session guard), and Phase 2B live approval auto-denial (`approval.denied`). |
| Verified | Updated `ChatComposer.tsx` and `App.tsx` to support verified read-only Codex prompts, live model/effort selection, disabled Phase 2C permission options, and `approval.denied` rendering while preserving mock mode separation. |
| Verified | Authorized live verification (`GHOST_BOT_RUN_LIVE_CODEX=1 node scripts/verify-phase-2b-live.mjs`, 3 turns consumed) passed: Turn 1 live `GHOST_OK` streaming, Turn 2 same-thread continuation (`external_session_id` persisted), Turn 3 live cancellation (`VERIFIED_CANCELLED`), zero unauthorized workspace changes (`sentinel.txt` intact), refreshed account usage (`usageStatus: "available"`, 2 windows), Electron restart conversation restoration, and 4 screenshots saved in `design/reviews/phase-2b/`. |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (`50/50`), Electron smoke, `verify-phase-1b-ui.mjs`, `verify-phase-1c-ui.mjs`, `verify-phase-1d-ui.mjs`, `verify-phase-2a-ui.mjs`, `verify-electron-persistence.mjs`, `verify-phase-1d-electron.mjs`, and `verify-phase-2a-electron.mjs` all passed. |

## Phase 2A — Session, Run, Event and Message Persistence Foundation

2026-11-25. Phase 1D hardened (`chmod 0700` on existing Codex profile dir) and merged to `main` (`20c236a`); Phase 2A **Verified** on `feat/phase-2a-execution-foundation` after independent review and hardening (live AI inference intentionally disabled until Phase 2B).

| State | Evidence |
|---|---|
| Verified | Documented [ADR 0006](adr/0006-daemon-execution-foundation.md) and added SQLite migration `0003_execution_foundation` (`apps/daemon/src/db/schema.ts`, `migrations.ts`) adding `sessions.updated_at`/`archived_at`, `messages.seq_order`/`status`/`updated_at` (`ON DELETE RESTRICT`), `runs` (`UNIQUE(session_id, idempotency_key)`), and `run_events` (`UNIQUE(run_id, seq)`, `UNIQUE(run_id, event_key)`). |
| Verified | Built `RunStateMachine` (`apps/daemon/src/execution/state-machine.ts`), `RunEventStore` (`apps/daemon/src/execution/event-store.ts`), `SessionRepository` (`apps/daemon/src/sessions/repository.ts`), `mock-scenarios.ts`, and `RunOrchestrator` (`apps/daemon/src/execution/orchestrator.ts`) with startup crash reconciliation (`reconcileOnStartup`), single-active-run-per-session lock, idempotency conflict detection (`IDEMPOTENCY_CONFLICT` on payload mismatch), active-run bot archival guard (`ACTIVE_RUN_EXISTS`), single-daemon `daemon.lock` ownership, bounded message batching, and explicit blocking of live Codex inference in Phase 2A (`LIVE_INFERENCE_DISABLED`). |
| Verified | Fixed genuine `CodexAppServerAdapter` `turnId` notification buffering race (`packages/runtime-adapters/codex/codex-app-server.ts` — buffering `pendingNotifications` while `active.turnId === null` when `turn/start` response and notifications coalesce in one stdout read) and added coalesced-chunk regression test (`tests/codex-adapter.test.ts`). |
| Verified | Wired 11 Zod-validated IPC channels & daemon routes (`packages/shared-types/ipc.ts`, `apps/daemon/src/server.ts`, `apps/desktop/electron/main.ts`, `preload.cts`) and integrated `App.tsx` / `ChatHeader.tsx` with daemon-owned sessions, persisted message history, `+ New chat` / session switching, `runs.start`/`cancel`/`resolveApproval`, and self-scheduling `120ms` `afterSeq` cursor polling with pagination drain. |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm build`, **5 consecutive full parallel `pnpm test` runs (48/48 passing each run, 0 failures)**, Electron smoke test, `scripts/verify-phase-1b-ui.mjs` (6 screenshots), `scripts/verify-phase-1c-ui.mjs` (4 screenshots), `scripts/verify-phase-1d-ui.mjs` (5 screenshots), `scripts/verify-phase-2a-ui.mjs` (4 screenshots in `design/reviews/phase-2a/`), `scripts/verify-electron-persistence.mjs` (4 launches), `scripts/verify-phase-1d-electron.mjs` (Codex `0.172.0` metadata), and `scripts/verify-phase-2a-electron.mjs` (idempotency retry+conflict, cancel, approval, interrupted-run recovery, Codex inference blocked) all passed. |

## Phase 1D — Settings & Runtime Bridge

2026-11-25. Phase 1C upgraded (`0002_sessions_restrict_agent_delete`), hardened (`lstat` DB dir/file checks), and merged to `main` (`d371b6d`); Phase 1D **Verified**.

| State | Evidence |
|---|---|
| Verified | Implemented SQLite-backed `SettingsRepository` (`apps/daemon/src/settings/repository.ts`) with Zod validation, atomic transactions, corrupt JSON recovery, reset-to-defaults, and idempotent one-time `localStorage` appearance migration. |
| Verified | Implemented all 13 Settings sections in `SettingsModal.tsx` (`General`, `Appearance`, `Accounts & Providers`, `Models`, `Usage`, `Personalization`, `Memory`, `Tools & MCP`, `Permissions`, `Computer Use`, `Routines`, `Data & Privacy`, `Advanced`), clearly classifying persisted, runtime-managed, read-only, and deferred Phase 3/5 sections. |
| Verified | Implemented daemon-owned `RuntimeRegistry` (`apps/daemon/src/runtime/registry.ts`) and `RuntimePolicyBroker` (`apps/daemon/src/runtime/policy-broker.ts`) with request deduplication, 30s TTL cache, 2s refresh cooldown, stale fallback, secret redaction, and zero model inference. |
| Verified | Real Electron → IPC → Daemon → Policy Broker → Codex App Server `0.172.0` metadata bridge (`scripts/verify-phase-1d-electron.mjs`) confirmed `status: "available"`, `authMethod: "chatgpt"`, `planType: "plus"`, 10 discovered models, 2 live rate-limit windows, and `verifiedPermissionModes: ["read-only", "ask-approval", "workspace"]` without modifying `~/.codex` or running inference. |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm test` (40/40 tests including exact-version `0.172.0` policy broker, generation/account-switch cache invalidation, mandatory structured secret redaction, SQLite `b33f975` → `0002` upgrade, symlink DB/dir checks, adversarial SVG), `pnpm build`, Electron smoke test, 4-launch Bot persistence E2E (`verify-electron-persistence.mjs`), Phase 1D Electron mock+Codex test (`verify-phase-1d-electron.mjs`), and Phase 1B/1C/1D Playwright UI suites all passed. |

## Phase 1C — Bot management, SQLite persistence, and Avatar Editor

2026-11-25. Phase 1B merged to `main` (`24ba08b`); Phase 1C **Verified**.

| State | Evidence |
|---|---|
| Verified | Implemented SQLite persistence in `@ghost-bot/daemon` using `node:sqlite` (`DatabaseSync`, compatible across Electron 36 Node v22.19.0 and system Node v24.22.3) + `drizzle-orm/sqlite-core` + `drizzle-orm/sqlite-proxy` ([ADR 0005](adr/0005-node-sqlite-and-drizzle.md)). Persistent data dir (`0700`) and DB file (`0600`) kept separate from temporary runtime dir; `PRAGMA foreign_keys = ON`, `WAL`, transactional versioned migrations (`schema_migrations`), and single-time first-launch seeding (`seed.initial_bots.v1`). |
| Verified | Implemented Bot CRUD (`list`, `create`, `update`, `duplicate`, `delete`, `setActiveBot`), audit logging, and workspace directory picker (`dialog.showOpenDialog`) behind Zod-validated IPC (`packages/shared-types/ipc.ts`) and Bearer-authenticated daemon routes (`apps/daemon/src/bots/repository.ts`, `server.ts`). `full-access` remains rejected at Zod/daemon boundaries. |
| Verified | Implemented full Ghost Avatar Editor (`BotEditorModal.tsx`) with 12 presets, 12-color palette, 4 eye styles, rotation, animation toggle, randomize, reset, 7-state live preview, and strict custom SVG sanitization (`packages/avatar/svg-sanitizer.ts` using `isomorphic-dompurify` + tag/attribute/URL/DTD/size/complexity allowlist, rendered via inert `<img src="data:image/svg+xml;base64,...">`). |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm test` (32/32 tests including SQLite migrations, unsupported schema version rejection, soft-archive FK preservation, workspace traversal/missing-dir rejection, rollback, corrupt recovery, adversarial SVG rejection), `pnpm build`, Electron smoke test, 4-launch real Electron SQLite persistence E2E (`scripts/verify-electron-persistence.mjs`, including deleting all seeded bots across restart), and Phase 1C UI suite (`scripts/verify-phase-1c-ui.mjs`, 4 screenshots in `design/reviews/phase-1c/`) all passed. |

## Phase 1B — Main workspace UI

2026-11-25. Phase 1A hardened and merged to `main` (`da5c07a`); Phase 1B **Verified**.

| State | Evidence |
|---|---|
| Verified | Phase 1A hardening: private `0700` runtime dir with `0600` Unix socket, exact URL/origin navigation checks, loopback-only `GHOST_BOT_DEV_URL`, WebContents + mainFrame IPC sender validation, parent-exit daemon shutdown, version-bound Codex permission evidence (`resolveCodexVerifiedEvidence`), and enhanced Electron smoke verification asserting React render + preload IPC + zero console errors. Merged to `main` (`da5c07a`). |
| Verified | Built modular three-panel React workspace in `apps/desktop/src/` (`LeftSidebar`, `ChatHeader`, `MessageList`, `ChatComposer`, `RightPanel`, `DiffPreviewModal`, `SettingsModal`, `BotAvatar`) matching `design/references/workspace-dark.png` and `design/tokens.json`. |
| Verified | Implemented 12-preset `BotAvatar` with 7 states (`idle`, `thinking`, `working`, `approval`, `sleeping`, `completed`, `error`), `prefers-reduced-motion` + manual toggle, Light/Dark/System themes, draggable + keyboard sidebar resize/collapse, and Zod-validated `localStorage` UI preferences. |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm test` (27/27 tests including `UiPreferencesSchema` bounds & storage fallback), `pnpm build`, Electron smoke test, and extended Playwright UI verification (`scripts/verify-phase-1b-ui.mjs`: 0 console errors, no horizontal overflow across `1920x1080`, `1440x900`, `1366x768`, `960x640`, IME composition guard, Escape/Tab focus trap & restoration, reload persistence, 12 presets, 7 states) all passed. Captured 6 review screenshots under `design/reviews/phase-1b/`. |

## Phase 1A — Desktop scaffold & Step 0 review hardening

2026-11-25. Step 0 merged to `main` (`87665ed`); Phase 1A **Verified**.

| State | Evidence |
|---|---|
| Verified | Step 0 hardening: `CodexAppServerAdapter` now prevents simultaneous same-thread runs, correlates notifications by `turnId`, handles pre-`turnId` cancellation, revalidates ChatGPT subscription at execution boundaries, canonicalizes symlinked workspaces (`realpath`), revokes pending approvals on cancel/completion/exit, and `verify-codex-live.mjs` asserts all mandatory checks with symlink containment. Merged to `main` (`87665ed`). |
| Verified | Scaffolded pnpm workspace (`pnpm-workspace.yaml`, `pnpm-lock.yaml`) with `@ghost-bot/shared-types`, `@ghost-bot/runtime-adapters` (including explicit `MockRuntimeAdapter`), `@ghost-bot/avatar`, `@ghost-bot/daemon`, and `@ghost-bot/desktop`. |
| Verified | Built `@ghost-bot/daemon` (`apps/daemon/src/server.ts`) with Unix socket + constant-time Bearer token auth, centralized error normalization + secret redaction, and graceful shutdown. |
| Verified | Built Electron main (`apps/desktop/electron/main.ts`), CJS sandboxed preload (`apps/desktop/electron/preload.cts`), and React+Vite renderer (`apps/desktop/src/`) with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, restrictive CSP, sender/Zod IPC validation, blocked external navigation, and Fedora GTK3/Wayland switches (`gtk-version=3`, `ozone-platform-hint=auto`). |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm test` (23/23 tests), `pnpm build`, and Fedora Electron+daemon smoke launch (`GHOST_BOT_SMOKE_EXIT=1`) all passed with exit code 0. |

## Phase 0B & 0C — Authenticated Codex integration and security verification

2026-11-25. Phase 0 exit gate **PASS**.

| State | Evidence |
|---|---|
| Verified | Built reusable `JsonRpcStdioClient` (`packages/runtime-adapters/json-rpc-client.ts`) and `CodexAppServerAdapter` (`packages/runtime-adapters/codex/codex-app-server.ts`) against Codex App Server 0.172.0 protocol schema. |
| Verified | Authenticated dedicated persistent Codex profile (`~/.config/ghost-bot/codex-profile`) via official ChatGPT device-code flow without modifying `~/.codex` or inheriting API keys. Confirmed `accountType: "chatgpt"`, `planType: "plus"`, 10 discovered models, and live rate-limit windows (`300m` at 7%, `10080m` at 13%). |
| Verified | Live `node scripts/verify-codex-live.mjs` passed all boundary and lifecycle checks on `gpt-6.2-sol`: streaming (`roStreamed: true`), read-only file read (`roReadMatched: true`), denied write in read-only (`readOnlyDeniedWriteClean: true`), workspace-contained write (`workspaceWriteSucceeded: true`), outside-workspace write blocked including `/tmp` via `excludeSlashTmp: true` (`outsideWriteBlocked: true`), approval request and rejection with no side effect (`sawApprovalRequest: true`, `rejectedApprovalNoSideEffect: true`), turn cancellation (`cancellationVerified: true`), and session resume continuity (`sessionContinuityVerified: true`). |
| Tested | `npm test` passed 16/16 offline tests across `tests/phase-zero.test.ts`, `tests/json-rpc-client.test.ts`, and `tests/codex-adapter.test.ts`. Strict TypeScript check (`tsc --noEmit --strict`) passed with 0 errors. |
| Verified | OpenClaw Gateway loopback probe (`openclaw gateway probe --json`) confirmed `ws://127.0.0.1:18789` reachable with `role: "operator"`, `scopes: ["operator.read"]`, `capability: "read_only"`. |
| Blocked | Live Ollama discovery (`127.0.0.1:11434` / binary absent) and live Kimi ACP (`kimi` CLI absent). Claude subscription login remains blocked pending vendor approval. |
| Implemented | [ADR 0004](adr/0004-codex-jsonrpc-and-sandbox-containment.md) documenting JSON-RPC transport and `excludeSlashTmp` containment. |

## Phase 0A — Starter audit and runtime discovery

2026-11-25. Local baseline completed.

| State | Evidence |
|---|---|
| Verified | Audited starter files and three screenshots. Chrome headless loaded Chief of Staff, demo approval and offline composer. Preserved prototype behavior, design tokens and twelve SVG presets. |
| Verified | Initialized `main` and pushed starter commit `4af838c` to the authorized private repository. |
| Verified | Node 24.22.3, Codex 0.172.0 and OpenClaw CLI 2026.11.8 (2d4ab29). |
| Tested | `npm test` passed four offline tests. Strict TypeScript check and JavaScript syntax checks passed. |
