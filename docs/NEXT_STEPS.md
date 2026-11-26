# Next steps

## Phase 3D.3 — MCP Foundation Integration

1. Add coordinated migration `0007_mcp_core` for `mcp_servers` (storing configuration and opaque `secretRefs` only, never raw secrets).
2. Wire `@ghost-bot/mcp` behind daemon-owned `McpService`, `HostMcpPolicyAdapter` in `RuntimePolicyBroker`, and durable approval binding in `RunOrchestrator`.
3. Follow with Phase 3D.4 (Integrated End-to-End Acceptance).

## Earlier Phase 3D.2 plan (Completed)

1. Add coordinated migration `0006_knowledge_core` for `knowledge_collections`, `knowledge_documents`, `knowledge_document_revisions`, `knowledge_chunks`, and `knowledge_chunks_fts`.
2. Wire `@ghost-bot/knowledge` behind a daemon-owned `KnowledgeService` with `buildValidatedKnowledgeContext` at the dispatch boundary and document management UI.
3. Follow with Phase 3D.3 (MCP Foundation) and Phase 3D.4 (Integrated End-to-End Acceptance).

## Earlier Phase 3D.1 plan (Completed)

1. Design and apply SQLite migration `0005+` for daemon-owned Memory integration while preserving `0001`–`0004` compatibility.
2. Wire `@ghost-bot/memory` into `apps/daemon` with explicit consent boundaries, `RuntimePolicyBroker` enforcement, and typed IPC in `packages/shared-types/ipc.ts`.
3. Follow with Phase 3D.2 (Knowledge & Retrieval), Phase 3D.3 (MCP Foundation), and Phase 3D.4 (Integrated End-to-End Acceptance).

## Earlier Phase 2E plan (Completed)

1. Build and verify the Fedora RPM package (`pnpm package:rpm`) in an environment with `libcrypt.so.1` (`libxcrypt-compat`) or system `fpm` (`USE_SYSTEM_FPM=true`).
2. Complete remaining Phase 2 items: OpenClaw Gateway adapter (if verified), optional local Ollama adapter, and usage source/reset timestamp polish.
3. Keep `full-access` (`dangerFullAccess`) and persistent `Approve Always` gated until explicit verification.

## Earlier Phase 2 plan

Phase 1 (1A–1D) Desktop Foundation is **Verified** and ready for acceptance review. Next milestone: **Phase 2 — Functional MVP**:

1. Wire live chat execution (`runs.start`, `runs.cancel`, `approvals.resolve`) through the daemon `RuntimePolicyBroker` and `CodexAppServerAdapter` (preserving `read-only`, `ask-approval`, and `workspace` sandboxing with `excludeSlashTmp: true`).
2. Persist sessions, runs, run events (`RuntimeEventV1` with monotonic `seq`), and messages transactionally in SQLite (`apps/daemon/src/db/`).
3. Surface real tool activity, approval requests, diff previews, and cancellation in the desktop workspace.
4. Implement native OpenClaw Gateway WebSocket adapter and optional local Ollama adapter after live verification.

Start with [progress](PROGRESS.md), [protocol](PROTOCOL.md), and [provider matrix](PROVIDER_MATRIX.md).
