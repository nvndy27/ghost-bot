# Next steps

## Provider.4 — Google Gemini API Integration (Completed Offline / Execution Gated)

1. When explicitly authorized for live API testing, configure a Gemini API key in Settings -> Accounts & Providers and run the 2-request bounded live acceptance procedure in `docs/extensions/provider4-gemini-api.md`.
2. Proceed to **Provider.5: Moonshot Kimi ACP Integration** (protocol-tested offline with `kimi` CLI availability check and strict ACP framing/approval boundaries).

## Provider.3 — Anthropic Claude API Integration (Completed Offline / Execution Gated)

1. When explicitly authorized for billed API testing, configure an Anthropic API key in Settings -> Accounts & Providers and run the bounded one-turn live acceptance procedure in `docs/extensions/provider3-claude-api.md`.
2. Proceed to Google Gemini API-key integration (`Provider.4`) using the same isolated provider credential namespace, official `generativelanguage.googleapis.com` endpoint pinning, and explicit opt-in gates.

## Provider.2 — Ollama Local Runtime Production Integration (Completed Offline / Host Prerequisite Open)

1. Install Ollama locally and pull a lightweight local model (e.g., `qwen2.5:1.5b` or `llama3.2:1b` for the host's 13 GiB RAM / 4.9 GiB available / RTX 3050 Mobile) when explicitly authorized.
2. Run the bounded one-turn local inference acceptance procedure in `docs/extensions/provider2-ollama-local.md`.
3. Proceed to the next provider milestone (e.g., Anthropic Claude / Google Gemini API-key opt-in or Kimi ACP if CLI is installed).

## Phase 3D.4 — Integrated End-to-End Acceptance

1. Verify combined Memory + Knowledge + MCP production workflows in Electron and daemon regression suites on the integrated branch.
2. Verify Linux AppImage & Fedora RPM packaging builds and smoke launches on the integrated codebase.
3. Confirm release-candidate security sign-off (noting OS Secret Service keyring stub status for `secretRefs` and `unsupported_native_mcp` for Codex `0.172.0` / opt-in live verification requirements) before merging to `main`.

## Earlier Phase 3D.3 plan (Completed)

1. Add coordinated migration `0007_mcp_core` for `mcp_servers` (storing configuration and opaque `secretRefs` only, never raw secrets) and `mcp_approval_bindings`.
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
