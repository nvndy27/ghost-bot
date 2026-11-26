# Phase 3D.3 — Production MCP Integration

**Status:** Implemented (verification in progress)  
**Branch:** `feat/phase-3d3-mcp-integration` (descended from `9b6ba1b`)

## Architecture & Ownership

- **Borrowed Database Handle (`@ghost-bot/mcp`):** `createBorrowedMcpDatabaseHandle(sqlite, options)` lets the daemon share its single SQLite database connection (`ghost-bot.sqlite`) with `SqliteMcpRegistry` without opening a competing connection or running standalone migrations.
- **Production Migration (`0007_mcp_core`):** Adds `mcp_servers` (`bot_id REFERENCES agents(id) ON DELETE RESTRICT`) and `mcp_approval_bindings` (`approval_id REFERENCES approvals(id) ON DELETE CASCADE`, `server_id REFERENCES mcp_servers(id) ON DELETE CASCADE`), preserving `0001`–`0006`.
- **Daemon Service (`apps/daemon/src/mcp/service.ts`):** `McpService` owns the single `SqliteMcpRegistry` and `McpConnectionManager` instance, constructs trusted `McpAuthContext` (`userId = 'local-user'`, `actorId = 'daemon_mcp'`), enforces `settings.mcp.enabled`, delegates host policy to `RuntimePolicyBroker.createMcpPolicyAdapter(permissionMode)`, pins executable/script SHA-256 digests upon trust approval, fails closed when `secretRefs.length > 0` without an explicit `McpSecretResolver`, caches per-generation `McpCapabilitySnapshot`s, and archives/tears down bot-scoped servers on `DELETE /bots/:id`.
- **Policy & Durable Execution (`apps/daemon/src/runtime/policy-broker.ts`, `apps/daemon/src/execution/orchestrator.ts`):**
  - `RuntimePolicyBroker.createMcpPolicyAdapter(permissionMode)` blocks local STDIO MCP launch and tool invocation under `full-access`, `read-only`, and `workspace` (since unsandboxed local STDIO MCP runs with daemon user OS privileges and cannot enforce workspace containment or network isolation), permitting `ask-approval` only subject to explicit trust, binary digest pinning, and per-call durable approval.
  - `RunOrchestrator` wires MCP tool execution through `approvals` (`action_type = 'mcp.toolCall'`) + `mcp_approval_bindings` (`dispatch_state`: `pending` -> `dispatched` -> `completed` | `failed` | `uncertain` | `cancelled`), enforcing single-use atomic approval consumption, argument hash verification, config fingerprint matching, capability `definitionHash` matching, connection generation verification, mid-approval trust/config/bot-archival revocation, and frozen `argsJson` dispatch.
  - Native Codex `0.172.0` MCP execution remains disabled (`unsupported_native_mcp`): `codex app-server generate-json-schema` shows `dynamicToolCall` and `mcpServer/tool/call` in `0.172.0`, but `CodexAppServerAdapter` does not implement them and policy-preserving host mediation remains unverified.

## Hardening & Limitations

- **Secret Resolution:** `createDefaultMcpSecretResolver()` is a fail-closed stub (`MCP_SECRET_UNAVAILABLE`) when `secretRefs.length > 0`; OS Secret Service keyring integration is not yet wired in production.
- **IPC Bounds:** `apps/desktop/electron/main.ts` enforces `assertBoundedMcpIpcPayload()` (64 KB, depth 12, 256 array items, 128 object keys) before Zod validation.
- **Cross-Extension Responsiveness:** Measured `searchP95Ms: 21.92 ms` (Knowledge search during pending MCP approval), `healthMemoryP95Ms: 5.66 ms` (`/health` + `/memories` during active `slow_tool`), and `eventLoopP95Ms: 10.43 ms`.
- **Desktop IPC & UI (`packages/shared-types/ipc.ts`, `apps/desktop/electron/*`, `apps/desktop/src/components/McpSettingsSection.tsx`):** Exposes 12 Zod-validated `ghost:mcp:*` IPC channels and replaces the `Tools & MCP` placeholder in `SettingsModal.tsx` with server registration, trust approval/revocation, enable/disable, connect/disconnect, capability inspection, and resource/prompt preview.
