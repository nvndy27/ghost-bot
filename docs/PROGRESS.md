# Progress log

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
