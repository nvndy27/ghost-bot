# Phase 3D.2 — Production Knowledge & Retrieval Integration

Date: 2026-11-26  
Branch: `feat/phase-3d2-knowledge-integration`  
Base checkpoint: `ac4f80d` (Phase 3D.1 closure gate)

## 1. Phase 3D.1 Closure-Gate Evidence

- Added trusted server-side `AgentRequest.prepareReferenceContext?: () => Promise<string | undefined>` (`packages/shared-types/runtime.ts`, never exposed via IPC), invoked inside `CodexAppServerAdapter.run()` (`packages/runtime-adapters/codex/codex-app-server.ts`) after `requireVerifiedChatGptAccount()`, `canonicalizeWorkspace()`, and `ensureInitialized()`, immediately before the `active.cancelled` check and `turn/start` transmission.
- Verified with deterministic barrier tests in `tests/phase-3d1-memory.test.ts` (consent revocation, retrieval disable, update, archive, delete, and cancel).

## 2. Production Schema & Ownership (`0006_knowledge_core`)

- Added migration `0006_knowledge_core` in `apps/daemon/src/db/migrations.ts` and Drizzle definitions in `apps/daemon/src/db/schema.ts`.
- Creates `knowledge_collections`, `knowledge_documents` (`collection_id REFERENCES knowledge_collections(id) ON DELETE RESTRICT`, `bot_id REFERENCES agents(id) ON DELETE RESTRICT`), `knowledge_document_revisions` (`ON DELETE CASCADE`), `knowledge_chunks` (`ON DELETE CASCADE`), and `knowledge_chunks_fts` (`USING fts5(..., tokenize='unicode61 remove_diacritics 2')`).
- Added `createBorrowedKnowledgeDatabaseHandle()` (`packages/knowledge/src/storage/sqlite-client.ts`) so `KnowledgeService.close()` detaches without closing the daemon's `DatabaseSync`.

## 3. Trusted Authorization, File Ingestion & Revisions

- `KnowledgeService` (`apps/daemon/src/knowledge/service.ts`) constructs `KnowledgeAuthContext` exclusively in the daemon from `LOCAL_USER_ID`, `agents` ownership, and `realpath(workspace_path)` (`deriveWorkspaceId`).
- Supports `direct_text`, UTF-8 `.txt`, and `.md`/`.markdown`; rejects `.pdf`, `.docx`, symlinks, hardlinks, traversal, and credentials.
- File imports use Electron `dialog.showOpenDialog` in `apps/desktop/electron/main.ts` (`ghost:knowledge:docs:pick-and-ingest`), enforcing `lstat`/`fstat` (`isFile()`, `!isSymbolicLink()`, `nlink <= 1`, `O_RDONLY | O_NOFOLLOW`, `<= 2 MiB`) and sending bounded base64 bytes to `POST /knowledge/documents/ingest-bytes` (`KnowledgeService.ingestAuthorizedBytes`). No arbitrary `allowedRootDir`/`filePath` daemon route is exposed.
- Collection assignments (`ingestText`, `ingestAuthorizedBytes`, `updateDocument`) verify `collection_id` is `active` and matches the document's `scope_key` (`assertCollectionMatchesScope`).
- Replacing a document creates a new revision (`revisionNumber + 1`), updates `current_revision_id`, and deletes superseded `knowledge_chunks_fts` entries; `resolveCitation` fails closed for superseded, archived, deleted, or unauthorized citations.
- Deleting a bot (`DELETE /bots/:id`) atomically archives bot-scoped Knowledge documents and collections via `archiveKnowledgeForBotInTx()` while preserving user-wide and shared workspace documents.

## 4. Preferences, Combined Context Budget & Runtime Matrix

- Added `KnowledgeSettingsSchema` and `KnowledgeSettingsPatchSchema` (`enabled: true`, `automaticRetrieval: false`, `includeUserWide: false`, `externalProviderConsent: false`) independent of `MemorySettingsSchema`.
- `context-assembler.ts` enforces combined hard limits (`maxMemoryBytes: 4096`, `maxKnowledgeBytes: 8192`, `maxCombinedBytes: 12288`) on the final serialized `untrusted_execution_reference_data` JSON envelope.
- `run.started` defers context attribution (`contextTiming: 'deferred_to_dispatch'`), and `run.context_prepared` is appended inside `CodexAppServerAdapter.run()`'s `prepareReferenceContext` only after final revalidation and cancellation checks; `attachedSources` stores bounded metadata (`documentId`, `revisionId`, `chunkId`, `title`) without full chunk text, and original user `messages` remain unmodified.
- Lexical retrieval only (no embeddings/semantic search). Mock execution and Codex `turn/start.input` protocol fixtures verified offline; OpenClaw and Ollama remain unsupported.

## 5. Performance Benchmark (>500 & 2500 Chunks)

- `573` chunks (26 synthetic documents) in isolated SQLite + FTS5: `searchMs: 44.04 ms`, `prepareMs: 36.95 ms`, `totalBytes: 7847` (`selectedDocuments: 1`, `selectedChunks: 4`).
- `2501` chunks (100 synthetic documents with Vietnamese `đ/Đ`, emoji, quotes): `searchMs: 255.35 ms` (`matches: 20`).
- Limitation: synchronous SQLite ranking runs on the daemon event loop; multi-thousand-document corpora in future phases will require bounded worker offloading.

## 6. Phase 3D.3 MCP Readiness Prerequisites

- Next migration: `0007_mcp_core` (`mcp_servers` table with `bot_id REFERENCES agents(id) ON DELETE RESTRICT`, `config_fingerprint`, `trusted_fingerprint`, `trusted_binary_digest`, and opaque `secretRefs` only).
- Borrowed handle: `createBorrowedMcpDatabaseHandle()` in `@ghost-bot/mcp` so `McpService.close()` never closes daemon `DatabaseSync`.
- Policy & approvals: `HostMcpPolicyAdapter` inside `RuntimePolicyBroker` (`apps/daemon/src/runtime/policy-broker.ts`), durable `approvals` binding (`serverId`, `configFingerprint`, `trustedBinaryDigest`, `capabilityKey`, `definitionHash`, `argsHash`), OS keyring resolution in daemon only, immediate subprocess disconnect on `revokeTrust`/`disable`/`delete`, and exact-version verification of whether Codex `0.172.0` supports MCP server/tool injection before wiring live Codex tool calls.
