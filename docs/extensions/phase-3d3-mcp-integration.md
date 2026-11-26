# Phase 3D.3 — Production MCP Integration

**Status:** Implemented (verification in progress)  
**Branch:** `feat/phase-3d3-mcp-integration` (descended from `9b6ba1b`)

## Architecture & Ownership

- **Borrowed Database Handle (`@ghost-bot/mcp`):** `createBorrowedMcpDatabaseHandle(sqlite, options)` lets the daemon share its single SQLite database connection (`ghost-bot.sqlite`) with `SqliteMcpRegistry` without opening a competing connection or running standalone migrations.
- **Production Migration (`0007_mcp_core`):** Adds `mcp_servers` (`bot_id REFERENCES agents(id) ON DELETE RESTRICT`) and `mcp_approval_bindings` (`approval_id REFERENCES approvals(id) ON DELETE CASCADE`, `server_id REFERENCES mcp_servers(id) ON DELETE CASCADE`), preserving `0001`–`0006`.
- **Daemon Service (`apps/daemon/src/mcp/service.ts`):** `McpService` owns the single `SqliteMcpRegistry` and `McpConnectionManager` instance, constructs trusted `McpAuthContext` (`userId = 'local-user'`, `actorId = 'daemon_mcp'`), enforces `settings.mcp.enabled`, delegates host policy to `RuntimePolicyBroker.createMcpPolicyAdapter(permissionMode)`, pins executable/script SHA-256 digests upon trust approval, fails closed when `secretRefs.length > 0` without an explicit `McpSecretResolver`, caches per-generation `McpCapabilitySnapshot`s, and archives/tears down bot-scoped servers on `DELETE /bots/:id`.
- **Policy & Durable Execution (`apps/daemon/src/runtime/policy-broker.ts`, `apps/daemon/src/execution/orchestrator.ts`):**
  - `RuntimePolicyBroker.createMcpPolicyAdapter(permissionMode)` blocks local STDIO MCP launch and tool invocation under `full-access` and `read-only`, allowing `ask-approval` and `workspace` subject to trust and per-call durable approval.
  - `RunOrchestrator` wires MCP tool execution through `approvals` (`action_type = 'mcp.toolCall'`) + `mcp_approval_bindings` (`dispatch_state`: `pending` -> `dispatched` -> `completed` | `failed` | `uncertain` | `cancelled`), enforcing single-use atomic approval consumption, argument hash verification, config fingerprint matching, capability `definitionHash` matching, and connection generation verification.
  - Native Codex `0.172.0` MCP execution remains disabled (`unsupported_native_mcp`) because `CodexAppServerAdapter` has no verified host-mediated dynamic tool / per-turn MCP protocol contract.
- **Desktop IPC & UI (`packages/shared-types/ipc.ts`, `apps/desktop/electron/*`, `apps/desktop/src/components/McpSettingsSection.tsx`):** Exposes 12 Zod-validated `ghost:mcp:*` IPC channels and replaces the `Tools & MCP` placeholder in `SettingsModal.tsx` with server registration, trust approval/revocation, enable/disable, connect/disconnect, capability inspection, and resource/prompt preview.
