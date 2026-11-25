# Phase 3B — Independent Local Knowledge & Retrieval Engine (`@ghost-bot/knowledge`)

Status: **Implemented & Tested** (Track B — Independent Extensions, branched from `feat/phase-3a-memory-core @ 2ab3d67`).

## 1. Architecture & Relationship to Phase 3A

`@ghost-bot/knowledge` is a standalone, daemon-agnostic, local-first document knowledge and retrieval engine. It complements `@ghost-bot/memory` while keeping the two domain models strictly separate:
- **Memory (`@ghost-bot/memory`)**: Explicit user-saved preferences, facts, and notes.
- **Knowledge (`@ghost-bot/knowledge`)**: Source documents, extracted text, versioned revisions, chunks, FTS5/lexical indexes, structured citations, and bounded reference context.

`@ghost-bot/knowledge` reuses stable public utilities from `@ghost-bot/memory` (`containsCredentialPattern`, `redactSecrets`, `sanitizeErrorMessage`, `foldVietnameseAccents`, `buildSafeFts5MatchQuery`, `normalizeTags`, `computeContentHash`, `normalizeForDeduplication`, and scope/auth schemas) without modifying `@ghost-bot/memory`'s public API or coupling to `apps/daemon`, `apps/desktop`, Electron, or Codex runtime state.

## 2. Package Structure

```text
packages/knowledge/
  package.json
  tsconfig.json
  src/
    index.ts
    contracts/
      errors.ts          # Typed KnowledgeError hierarchy
      limits.ts          # Central KNOWLEDGE_LIMITS & KNOWLEDGE_SCHEMA_VERSION
      schemas.ts         # Strict Zod schemas (.strict())
      types.ts           # Inferred TS types & Clock/IdGenerator
    security/
      authorization.ts   # Scope ownership & visibility enforcement
      path-guard.ts      # Storage 0700/0600 guards & canonical source-file reader
      redaction.ts       # Credential pattern rejection across metadata & text
    extractors/
      text-extractor.ts  # Direct text, UTF-8 text, Markdown (fatal UTF-8, NUL/binary guard)
    chunking/
      chunker.ts         # Deterministic paragraph/heading-aware Unicode chunker
    repository/
      interface.ts       # KnowledgeRepository interface & result types
    storage/
      sqlite-schema.ts   # Isolated SQLite DDL & FTS5 virtual table
      sqlite-client.ts   # node:sqlite DatabaseSync lifecycle & BEGIN IMMEDIATE tx
      sqlite-repository.ts # Persistent repository with revisions, FTS5, & citations
    retrieval/
      lexical.ts         # Query tokenization & Vietnamese-aware chunk scoring
      ranker.ts          # Deterministic ranking, tie-breaking, & overlap suppression
    citations/
      builder.ts         # Bounded revision-aware citations
    context/
      serializer.ts      # JSON untrusted_knowledge_reference_data envelope
      builder.ts         # Pure budget-enforced context assembler
    ingestion/
      pipeline.ts        # 12-step ingestion pipeline (text, bytes, authorized file)
  tests/
    fixtures/
      sample-vn.md
      prompt-injection.md
    unit/
      contracts-and-chunking.test.ts
      context-and-citations.test.ts
    integration/
      ingestion-and-persistence.test.ts
      authorization-and-retrieval.test.ts
      filesystem-and-security.test.ts
```

## 3. Supported and Unsupported Document Formats

- **Supported in Phase 3B**:
  - `direct_text` (`text/plain`): Direct UTF-8 text input.
  - `text_file` (`text/plain`): UTF-8 plain text bytes/files (strict `TextDecoder('utf-8', { fatal: true })`, NUL-byte rejection).
  - `markdown` (`text/markdown`): UTF-8 Markdown with heading hierarchy (`#`–`######`) and line-range tracking.
- **Explicitly Unsupported in Phase 3B**:
  - **PDF (`application/pdf`)** and **DOCX (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)**: Rejected fail-closed with `KnowledgeUnsupportedFormatError` because no offline PDF/DOCX parser is installed or verified in the offline workspace. No fake filename-only storage is performed.
  - **OCR, remote URLs, macros, scripts, embedded attachments**: Not supported and disabled.

## 4. Ingestion Pipeline & Parser Security

`KnowledgeIngestionPipeline` executes:
1. Validate `KnowledgeAuthContext` and target scope write permission.
2. Validate input schemas and `KNOWLEDGE_LIMITS`.
3. Resolve allowlisted format (`direct_text`, `text_file`, `markdown`).
4. For `ingestFile`: canonicalize `allowedRootDir` via `realpath`, reject `..` traversal, symlinks, hardlinks (`nlink > 1`), non-regular files, and enforce `maxDocumentBytes` (2 MiB) both before and during `open(..., O_RDONLY | O_NOFOLLOW)` reading.
5. Decode UTF-8 fatally, strip BOM, normalize `CRLF -> LF`, and `NFC`-normalize Unicode.
6. Reject recognized credential patterns in title, filename, tags, and extracted text.
7. Compute SHA-256 `rawFingerprint` and `extractedFingerprint`.
8. Check scope-bounded duplicate active documents.
9. Produce deterministic chunks (`chunkDocumentText`).
10. Persist document, revision, chunks, and `knowledge_chunks_fts` atomically inside `BEGIN IMMEDIATE`.

**Source-bytes retention policy**: Original raw source bytes are **not** retained in SQLite; only extracted normalized text chunks, SHA-256 fingerprints, and source metadata are persisted.

## 5. Chunking & Source-Location Semantics

- **Paragraph, heading, & fence awareness**: Splits on blank lines and Markdown headings (`#`–`######`) outside fenced code blocks (` ``` ` / `~~~`), maintaining `sectionPath` up to depth 6.
- **Unicode safety**: Direct text rejects unpaired UTF-16 surrogates (`KnowledgeValidationError`) before encoding; oversized paragraphs are split by Unicode code points (`Array.from`) so UTF-16 surrogate pairs (e.g., emoji) are never split mid-character.
- **Bounded overlap**: `0 <= overlapChars < targetChunkChars <= maxChunkChars` prevents infinite loops.
- **Source locations**: `startLine`/`endLine` (1-indexed) and `startChar`/`endChar` (0-indexed **UTF-16 code units** into the **NFC-normalized extracted text**, matching JS `.slice(startChar, endChar)`, not raw file byte offsets). `pageNumber` is `null` (reserved for future PDF support; never fabricated).

## 6. SQLite Schema & Document Lifecycle

Isolated extension-owned tables in `sqlite-schema.ts`:
- `knowledge_schema_meta` (`schema_version = 1`)
- `knowledge_collections` (optional scope-bound organizational folders; not mandated by `ROADMAP.md`, provided for clean multi-doc organization)
- `knowledge_documents` (`status IN ('ready', 'archived')`, `UNIQUE(scope_key, extracted_fingerprint) WHERE status = 'ready'`)
- `knowledge_document_revisions` (immutable revision records per replacement)
- `knowledge_chunks` & `knowledge_chunks_fts` (`unicode61 remove_diacritics 2`)

Lifecycle:
- **Replace (`replaceDocument` / `replaceWithBytes`)**: Atomically creates a new revision (`revisionNumber + 1`), inserts new chunks, replaces FTS entries, and updates `currentRevisionId`. On failure (e.g., credential detected), rolls back and preserves the previous valid revision and FTS index.
- **Archive (`archiveDocument`)**: Marks `status = 'archived'`, deletes FTS entries, and excludes from search and citation resolution.
- **Delete (`deleteDocument`)**: Deletes from `knowledge_documents` (cascading to revisions and chunks) and `knowledge_chunks_fts`. Logical SQLite deletion does not guarantee forensic erasure from SQLite freelist pages, WAL, or filesystem snapshots.

## 7. Authorization, Retrieval, Citations & Context Budgets

- **Authorization**: Same fail-closed model as Phase 3A (`KnowledgeAuthContext` constructed by trusted host/daemon; no implicit user-wide fallback; `allowUserWideRead` never implies `allowUserWideWrite`; unauthorized lookups return `null` or `KnowledgeNotFoundError`).
- **Retrieval**: SQL `WHERE` filters authorized `scope_key`, `user_id`, `status = 'ready'`, and `c.revision_id = d.current_revision_id`, streaming all authorized matching rows via `stmt.iterate()` so exact global ranking is preserved even beyond 500 matching chunks. Supports Vietnamese `NFC`/`NFD`, accent folding, and explicit `đ/Đ -> d/D`.
- **Overlap suppression policy**: Suppresses exact duplicate chunk hashes and chunks with `>= 50%` character-range overlap (`overlapLen / candidateLen >= 0.5`) within the same revision, preserving adjacent chunks with small boundary overlaps (`score DESC, updatedAt DESC, documentId ASC, chunkIndex ASC`). **Note**: Phase 3B implements deterministic lexical retrieval only, not semantic/embedding search.
- **Citations & Stale-Candidate Validation**: `resolveCitation` verifies active `'ready'` status, `revisionId === currentRevisionId`, and scope authorization before returning bounded excerpts (`maxCitationExcerptChars = 280`). Pure `buildKnowledgeContext` operates on caller-supplied snapshots; use `buildValidatedKnowledgeContext(repository, auth, candidates, options, clock)` (or `revalidateKnowledgeCandidates`) at the host/daemon boundary to exclude documents archived, deleted, or superseded after retrieval.
- **Context Builder**: `buildKnowledgeContext` enforces `maxDocuments`, `maxChunks`, `maxChars`, UTF-8 `maxBytes`, and heuristic `maxEstimatedTokens` (`chars_div_4_heuristic`) on the final JSON `untrusted_knowledge_reference_data` envelope (`authority: "none"`). Structural isolation does not guarantee a downstream LLM will ignore malicious text; runtime tool/permission policies must remain independent.
- **Historical revisions & synchronous SQLite**: Historical rows in `knowledge_document_revisions` and `knowledge_chunks` are retained for auditability (while `knowledge_chunks_fts` entries for superseded revisions are deleted on replacement) and removed on `deleteDocument` via `ON DELETE CASCADE`. Because `node:sqlite` (`DatabaseSync`) is synchronous, large batch ingestion in a future daemon should run in a dedicated worker or chunked background task.

## 8. Synthetic Usage Example

```ts
import {
  buildKnowledgeContext,
  KnowledgeIngestionPipeline,
  openKnowledgeDatabase,
  SqliteKnowledgeRepository,
  type KnowledgeAuthContext,
} from '@ghost-bot/knowledge'

const auth: KnowledgeAuthContext = {
  actorId: 'user-demo',
  userId: 'user-demo',
  botId: 'bot-docs',
  workspaceId: 'ws-ghost',
  allowUserWideRead: false,
  allowUserWideWrite: false,
}

const handle = await openKnowledgeDatabase(':memory:')
const repo = new SqliteKnowledgeRepository(handle)
const pipeline = new KnowledgeIngestionPipeline(repo)

pipeline.ingestText(auth, {
  scope: { kind: 'workspace', userId: 'user-demo', workspaceId: 'ws-ghost' },
  title: 'Ghost Bot Architecture',
  sourceType: 'markdown',
  text: '# Storage\n\nUse node:sqlite with WAL mode.',
})

const search = repo.search(auth, { query: 'node:sqlite WAL' })
const ctx = buildKnowledgeContext(
  auth,
  search.items.map((m) => ({ document: m.document, chunk: m.chunk, score: m.score })),
  { maxDocuments: 3, maxChunks: 6, maxChars: 8192, maxBytes: 8192 },
)

console.log(ctx.citations, ctx.serialized)
repo.close()
```

## 9. Verification Commands & Results

- `corepack pnpm lint` — **exit 0**
- `corepack pnpm -r --if-present typecheck` — **exit 0**
- `corepack pnpm -r --if-present build` — **exit 0**
- `corepack pnpm --filter @ghost-bot/memory test` — **exit 0**
- `corepack pnpm --filter @ghost-bot/knowledge test` — **exit 0**
- `corepack pnpm test` — **exit 0**
