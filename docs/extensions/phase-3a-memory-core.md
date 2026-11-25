# Phase 3A — Independent Local Memory Engine (`@ghost-bot/memory`)

Status: **Implemented & Tested** (Track B — Independent Extensions, branched from `main @ 2ffc521`).

## 1. Architecture and Design Rationale

`@ghost-bot/memory` is a standalone, daemon-agnostic, local-first memory engine designed for Ghost Bot. It provides strict Zod-validated contracts, scope-isolated CRUD and duplicate detection, SQLite persistence (`node:sqlite`), deterministic local retrieval (FTS5 + lexical fallback) with Vietnamese Unicode support, and a pure runtime-independent context builder.

Design principles:
- **Zero execution/UI coupling**: No dependencies on `apps/daemon`, `apps/desktop`, `packages/runtime-adapters`, Electron, or Codex authentication/runtime state.
- **No global mutable state**: All state lives in explicit `MemoryRepository` instances with injectable `Clock` and `IdGenerator` dependencies.
- **Fail-closed authorization**: Every operation requires an explicit `MemoryAuthContext`. Possession of a record ID never grants access.
- **Untrusted data boundary**: Stored memory is strictly reference data (`authority: "none"`), never system instructions or tool permissions.

## 2. Package Structure

```text
packages/memory/
  package.json
  tsconfig.json
  src/
    index.ts
    contracts/
      errors.ts          # Typed MemoryError hierarchy
      limits.ts          # Central MEMORY_LIMITS and MEMORY_SCHEMA_VERSION
      schemas.ts         # Strict Zod schemas (.strict())
      types.ts           # Inferred TypeScript types
    security/
      authorization.ts   # Scope ownership & visibility enforcement
      path-guard.ts      # Symlink, UID, and 0700/0600 permission checks
      redaction.ts       # Credential pattern detection & error sanitization
    repository/
      interface.ts       # MemoryRepository interface & result types
      in-memory.ts       # Deterministic in-memory reference repository
      normalization.ts   # NFC, whitespace folding, SHA-256 hash, Vietnamese folding
    storage/
      sqlite-schema.ts   # Isolated SQLite DDL & FTS5 virtual table
      sqlite-client.ts   # node:sqlite DatabaseSync lifecycle & BEGIN IMMEDIATE tx
      sqlite-repository.ts # Persistent SQLite repository with row validation
    search/
      fts5.ts            # Safe quoted FTS5 query builder
      lexical.ts         # Tokenization & lexical/Vietnamese scoring
      ranker.ts          # Deterministic ranking & tie-breaking
    context/
      serializer.ts      # Untrusted JSON reference-data envelope
      builder.ts         # Pure budget-enforced context assembler
  tests/
    unit/
      contracts-and-security.test.ts
      scope-isolation.test.ts
      search-and-vietnamese.test.ts
      context-builder.test.ts
    integration/
      sqlite-persistence.test.ts
```

## 3. Public API

Exported from `@ghost-bot/memory` (`packages/memory/src/index.ts`):
- **Contracts & Limits**: `MEMORY_LIMITS`, `MEMORY_SCHEMA_VERSION`, `MemoryRecordSchema`, `MemoryScopeSchema`, `CreateMemoryInputSchema`, `UpdateMemoryInputSchema`, `ListMemoriesQuerySchema`, `SearchMemoriesQuerySchema`, `MemoryAuthContextSchema`, `ContextBuildOptionsSchema`.
- **Errors**: `MemoryError`, `MemoryValidationError`, `MemoryUnsupportedOriginError`, `MemoryAuthorizationError`, `MemoryNotFoundError`, `MemoryDuplicateError`, `MemoryCredentialError`, `MemoryUnsafePathError`, `MemoryStorageCorruptionError`, `MemoryStorageError`.
- **Repositories**: `MemoryRepository`, `InMemoryMemoryRepository`, `openMemoryDatabase`, `SqliteMemoryRepository`.
- **Context Assembly**: `buildMemoryContext`, `estimateTokensHeuristic`, `serializeMemoryEnvelope`, `toSerializedMemoryItem`.
- **Security & Normalization**: `containsCredentialPattern`, `redactSecrets`, `sanitizeErrorMessage`, `normalizeStoredContent`, `normalizeForDeduplication`, `foldVietnameseAccents`.

## 4. Memory Contracts & Lifecycle

### Scope Discriminated Union
Every scope retains its owning `userId`:
1. `{ kind: 'user', userId }` — User-wide scope.
2. `{ kind: 'bot', userId, botId }` — Bot-specific scope.
3. `{ kind: 'workspace', userId, workspaceId }` — Workspace-specific scope.

### Categories & Origins
- **Categories**: `'preference' | 'fact' | 'instruction_note' | 'project_context' | 'glossary' | 'other'`. (`instruction_note` is user-saved reference text, never runtime authority.)
- **Origins**: `'explicit' | 'inferred'`. Phase 3A only permits `'explicit'` creation; `'inferred'` is reserved in the contract and fails closed with `MemoryUnsupportedOriginError`.

### Record Lifecycle
- `active` (`archivedAt: null`): Eligible for normal `getById`, `list`, `search`, deduplication, and `buildMemoryContext` (provided `expiresAt === null || expiresAt > now`).
- `archived` (`archivedAt: <UTC ISO>`): Excluded from normal retrieval, search, active deduplication, and context assembly.
- `expired` (`expiresAt !== null && expiresAt <= now`): Excluded from normal retrieval, search, active deduplication, and context assembly.
- `deleted`: Permanently removed from the logical SQLite tables (`memories` and `memories_fts`).

## 5. Storage Schema & Proposed Daemon Integration

### Isolated Phase 3A Schema (`packages/memory/src/storage/sqlite-schema.ts`)
- `memory_schema_meta (key PRIMARY KEY, value)` — tracks `schema_version = 1`.
- `memories`: stores `id`, `schema_version`, `scope_kind`, `user_id`, `bot_id`, `workspace_id`, `scope_key`, `origin`, `category`, `content`, `normalized_content`, `content_hash`, `tags_json`, `provenance_json`, `status`, `created_at`, `updated_at`, `archived_at`, `expires_at` with `CHECK` constraints enforcing scope column invariants and `archived_at` consistency.
- `idx_memories_active_dedup`: `UNIQUE INDEX ON memories(scope_key, content_hash) WHERE status = 'active'`.
- `memories_fts`: FTS5 virtual table (`tokenize='unicode61 remove_diacritics 2'`).

### Proposed Future Daemon Integration Schema
When integrated into `apps/daemon/src/db/schema.ts` in a future phase:
- Add a coordinated migration (after Track A's `0003`+) creating `memories` and `memories_fts` inside `ghost-bot.sqlite`.
- Add foreign keys or daemon-enforced referential checks linking `bot_id` to `agents.id` (`ON DELETE RESTRICT` or `CASCADE` per retention policy) and `user_id` to the canonical local user identity.
- Keep `SqliteMemoryRepository` behind a daemon-owned `MemoryService` so the Electron renderer never accesses SQLite directly.

## 6. Authorization Assumptions & Scope Visibility Policy

- **Trusted Context Construction**: `@ghost-bot/memory` assumes `MemoryAuthContext` is constructed by a trusted host boundary (e.g., `@ghost-bot/daemon` after authenticating the local IPC/HTTP caller and resolving the active `userId`, `botId`, and canonical `workspaceId`). Untrusted renderer inputs or raw memory records must **never** be used to populate `MemoryAuthContext`.
- **No Implicit Global Fallback**: User-wide (`kind: 'user'`) memories are excluded by default unless **both** `auth.allowUserWideRead === true` **and** `includeUserWide: true` are explicitly set by the caller.
- **Non-Disclosure**: Unauthorized `getById` returns `null`; unauthorized `update`, `archive`, and `delete` throw `MemoryNotFoundError` (`NOT_FOUND`) so callers cannot probe whether a record ID exists in another scope.

## 7. Duplicate Detection & Concurrency

- **Normalization**: `normalizedContent = content.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()`.
- **Identity**: `contentHash = sha256(normalizedContent)`.
- **Scope Boundary**: Uniqueness is enforced per `(scope_key, content_hash)` for `status = 'active'` records only. Identical content in different users, bots, or workspaces is permitted and never suppressed during creation or `findDuplicate`.
- **Concurrency**: Writes execute inside `BEGIN IMMEDIATE` SQLite transactions and rely on `idx_memories_active_dedup` so concurrent duplicate inserts fail deterministically with `MemoryDuplicateError`.

## 8. Search Algorithm, Ranking & Vietnamese Unicode Behavior

- **Engine**: Evaluates SQLite FTS5 (`unicode61 remove_diacritics 2`) when available; falls back cleanly to bounded lexical search if FTS5 is unavailable (`enableFts5: false`).
- **Safe Query Construction**: Raw user queries are never passed to FTS5 `MATCH`. Queries are tokenized via `/[\p{L}\p{N}_-]+/gu`, capped at `MEMORY_LIMITS.maxQueryTokens` (16), stripped of FTS operators, and double-quoted as `"token" OR "folded_token"`. Punctuation-only queries return empty results safely.
- **Authorization Before Ranking**: SQL `WHERE` clauses filter by authorized `scope_key IN (...)`, `user_id = ?`, `status = 'active'`, and non-expired `expires_at` before FTS5/lexical scoring.
- **Vietnamese Behavior**:
  - Storage normalizes text to Unicode `NFC`.
  - Search scores both exact-accent tokens (`+50` scaled) and accent-folded tokens (`+25` scaled) using `NFD` diacritic stripping plus explicit `đ -> d` / `Đ -> D` mapping.
  - Exact normalized phrase matches receive `+100`; accent-folded phrase matches receive `+65`; tag matches receive `+20` per token; scope priority adds `workspace (+6) > bot (+4) > user (+2)`.
- **Deterministic Tie-Breaking**: `score DESC`, then `updatedAt DESC`, then `id ASC`.
- **Limitations**: This is deterministic lexical retrieval, **not** semantic or embedding search. Word segmentation for compound Vietnamese words relies on whitespace/punctuation tokenization.

## 9. Context Builder & Budget Semantics

`buildMemoryContext(auth, candidates, options, clock)` is a pure function:
1. Re-validates `auth`, `options`, and every candidate via `MemoryRecordSchema`.
2. Re-checks scope authorization (throws `MemoryAuthorizationError` on cross-user candidates; excludes unauthorized bot/workspace/user-wide records).
3. Excludes `archived` and expired (`expiresAt <= now`) records using the injectable `clock`.
4. Sorts deterministically (`workspace` > `bot` > `user`, `updatedAt DESC`, `id ASC`) and deduplicates by `id` and `contentHash`.
5. Enforces `maxRecords`, `maxChars`, `maxBytes` (UTF-8), and optional `maxEstimatedTokens` (`Math.ceil(chars / 4)`, explicitly labeled `chars_div_4_heuristic` — **not** an exact model tokenizer).
6. Serializes selected records into a JSON `untrusted_memory_reference_data` envelope (`authority: "none"`). If adding a record would exceed any budget limit, it is deterministically skipped so the hard output-size limit is never exceeded.

## 10. Security, Privacy, Credential Protection & Deletion Semantics

- **Credential Protection**: Ingestion (`create`/`update`) rejects content, tags, or provenance matching recognized patterns (`sk-...`, `pk_live_/pk_test_`, `gh[pousr]_...`, `AKIA...`, `xox...`, `AIza...`, `Bearer ...`, `Authorization: ...`, PEM private keys, env key assignments, JSON token fields).
- **Limitations of Pattern Detection**: Regex detection cannot catch arbitrary high-entropy secrets, custom token formats, or split/encoded credentials.
- **Logging & Errors**: Errors are sanitized via `sanitizeErrorMessage` / `redactSecrets`; raw memory content and database rows are never logged.
- **Storage Security**: File-backed databases enforce `0o700` directory permissions, `0o600` file permissions on `.sqlite`, `-wal`, and `-shm`, `uid` ownership checks, and reject symlinks or relative/NUL paths.
- **Deletion Semantics**: `delete()` removes the row from `memories` and `memories_fts` inside a transaction. It does **not** guarantee forensic erasure from SQLite freelist pages, WAL files, OS page cache, or filesystem snapshots.

## 11. Threat Model & Residual Risks

- **Prompt Injection**: Mitigated at the trust boundary by wrapping serialized memory in a JSON `untrusted_memory_reference_data` envelope with `authority: "none"`. Future runtime integration must still enforce tool/permission policies independently of model output.
- **Corrupted Storage**: `PRAGMA quick_check(1)` and strict `MemoryRecordSchema` row decoding fail closed with `MemoryStorageCorruptionError` rather than silently discarding corrupt rows.
- **Future Integration Requirements**: Daemon must construct `MemoryAuthContext` from verified session/bot/workspace ownership, expose IPC channels in `packages/shared-types/ipc.ts` with Zod validation, and add UI review/delete controls before enabling automatic memory injection.

## 12. Synthetic Usage Example

```ts
import {
  buildMemoryContext,
  openMemoryDatabase,
  SqliteMemoryRepository,
  type MemoryAuthContext,
} from '@ghost-bot/memory'

const auth: MemoryAuthContext = {
  actorId: 'user-demo',
  userId: 'user-demo',
  botId: 'bot-coder',
  workspaceId: 'ws-ghost',
  allowUserWideRead: false,
  allowUserWideWrite: false,
}

const handle = await openMemoryDatabase(':memory:')
const repo = new SqliteMemoryRepository(handle)

repo.create(auth, {
  scope: { kind: 'workspace', userId: 'user-demo', workspaceId: 'ws-ghost' },
  category: 'project_context',
  content: 'Dùng pnpm và TypeScript strict cho toàn bộ monorepo.',
  tags: ['typescript', 'pnpm'],
})

const found = repo.search(auth, { query: 'TypeScript monorepo' })
const ctx = buildMemoryContext(
  auth,
  found.items.map((m) => m.record),
  { maxRecords: 5, maxChars: 4096, maxBytes: 4096 },
)

console.log(ctx.metadata.selectedCount, ctx.serialized)
repo.close()
```

## 13. Verification Commands & Results

- `corepack pnpm --filter @ghost-bot/memory test` — **10/10 tests pass** (unit + SQLite integration).
- `corepack pnpm --filter @ghost-bot/memory typecheck` — **0 errors** (strict TypeScript).
- `corepack pnpm lint` — **0 errors**.
