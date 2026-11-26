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
- File imports use Electron `dialog.showOpenDialog` in `apps/desktop/electron/main.ts` (`ghost:knowledge:docs:pick-and-ingest`), passing `allowedRootDir = dirname(realChosen)` to `KnowledgeIngestionPipeline.ingestFile()` (`O_RDONLY | O_NOFOLLOW`).
- Replacing a document creates a new revision (`revisionNumber + 1`), updates `current_revision_id`, and deletes superseded `knowledge_chunks_fts` entries; `resolveCitation` fails closed for superseded, archived, deleted, or unauthorized citations.
- Deleting a bot (`DELETE /bots/:id`) atomically archives bot-scoped Knowledge documents and collections via `archiveKnowledgeForBotInTx()` while preserving user-wide and shared workspace documents.

## 4. Preferences, Combined Context Budget & Runtime Matrix

- Added `KnowledgeSettingsSchema` and `KnowledgeSettingsPatchSchema` (`enabled: true`, `automaticRetrieval: false`, `includeUserWide: false`, `externalProviderConsent: false`) independent of `MemorySettingsSchema`.
- `context-assembler.ts` enforces combined hard limits (`maxMemoryBytes: 4096`, `maxKnowledgeBytes: 8192`, `maxCombinedBytes: 12288`) on the final serialized `untrusted_execution_reference_data` JSON envelope.
- `run.started` events store bounded `attachedSources` metadata (`documentId`, `revisionId`, `chunkId`, `title`) without full chunk text; original user `messages` remain unmodified.
- Lexical retrieval only (no embeddings/semantic search). Mock execution and Codex `turn/start.input` protocol fixtures verified offline; OpenClaw and Ollama remain unsupported.

## 5. Performance Benchmark (>500 Chunks)

- 26 synthetic documents (`573` chunks) in isolated SQLite + FTS5: `searchMs: 47.15 ms`, `prepareMs: 41.7 ms`, `totalBytes: 7847` (`selectedDocuments: 1`, `selectedChunks: 4`).
- Synchronous SQLite ranking runs on the daemon event loop; large multi-thousand-document corpora in future phases will require background worker/chunked indexing.
