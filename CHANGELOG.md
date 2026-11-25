# Changelog

## Unreleased

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
