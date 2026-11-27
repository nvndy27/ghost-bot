# Phase 3D Integration Handoff — Memory, Knowledge, and MCP Foundations

Status: **Documentation-only handoff** (Track B extensions ready for coordinated Phase 3D integration with Track A `main @ 4489f2b`).

## 1. Accepted Extension Commits & Public APIs

| Package | Branch | Accepted Commit | Public Entrypoint |
|---|---|---|---|
| `@ghost-bot/memory` | `feat/phase-3a-memory-core` | `2ab3d67` | `packages/memory/src/index.ts` |
| `@ghost-bot/knowledge` | `feat/phase-3b-knowledge-retrieval` | `4d3f5c3` | `packages/knowledge/src/index.ts` |
| `@ghost-bot/mcp` | `feat/phase-3c-mcp-foundation` | `e82fb1d` (pending closure commit) | `packages/mcp/src/index.ts` |

## 2. Production Database Migrations Required

Track A `main @ 4489f2b` is at migration `0004_durable_approvals` (`apps/daemon/src/db/migrations.ts`, `schema.ts`).
Phase 3D must add coordinated migrations starting at `0005+`:
- `0005_memory_and_knowledge`: create `memories`, `memories_fts`, `knowledge_collections`, `knowledge_documents`, `knowledge_document_revisions`, `knowledge_chunks`, `knowledge_chunks_fts` with `ON DELETE RESTRICT` / `ON DELETE CASCADE` foreign keys to `agents.id` where appropriate.
- `0006_mcp_servers`: create `mcp_servers` (storing configuration + opaque `secretRefs` only, never raw secrets or tool outputs).

## 3. Daemon Ownership, Authorization & Context-Use Boundaries

- **Daemon-Constructed Auth**: `apps/daemon` must construct `MemoryAuthContext`, `KnowledgeAuthContext`, and `McpAuthContext` exclusively from authenticated IPC/HTTP session, bot, and canonical workspace ownership — never from renderer-supplied identity fields.
- **Knowledge Revalidation**: Always call `buildValidatedKnowledgeContext(repo, auth, candidates, options, clock)` at the prompt-assembly boundary so documents archived, deleted, or superseded after retrieval are excluded.
- **Memory Revalidation**: Re-check scope, `allowUserWideRead`, `status === 'active'`, and `expiresAt > now` via `buildMemoryContext` at the prompt-assembly boundary.

## 4. `RuntimePolicyBroker`, Approvals & `RunOrchestrator` Integration

- **Policy Adapter**: Implement `HostMcpPolicyAdapter` inside `RuntimePolicyBroker` (`apps/daemon/src/runtime/policy-broker.ts`) so MCP launches and tool invocations respect the active `PermissionMode` (`read-only`, `ask-approval`, `workspace`) and keep `full-access` disabled.
- **Durable Approval Binding**: Route MCP tool invocations requiring approval through `RunOrchestrator` (`apps/daemon/src/execution/orchestrator.ts`) and `approvals` (`0004_durable_approvals`), binding each approval to: `serverId`, `configFingerprint`, `trustedBinaryDigest`, `capabilityKey`, `definitionHash`, and canonical `argsHash`.
- **Revocation**: Calling `revokeTrust`, `disable`, `delete`, or `update` on `SqliteMcpRegistry` in the daemon immediately disconnects the owned MCP subprocess via `McpConnectionManager`. Already-dispatched external tool calls retain `uncertainOutcome: true`.
- **Credential Resolution**: Resolve `secretRefs` solely inside the daemon via OS Secret Service / keyring before passing `resolvedSecrets` to `McpConnectionManager`. Never expose resolved secrets to renderer IPC or logs.

## 5. OS Isolation & Subprocess Trust Limitations

- `shell: false`, minimal `env`, and `validateStdioLaunchPaths` are **not** OS sandboxing: local MCP subprocesses execute with the parent user's OS privileges.
- Desktop UI must display explicit consent warnings before trusting local MCP executables, and `trustedBinaryDigest` does not verify transitive `node_modules` or shared-library dependency chains.

## 6. Dependency-Security Upgrade Requirement (`GHSA-mrhx-c7xc-m3w5`)

- All packages currently share `zod@3.25.76`. `corepack pnpm audit --prod` flags `zod < 4.6.6` (`GHSA-mrhx-c7xc-m3w5`).
- Upgrading to `zod >= 4.6.6` in Phase 3D will also allow upgrading `@modelcontextprotocol/sdk` to v2 (`@modelcontextprotocol/client@2.4.0`, spec `2026-07-28`), but requires coordinated testing across `packages/shared-types/ipc.ts`, `apps/daemon`, `apps/desktop`, `packages/memory`, `packages/knowledge`, and `packages/mcp` due to Zod v3 -> v4 schema/error-format breaking changes.

## 7. Shared Files Likely to Conflict & Required Acceptance Tests

- **Conflict hotspots**: `apps/daemon/src/db/schema.ts`, `apps/daemon/src/db/migrations.ts`, `apps/daemon/src/server.ts`, `apps/daemon/src/execution/orchestrator.ts`, `apps/daemon/src/runtime/policy-broker.ts`, `packages/shared-types/ipc.ts`, `apps/desktop/electron/main.ts`, `apps/desktop/src/components/SettingsModal.tsx`, `pnpm-lock.yaml`, `docs/ROADMAP.md`, `docs/PROGRESS.md`.
- **Required Phase 3D tests**: End-to-end Electron → IPC → Daemon → Memory/Knowledge/MCP persistence & approval tests, cross-bot/cross-workspace isolation tests, stale-knowledge revalidation tests, MCP revocation/crash recovery tests, and `pnpm lint && pnpm typecheck && pnpm build && pnpm test`.
