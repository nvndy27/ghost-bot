# Core.1: Secure Credential Storage & OS Secret Service Integration

- **Branch**: `feat/core1-secure-credentials` (branched from `e1b9233f2dff2546c7b8aac19f1bc7ebe0d941f9`)
- **Migrations**: `0001`–`0012` preserved unchanged (no new migration required; SQLite stores reference metadata only).
- **Live AI inference, external browsing, host desktop control, and `sudo` remain disabled/unused.**

## 1. Credential Architecture Findings
- `createDefaultMcpSecretResolver()` previously threw `MCP_SECRET_UNAVAILABLE` whenever `secretRefs.length > 0`.
- `SqliteMcpRegistry` stores only `McpSecretRef` metadata (`envVar`, `refId`, optional `label`) inside `transport_json` and pins `configFingerprint` + `trustedBinaryDigest` on `approveTrust`.
- Official provider authentication (`~/.config/ghost-bot/codex-profile`, OpenClaw CLI credentials) remains owned by each runtime adapter and was preserved untouched.
- `apps/daemon/src/errors.ts` and `packages/mcp/src/security/redaction.ts` enforce secret redaction across logs, error messages, and protected env vars (`isBlockedEnvVar`).

## 2. SecretStore & OS Secret Service Implementation
- Implemented daemon-owned `SecretStore` in `apps/daemon/src/secrets/store.ts`:
  - `getStatus()`: detects `linux-secret-service` availability, `/usr/bin/secret-tool`, `DBUS_SESSION_BUS_ADDRESS`, and `org.freedesktop.Secret.Collection` `Locked` property via `busctl --user`.
  - `LinuxSecretServiceStore`: stores/replaces secrets via `/usr/bin/secret-tool store` with secret value passed exclusively over `stdin` (never `argv`), resolves via `secret-tool lookup`, and deletes via `secret-tool clear` under `service=ghost-bot.mcp`, `namespace`, `owner_id`, `server_id`, `ref_id`.
  - Fails closed (`McpCredentialError`) when locked or unavailable; never falls back to plaintext files, SQLite, env persistence, or reversible obfuscation.
  - `InMemoryTestSecretStore`: explicitly test-only deterministic store with `setLocked()` and `setAvailable()`.
  - `UnavailableSecretStore`: explicit fail-closed store.

## 3. MCP `secretRefs` Integration & Redaction
- Wired `SecretStore` into `McpService` and `createDefaultMcpSecretResolver(secretStore)` in `apps/daemon/src/mcp/service.ts`:
  - Rejects secret resolution for untrusted, disabled, or fingerprint-mismatched servers (`MCP_UNTRUSTED`).
  - Scopes every coordinate to `{ ownerId: server.scope.userId, serverId: server.id, refId }`, preventing cross-owner and cross-server resolution.
  - Rejects protected env vars (`isBlockedEnvVar`) and rolls back SQLite `secretRefs` if keyring storage fails.
  - Injects resolved secrets only into the MCP subprocess `env` at launch (`McpConnectionManager.connect()`); missing/locked/unavailable secrets abort server launch (`MCP_SECRET_UNAVAILABLE`).
  - Cleans up keyring entries when deleting a secret reference or deleting an MCP server.

## 4. Desktop Credential Management
- Added daemon HTTP routes (`GET /secrets/status`, `GET /mcp/servers/:id/secrets`, `PUT /mcp/servers/:id/secrets`, `DELETE /mcp/servers/:id/secrets/:refId`) in `apps/daemon/src/server.ts`.
- Added strict Zod IPC schemas and preload bridge methods (`getSecretStoreStatus`, `listMcpServerSecrets`, `setMcpServerSecret`, `deleteMcpServerSecret`) in `packages/shared-types/ipc.ts`, `apps/desktop/electron/preload.cts`, and `apps/desktop/electron/main.ts`.
- No `readSecret` IPC exists; secret values are never displayed in UI or returned by daemon/IPC responses.
- Extended `apps/desktop/src/components/McpSettingsSection.tsx` with OS keyring status banner, per-server reference metadata list, masked password input (`autoComplete="off"`, cleared immediately on submit/cancel/unmount), replace flow, and delete confirmation.

## 5. Actual Keyring vs Mock Verification
- **Real OS Secret Service (`linux-secret-service`)**:
  - Verified in `tests/core1-secure-credentials.test.ts` (under isolated `core1-test-*` namespace): `store`, `exists`, `resolve`, `replace`, `delete`, and cleanup.
  - Verified end-to-end in `scripts/verify-core1-credentials-desktop.mjs` (Electron UI → IPC → Daemon → `secret-tool` / `oo7-daemon`): keyring status display, add `MCP_FIXTURE_API_KEY` (`gh-pat-1`), replace, trust approval + enable + real STDIO MCP connect (`ready`), and delete with confirmation.
- **Mock / Test-Only (`InMemoryTestSecretStore` & `UnavailableSecretStore`)**:
  - Verified locked-state fail-closed, unavailable fail-closed, cross-owner and cross-server rejection, trust revocation blocking secret resolution, and SQLite metadata-only persistence.

## 6. Scoped Skills & Terminal Readiness Review (Read-Only Inventory)
- **Current state**:
  - Runtime-native tool/command execution exists inside `CodexAppServerAdapter` (`item/commandExecution/requestApproval`, `excludeSlashTmp: true`, workspace sandbox policies).
  - Ghost Bot UI currently has only mock placeholders (`apps/desktop/src/data/mockWorkspace.ts`: `{ id: 'tl-2', name: 'Terminal', kind: 'terminal', note: 'mock' }`) and no Ghost Bot-owned terminal PTY, skill registry, or host shell execution IPC.
- **Recommended next scope (Core.2 — Scoped Terminal & Skills)**:
  - **Terminal**: Daemon-owned `node-pty` / `child_process` session manager scoped strictly to a single canonicalized bot workspace (`realpath`, no `~` or `/` root, no shell-escaped arbitrary host bridge), with `read-only` blocked, `ask-approval` per-command approval (`argsHash` + `cwd` + expiry), bounded PTY/scrollback output, SIGTERM/SIGKILL cancellation + process-group cleanup, and secret redaction.
  - **Skills**: Daemon-owned read-only skill manifest discovery from explicit workspace/app directories with SHA-256 content pinning, explicit user trust approval before activation, and zero implicit elevation into `baseInstructions` or unsandboxed shell execution.

## 7. Verification Evidence (Post-Final-Edit)
- `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build`: **PASS** (11/11 projects).
- **3 consecutive full-workspace regression runs**: **209/209** per run (`root` 116, `@ghost-bot/teams` 20, `@ghost-bot/scheduler` 17, `@ghost-bot/computer-use` 16, `@ghost-bot/memory` 14, `@ghost-bot/knowledge` 12, `@ghost-bot/mcp` 14; 0 failed, 0 skipped).
- **Electron E2E & IPC scripts**: `verify-core1-credentials-desktop.mjs`, `verify-cu4-computer-use-ipc.mjs`, `verify-cu5-computer-use-desktop.mjs`, `verify-phase-5b-scheduler-ipc.mjs`, `verify-phase-5c-routines-desktop.mjs`, `verify-phase-4d3-teams-acceptance.mjs`, `verify-phase-2e-acceptance.mjs` **PASS**.
- **MCP concurrency stress (4 parallel workers)**: Verified next.
