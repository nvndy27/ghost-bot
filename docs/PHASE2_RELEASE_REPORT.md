# Ghost Bot v0.1.0 — Phase 2 Functional MVP Release Acceptance Report

Date: 2026-11-26  
Branch: `feat/phase-2e-functional-mvp` (base `main` `4489f2b`)  
Verdict: **CONDITIONAL PASS** (core Codex MVP, OpenClaw/Ollama adapters, usage polish, AppImage packaging, and security gates verified; Fedora RPM build blocked on host by missing `libcrypt.so.1`, live OpenClaw/Ollama inference not executed without authorization)

## 1. Supported Operating Systems & Installation
- **Target OS**: Fedora Linux / x86_64 (`7.2.11-300.fc45.x86_64` tested).
- **AppImage (Verified via `APPIMAGE_EXTRACT_AND_RUN=1`)**:
  - Artifact: `apps/desktop/release/GhostBot-0.1.0-x86_64.AppImage`
  - Size: `121058150` bytes (`116M`)
  - SHA-256: `f41c1621a07102eb28e85d5727f4416e42c2ce101507664ecf08cb90a6b77e652`
  - Signing: Unsigned local release candidate build (`--publish never`).
  - Launch fallback (Fedora 45 without `libfuse.so.2`):
    ```bash
    APPIMAGE_EXTRACT_AND_RUN=1 ./GhostBot-0.1.0-x86_64.AppImage
    ```
  - Native FUSE launch: **NOT VERIFIED** (host lacks `libfuse.so.2`). Never use `--no-sandbox`.
- **Fedora RPM (`pnpm package:rpm`)**:
  - **Blocked** on host because `electron-builder@26.0.12` bundled `fpm` requires `libcrypt.so.1` (`libxcrypt-compat`, not installed) and `fpm` is not on `PATH` (confirmed `docker.io/library/fedora:45` also has `libcrypt.so.2` only).
  - Reproducible build procedure (requires explicit human authorization on build host):
    ```bash
    sudo dnf install -y libxcrypt-compat
    pnpm package:rpm
    ```

## 2. Official Runtime Authentication Setup
- **OpenAI Codex App Server (`0.172.0`)**:
  - Dedicated isolated profile: `~/.config/ghost-bot/codex-profile` (`0700` dir, `0600` `auth.json`). Never touches `~/.codex` and strips `OPENAI_API_KEY` / `CODEX_API_KEY`.
  - Sign in manually: `CODEX_HOME=~/.config/ghost-bot/codex-profile codex login --device-auth`.
- **OpenClaw Gateway (`2026.11.8 (2d4ab29)`)**:
  - Connects only to loopback `ws://127.0.0.1:18789` via CLI-managed Gateway auth (`--expect-url`). Gateway auth does not imply upstream subscription auth; live execution remains gated.
- **Ollama Local (Optional)**:
  - Connects only to loopback `http://127.0.0.1:11434`. Never auto-starts `ollama` or auto-downloads models.

## 3. Supported Provider Capability Matrix
| Provider | Discovery / Auth | Streaming / Cancel | Tools / Approvals | Permission Modes | Status |
|---|---|---|---|---|---|
| OpenAI Codex (`0.172.0`) | ChatGPT subscription (`plus` verified) | Verified | Verified (`Approve once` / `Deny`) | `read-only`, `ask-approval`, `workspace` (`full-access` disabled) | **Verified** |
| OpenClaw Gateway (`2026.11.8`) | Loopback `health`, `status`, `models.list` verified | Protocol fixture verified | Protocol fixture verified | Metadata-only (`live execution gated`) | **Metadata Verified / Execution Gated** |
| Ollama Local | Loopback `/api/version`, `/api/tags` | HTTP NDJSON fixture verified | Not supported (`supportsTools: false`) | `read-only` only | **Optional / Unavailable on host** |
| Mock Runtime | Offline UI preview | Deterministic mock | Mock approval cards | Preview only | **Verified (Offline Preview)** |

## 4. Permission-Mode Limitations & Security Acceptance
- `full-access` (`dangerFullAccess`) and persistent `Approve Always` remain disabled across Zod IPC schemas, daemon routes, and `RuntimePolicyBroker`.
- `JsonRpcClient.close()` waits for child process `close` / `exitInfo` and rejects with `TRANSPORT_ERROR` if the process fails to terminate after `SIGKILL`.
- `RuntimeRegistry.closeOwnedClient()` throws `RUNTIME_TERMINATION_FAILED` on close failure, preserving durable `sessionsWithUnconfirmedStop` quarantine (`execution.quarantinedSessions.v1`) across restarts.
- `reconcileOnStartup()` reconstructs quarantine if an active `cancelling` run is interrupted by abrupt daemon termination.
- `retryRun()` enforces `RETRY_CONFIRMATION_REQUIRED` (`confirmSideEffects: true`) and two-step UI confirmation when `hasToolActivityForRun()` is true.
- `inspectSession()` validates `accountKey` ownership and live Codex `thread/read` accessibility.
- Electron enforces `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP (`default-src 'self'`), narrow preload allowlist, `WebContents` + `mainFrame` validation, and `0700`/`0600` data/socket permissions.

## 5. Data Storage Locations & Recovery Behavior
- **SQLite DB**: `${GHOST_BOT_DATA_DIR:-$XDG_CONFIG_HOME/ghost-bot}/ghost-bot.sqlite` (`0600` inside `0700` dir), migrations `0001`–`0004`, `PRAGMA foreign_keys = ON`.
- **Daemon Runtime Dir**: `/run/user/<uid>/ghost-bot-rt-*` (`0700`) with `0600` Unix socket + Bearer auth.
- **Recovery**: Interrupted runs transition to `interrupted` on startup with partial `message.delta` reconstruction and pending approval revocation; unconfirmed stops remain quarantined until `reconnectRuntime()` positively terminates the owned runtime or user starts a `New chat`.

## 6. Performance Measurements (`scripts/verify-phase-2e-acceptance.mjs`)
Measured on Linux `x64`, Node `v24.22.3`, `12` CPUs, isolated temp `GHOST_BOT_DATA_DIR`, mock runtime:
- Cold startup: `1587 ms`
- Warm startup: `1576 ms`
- Daemon `VmRSS`: `186 MB`
- Deterministic streaming turn: `204 ms`
- Runtime metadata refresh: `4 ms`
- Conversation history load: `7 ms`
- Clean shutdown: `2790 ms`

## 7. Track B (Phase 3) Integration Handoff
- **Stable Execution Interfaces**: `RunOrchestrator` (`apps/daemon/src/execution/orchestrator.ts`), `RuntimeRegistry` (`apps/daemon/src/runtime/registry.ts`), `RuntimePolicyBroker` (`apps/daemon/src/runtime/policy-broker.ts`), and `AgentRuntime` (`packages/shared-types/runtime.ts`).
- **Daemon Persistence Ownership**: `@ghost-bot/daemon` owns SQLite (`openGhostBotDatabase`, migrations `0001`–`0004`); Phase 3 memory/retrieval/MCP tables must be added via sequential migrations (`0005+`) without modifying `0001`–`0004`.
- **Policy & Event Boundaries**: All tool/MCP executions must pass through `RuntimePolicyBroker`, emit redacted `RuntimeEventV1` via `RunEventStore`, and bind approvals to `runId`, `argsHash`, `runtimeGeneration`, and `expiry`.
- **Session & Account Identity**: Keyed by `(session.id, agent_id, runtime_id, account_id, external_session_id)`; Track B must scope memory/retrieval per `agent_id` and `session_id` to prevent cross-agent leaks.
- **Shared Dependencies**: `pnpm-lock.yaml` includes `electron-builder@26.0.12` in `@ghost-bot/desktop`; Track B should rebase onto `feat/phase-2e-functional-mvp` (once merged) and preserve existing lockfile pins.
