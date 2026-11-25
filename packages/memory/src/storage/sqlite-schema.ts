import type { DatabaseSync } from 'node:sqlite'
import { MemoryStorageCorruptionError, MemoryStorageError } from '../contracts/errors.ts'
import { sanitizeErrorMessage } from '../security/redaction.ts'

export const MEMORY_DB_SCHEMA_VERSION = 1

const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'bot', 'workspace')),
  user_id TEXT NOT NULL,
  bot_id TEXT,
  workspace_id TEXT,
  scope_key TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('explicit', 'inferred')),
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  normalized_content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  expires_at TEXT,
  CHECK (
    (scope_kind = 'user' AND bot_id IS NULL AND workspace_id IS NULL) OR
    (scope_kind = 'bot' AND bot_id IS NOT NULL AND workspace_id IS NULL) OR
    (scope_kind = 'workspace' AND bot_id IS NULL AND workspace_id IS NOT NULL)
  ),
  CHECK (
    (status = 'archived' AND archived_at IS NOT NULL) OR
    (status = 'active' AND archived_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_active_dedup
  ON memories(scope_key, content_hash)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_memories_scope
  ON memories(user_id, scope_kind, status, updated_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS idx_memories_expires
  ON memories(expires_at)
  WHERE expires_at IS NOT NULL;
`

const FTS5_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  content,
  tags_text,
  tokenize='unicode61 remove_diacritics 2'
);
`

export function initializeMemorySchema(
  sqlite: DatabaseSync,
  options: { enableFts5?: boolean } = {},
): { fts5Enabled: boolean } {
  const wantFts5 = options.enableFts5 ?? true

  sqlite.exec('BEGIN IMMEDIATE')
  try {
    sqlite.exec(CORE_SCHEMA_SQL)

    const metaStmt = sqlite.prepare('SELECT value FROM memory_schema_meta WHERE key = ?')
    const versionRow = metaStmt.get('schema_version') as { value?: unknown } | undefined
    if (versionRow === undefined) {
      sqlite
        .prepare('INSERT INTO memory_schema_meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(MEMORY_DB_SCHEMA_VERSION))
    } else {
      const parsedVersion = Number(versionRow.value)
      if (!Number.isInteger(parsedVersion) || parsedVersion < 1) {
        throw new MemoryStorageCorruptionError('Invalid memory database schema_version metadata')
      }
      if (parsedVersion > MEMORY_DB_SCHEMA_VERSION) {
        throw new MemoryStorageCorruptionError(
          `Unsupported newer memory database schema version: ${parsedVersion}`,
        )
      }
    }

    let fts5Enabled = false
    if (wantFts5) {
      try {
        sqlite.exec(FTS5_SCHEMA_SQL)
        fts5Enabled = true
      } catch {
        fts5Enabled = false
      }
    }

    sqlite.exec('COMMIT')
    return { fts5Enabled }
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK')
    } catch {
      // Ignore rollback errors.
    }
    if (err instanceof MemoryStorageCorruptionError) {
      throw err
    }
    throw new MemoryStorageError(`Failed to initialize memory schema: ${sanitizeErrorMessage(err)}`)
  }
}
