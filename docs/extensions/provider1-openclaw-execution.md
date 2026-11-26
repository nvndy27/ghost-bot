# Provider.1: OpenClaw Gateway Production Execution

- **Branch**: `feat/provider1-openclaw-execution` (branched from `ddc97fcb26ed26b937c723d83df0e925ac4e037f`)
- **Migrations**: `0001`–`0013` preserved unchanged (no migration required).
- **Zero live inference, external browsing, `sudo`, or unauthorized OpenClaw configuration changes performed.**

## 1. Installed OpenClaw Version & Read-Only Gateway Probe
- **CLI & Gateway**: `OpenClaw 2026.11.8 (2d4ab29)` running as systemd user service on loopback `ws://127.0.0.1:18789`.
- **Read-only probes (`openclaw gateway status`, `health`, `status`, `models.list`)**:
  - `health`: `ok: true`, `defaultAgentId: "coordinator"`, loaded plugins include `anthropic`, `browser`, `canvas`, `cua-computer`, `device-pair`, `file-transfer`, `geolocation`, `github`, `linux-node`, `memory-core`, `ollama`, `openai`, `talk-voice`, `xai`.
  - `status`: `runtimeVersion: "2026.11.8"`, `hostDesktop.enabled: false`.
  - `models.list`: 10 configured models (`gpt-6-astra`, `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6.1-terra`) with `thinkingLevels`.

## 2. Adapter Implementation (`packages/runtime-adapters/openclaw/openclaw-gateway.ts`)
- Enforces loopback-only `ws://`/`wss://` URLs (`assertLoopbackGatewayUrl`).
- Pins `SUPPORTED_OPENCLAW_VERSIONS = new Set(['2026.11.8'])`; unsupported versions fail closed (`supportedVersion: false`, `authState.status = 'error'`).
- Parallelizes `health` + `status` in `inspectGateway()`, redacts bearer/token/key patterns in errors, and preserves external Gateway lifecycle on `disconnect()` (never terminates the user's Gateway).
- Hardens `run()` with `MAX_STREAM_BYTES = 2 MiB`, `maxDurationMs` abort timer, `maxAttempts: 1` (zero hidden retries/fallback), `runtimeId` + session binding, duplicate `tool.*` / `approval.requested` deduplication, post-terminal chunk suppression, malformed-chunk `MALFORMED_GATEWAY_EVENT` rejection, `usage.updated` accounting without fabricated quota windows (`getUsage() -> null`), `resumeSession()`, `inspectSession()`, and `cancel()` acknowledgement checks.

## 3. Sandbox, Authorization & Execution Gates (`apps/daemon/src/runtime/policy-broker.ts`)
- `RuntimePolicyBroker.authorizeOpenClawExecution(...)` keeps live OpenClaw execution **gated by default** (`allowed: false`) unless:
  - `openClawExecutionAuthorized === true` (explicit user opt-in),
  - `openClawVersion === '2026.11.8'`,
  - `openClawLoopbackVerified === true`,
  - `requestedPermission !== 'full-access'` (`full-access` always disabled), and
  - For non-`read-only` modes (`ask-approval`, `workspace`), `openClawSandboxVerified === true` (because Ghost Bot's local approval policy does not automatically constrain tools executed inside the external Gateway).

## 4. Desktop & Daemon Integration
- Added `RuntimeRegistry.getOpenClawStatus()`, `GET /openclaw/status`, `IPC_CHANNELS.OPENCLAW_STATUS` (`ghost:openclaw:status`), and `window.ghostBot.getOpenClawStatus()`.
- Updated `SettingsModal.tsx` (`Accounts & Providers` and `Models`) to display live OpenClaw Gateway status, version, auth state, host desktop state, capability badges, gated reason, and discovered models.
- Updated `BotEditorModal.tsx` with `bot-runtime-select` (`mock-offline`, `codex`, `openclaw`) without affecting existing Codex bots/sessions.

## 5. Bounded Live Acceptance Procedure (For Later Explicit User Authorization)
1. Confirm OpenClaw Gateway `2026.11.8` is running on `ws://127.0.0.1:18789` with `hostDesktop.enabled === false`.
2. Select a single test bot configured with `runtimeId: 'openclaw'`, `modelId: 'gpt-6-astra'`, `permission: 'read-only'` (no tool execution), `maxAttempts: 1`, and explicit user authorization (`openClawExecutionAuthorized: true`).
3. Verify expected billing: upstream provider account configured inside OpenClaw Gateway (`openai` / configured provider) will incur up to 1 single-turn inference request (`maxAttempts: 1`, no automatic retries).
4. Submit one short read-only prompt, verify `message.delta`, `usage.updated` (or unknown if omitted), and `run.completed`, then test `cancelRun` on a second bounded prompt and verify `run.cancelled`.

## 6. Verification Evidence
- `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build`: **PASS** (11/11 projects).
- `tests/provider1-openclaw-production.test.ts`: **3/3 PASS**.
- `scripts/verify-provider1-openclaw-desktop.mjs`: **PASS** (`PROVIDER1_OPENCLAW_DESKTOP_E2E_PASSED`).
- 3 consecutive full-workspace regression runs, all 9 Electron E2E/IPC scripts, and 4-worker MCP stress executed in final verification.
