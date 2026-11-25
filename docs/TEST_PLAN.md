# Test plan

Offline default: unit tests for JSON-RPC correlation, concurrent out-of-order responses, streaming notifications, server-initiated requests, timeouts, cancellation, process crashes, malformed payload rejection, adapter normalization, unknown quota (`null`) handling, permission mode mapping, `argsHash`/expiry approval guards, and path/sandbox policies; SQLite migration/restart and idempotency (Phase 1); UI Playwright for create bot, avatar, model selection, settings, approval, cancellation, theme and keyboard (Phase 1). Mock data clearly marked.

Opt-in integration: Codex dedicated ChatGPT profile (`node scripts/verify-codex-live.mjs --login-only` then `node scripts/verify-codex-live.mjs`); OpenClaw health and gateway probe (`node scripts/probe-openclaw.mjs`, `openclaw gateway probe --json`); Ollama local discovery (`node scripts/probe-ollama.mjs`). No paid requests without explicit opt-in. Redact diagnostics.

## Phase 0 commands and results

- `npm test` — **16/16 offline tests pass** (`tests/phase-zero.test.ts`, `tests/json-rpc-client.test.ts`, `tests/codex-adapter.test.ts`).
- `npm exec --yes --package=typescript@5.9.3 --package=@types/node -c 'tsc --noEmit --strict --module nodenext --target es2022 --allowImportingTsExtensions --typeRoots "$(dirname "$(dirname "$(which tsc)")")/@types" --types node packages/shared-types/*.ts packages/avatar/presets.ts packages/runtime-adapters/json-rpc-client.ts packages/runtime-adapters/codex/codex-app-server.ts tests/*.ts'` — **0 errors** in strict mode.
- `node scripts/verify-codex-live.mjs` — **all live Codex checks pass** on `gpt-6.2-sol` (`chatgpt` `plus` profile): streaming, read-only read, denied write, workspace write, outside-workspace write blocked (`excludeSlashTmp: true`), approval rejection with no side effect, cancellation, and session resume continuity.
- `node scripts/probe-openclaw.mjs` & `openclaw gateway probe --json` — **pass** (`ok: true`, `ws://127.0.0.1:18789`, `operator.read`).
- `node scripts/probe-ollama.mjs` — **blocked** (no local Ollama binary or listener at `127.0.0.1:11434`).

## Phase 1C & 1D commands and results

- `pnpm lint` — **pass** (0 errors).
- `pnpm typecheck` — **pass** across all 5 TypeScript workspace packages.
- `pnpm test` — **40/40 offline tests pass** (Phase 0–1D including `SettingsRepository`, `RuntimePolicyBroker` exact-version `0.172.0` enforcement, `RuntimeRegistry` generation/account-switch cache invalidation, mandatory structured secret redaction, SQLite `b33f975` → `0002` upgrade, symlink DB/dir checks, adversarial SVG).
- `pnpm build` — **pass**.
- `node scripts/verify-electron-persistence.mjs` — **pass** (4-launch real Electron + daemon + SQLite persistence E2E).
- `node scripts/verify-phase-1d-electron.mjs` — **pass** (Path A: Electron mock Settings persistence & reset; Path B: Electron → IPC → Daemon → Policy Broker → Codex 0.172.0 metadata bridge with 0 inference).
- `node scripts/verify-phase-1c-ui.mjs` & `node scripts/verify-phase-1d-ui.mjs` — **pass** (0 console errors; 5 Phase 1D screenshots in `design/reviews/phase-1d/`).

- `pnpm lint` — **pass** (0 errors across `packages`, `apps`, `tests`).
- `pnpm typecheck` — **pass** across all 5 TypeScript workspace packages.
- `pnpm test` — **27/27 offline tests pass** (Phase 0 + Step 0 hardening + Phase 1A daemon/IPC/security + Phase 1B `UiPreferencesSchema` fallback).
- `pnpm build` — **pass** (Vite renderer bundle + Electron main/preload compilation + daemon typecheck).
- `GHOST_BOT_SMOKE_EXIT=1 GHOST_BOT_RUNTIME_MODE=mock pnpm --filter @ghost-bot/desktop exec electron dist-electron/main.js` — **pass** (verifies React render, `sandbox: true`, preload IPC `getAppInfo`/`getDaemonHealth`/`listProviders`, and 0 console errors).
- `node scripts/verify-phase-1b-ui.mjs` — **pass** (Playwright UI tests across `1920x1080`, `1440x900`, `1366x768`, `960x640` + IME guard + modal focus trap/Escape + reload persistence + 6 screenshots in `design/reviews/phase-1b/`, 0 console errors).

## Phase 2D recovery and Fedora packaging

- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Run the Phase 1B, 1C, 1D, 2A and 2C UI scripts and the persistence, 1D, 2A and 2D Electron scripts from `scripts/`.
- Build with `pnpm package:appimage`. Smoke-test the result with a fresh private `GHOST_BOT_DATA_DIR`, `GHOST_BOT_RUNTIME_MODE=mock`, `GHOST_BOT_SMOKE_EXIT=1`, and `APPIMAGE_EXTRACT_AND_RUN=1`.
- On Fedora with RPM 6, use `USE_SYSTEM_FPM=true pnpm package:rpm` with FPM 1.18.0 on PATH. The electron-builder bundled FPM 1.9.3 requires `libcrypt.so.1` and its buildroot layout is incompatible with the host RPM 6.1.0. Query the resulting package and smoke-test its extracted application without installing it.
- The live Codex probe consumes subscription quota. Confirm a fresh run budget and distinguish reconnect/inspection from proof of provider-side continuation.
