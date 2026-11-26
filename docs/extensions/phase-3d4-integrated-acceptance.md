# Phase 3D.4 — Integrated End-to-End Acceptance Report

**Branch:** `feat/phase-3d4-integrated-acceptance` (descended from `04e324c`)  
**Scope:** Core Engine + Production Memory (`@ghost-bot/memory`) + Production Knowledge (`@ghost-bot/knowledge`) + Production MCP (`@ghost-bot/mcp`) + Linux Packaging (AppImage & Fedora RPM).

## 1. Requirement Disposition Matrix

| Capability | Status | Evidence & Notes |
|---|---|---|
| Single-daemon SQLite (`0001`–`0007`) & borrowed handles | **Implemented and verified** | Fresh + v4/v5/v6 upgrades, `0700`/`0600` permissions, atomic bot archival rollback (`tests/phase-3d4-integrated.test.ts`). |
| Memory management, FTS5/lexical retrieval & consent | **Implemented and verified** | `MemoryService`, `MemorySettingsSection`, `4096`-byte budget, `externalProviderConsent` default `false`. |
| Knowledge ingestion (text/`.txt`/`.md`), citations & retrieval | **Implemented and verified** | `KnowledgeService`, Electron `dialog.showOpenDialog` + `O_NOFOLLOW`, `8192`-byte budget, combined `12288`-byte cap. |
| Local STDIO MCP registry, trust pinning & durable approvals | **Implemented and verified** | `McpService`, `ask-approval`-only `HostMcpPolicyAdapter`, `approvals` + `mcp_approval_bindings`, `verify-phase-3d4-electron.mjs`. |
| MCP resources (`readResource`) & prompts (`getPrompt`) | **Implemented and verified** | Scope, active-bot, and `RuntimePolicyBroker` checks on `/mcp/resources/read` and `/mcp/prompts/get`. |
| Production OS Secret Service keyring for MCP `secretRefs` | **Mandatory and unresolved** | `createDefaultMcpSecretResolver()` fails closed (`MCP_SECRET_UNAVAILABLE`) when `secretRefs.length > 0`; OS keyring wiring deferred to follow-up. |
| Native Codex `0.172.0` MCP tool execution | **Unsupported and safely disabled** | Codex `0.172.0` schema has `dynamicToolCall` / `mcpServer/tool/call`, unimplemented in `CodexAppServerAdapter`; `unsupported_native_mcp` enforced. |
| Live Memory + Knowledge + MCP provider inference probes | **Implemented with incomplete verification** | Offline protocol fixtures & Codex `prepareReferenceContext` barriers verified; live inference turns = `0` (opt-in plan below). |
| Linux AppImage & Fedora RPM packaging | **Implemented and verified** | AppImage (`APPIMAGE_EXTRACT_AND_RUN=1` 2-launch E2E) & native `rpmbuild` RPM (metadata + extracted smoke launch) verified. |
| Multi-agent Teams (Phase 4), Scheduler (Phase 5), Computer Use | **Explicitly deferred** | Isolated in separate feature worktrees; not merged in Phase 3D.4. |

## 2. Opt-In Live Verification Plan (Not Executed)

1. **Codex Memory Context:** `codex` `0.172.0` + ChatGPT `plus` profile, max `1` turn, `read-only`, `externalProviderConsent: true`, synthetic preference string -> verify `turn/start` attaches `untrusted_memory_reference_data` without modifying `baseInstructions`; cleanup via `New chat`.
2. **Codex Knowledge Attribution:** `codex` `0.172.0` + ChatGPT `plus` profile, max `1` turn, `read-only`, `externalProviderConsent: true`, synthetic Markdown doc -> verify `run.context_prepared` citations match prepared chunks; cleanup via delete doc + `New chat`.
3. **Combined Memory + Knowledge:** `codex` `0.172.0` + ChatGPT `plus` profile, max `1` turn, `read-only`, both consents `true` -> verify combined payload `<= 12288` bytes; cleanup via consent revoke + `New chat`.
4. **Native Codex MCP:** **Gated** until a dedicated milestone implements and verifies policy-preserving `dynamicToolCall` / per-turn MCP mediation in `CodexAppServerAdapter`.
