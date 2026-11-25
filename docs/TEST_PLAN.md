# Test plan

Offline default: unit tests for JSON-RPC correlation, concurrent out-of-order responses, streaming notifications, server-initiated requests, timeouts, cancellation, process crashes, malformed payload rejection, adapter normalization, unknown quota (`null`) handling, permission mode mapping, `argsHash`/expiry approval guards, and path/sandbox policies; SQLite migration/restart and idempotency (Phase 1); UI Playwright for create bot, avatar, model selection, settings, approval, cancellation, theme and keyboard (Phase 1). Mock data clearly marked.

Opt-in integration: Codex dedicated ChatGPT profile (`node scripts/verify-codex-live.mjs --login-only` then `node scripts/verify-codex-live.mjs`); OpenClaw health and gateway probe (`node scripts/probe-openclaw.mjs`, `openclaw gateway probe --json`); Ollama local discovery (`node scripts/probe-ollama.mjs`). No paid requests without explicit opt-in. Redact diagnostics.

## Phase 0 commands and results

- `npm test` — **16/16 offline tests pass** (`tests/phase-zero.test.ts`, `tests/json-rpc-client.test.ts`, `tests/codex-adapter.test.ts`).
- `npm exec --yes --package=typescript@5.9.3 --package=@types/node -c 'tsc --noEmit --strict --module nodenext --target es2022 --allowImportingTsExtensions --typeRoots "$(dirname "$(dirname "$(which tsc)")")/@types" --types node packages/shared-types/*.ts packages/avatar/presets.ts packages/runtime-adapters/json-rpc-client.ts packages/runtime-adapters/codex/codex-app-server.ts tests/*.ts'` — **0 errors** in strict mode.
- `node scripts/verify-codex-live.mjs` — **all live Codex checks pass** on `gpt-6.2-sol` (`chatgpt` `plus` profile): streaming, read-only read, denied write, workspace write, outside-workspace write blocked (`excludeSlashTmp: true`), approval rejection with no side effect, cancellation, and session resume continuity.
- `node scripts/probe-openclaw.mjs` & `openclaw gateway probe --json` — **pass** (`ok: true`, `ws://127.0.0.1:18789`, `operator.read`).
- `node scripts/probe-ollama.mjs` — **blocked** (no local Ollama binary or listener at `127.0.0.1:11434`).

## Phase 1A & 1B commands and results

- `pnpm lint` — **pass** (0 errors across `packages`, `apps`, `tests`).
- `pnpm typecheck` — **pass** across all 5 TypeScript workspace packages.
- `pnpm test` — **25/25 offline tests pass** (Phase 0 + Step 0 hardening + Phase 1A daemon/IPC/security).
- `pnpm build` — **pass** (Vite renderer bundle + Electron main/preload compilation + daemon typecheck).
- `GHOST_BOT_SMOKE_EXIT=1 GHOST_BOT_RUNTIME_MODE=mock pnpm --filter @ghost-bot/desktop exec electron dist-electron/main.js` — **pass** (verifies React render, `sandbox: true`, preload IPC `getAppInfo`/`getDaemonHealth`/`listProviders`, and 0 console errors).
- `node scripts/verify-phase-1b-ui.mjs` — **pass** (Playwright UI tests + 6 screenshots in `design/reviews/phase-1b/`, 0 console errors, 960x640 no-overflow).
