import type { DatabaseSync } from 'node:sqlite'
import { sanitizeErrorMessage } from '@ghost-bot/memory'
import { KnowledgeStorageCorruptionError, KnowledgeStorageError } from '../contracts/errors.ts'

export const KNOWLEDGE_DB_SCHEMA_VERSION = 1

const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_collections (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'bot', 'workspace')),
  user_id TEXT NOT NULL,
  bot_id TEXT,
  workspace_id TEXT,
  scope_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (
    (scope_kind = 'user' AND bot_id IS NULL AND workspace_id IS NULL) OR
    (scope_kind = 'bot' AND bot_id IS NOT NULL AND workspace_id IS NULL) OR
    (scope_kind = 'workspace' AND bot_id IS NULL AND workspace_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_collections_name
  ON knowledge_collections(scope_key, name)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  collection_id TEXT REFERENCES knowledge_collections(id) ON DELETE RESTRICT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'bot', 'workspace')),
  user_id TEXT NOT NULL,
  bot_id TEXT,
  workspace_id TEXT,
  scope_key TEXT NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('direct_text', 'text_file', 'markdown')),
  media_type TEXT NOT NULL CHECK (media_type IN ('text/plain', 'text/markdown')),
  display_filename TEXT,
  tags_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'archived')),
  current_revision_id TEXT NOT NULL,
  raw_fingerprint TEXT NOT NULL,
  extracted_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (
    (scope_kind = 'user' AND bot_id IS NULL AND workspace_id IS NULL) OR
    (scope_kind = 'bot' AND bot_id IS NOT NULL AND workspace_id IS NULL) OR
    (scope_kind = 'workspace' AND bot_id IS NULL AND workspace_id IS NOT NULL)
  ),
  CHECK (
    (status = 'archived' AND archived_at IS NOT NULL) OR
    (status = 'ready' AND archived_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_docs_active_fp
  ON knowledge_documents(scope_key, extracted_fingerprint)
  WHERE status = 'ready';

CREATE INDEX IF NOT EXISTS idx_knowledge_docs_scope
  ON knowledge_documents(user_id, scope_kind, status, updated_at DESC, id ASC);

CREATE TABLE IF NOT EXISTS knowledge_document_revisions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  raw_fingerprint TEXT NOT NULL,
  extracted_fingerprint TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_rev_doc_num
  ON knowledge_document_revisions(document_id, revision_number);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES knowledge_document_revisions(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'bot', 'workspace')),
  user_id TEXT NOT NULL,
  bot_id TEXT,
  workspace_id TEXT,
  scope_key TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  normalized_content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  location_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunks_rev_idx
  ON knowledge_chunks(revision_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc_rev
  ON knowledge_chunks(document_id, revision_id);
`

const FTS5_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  revision_id UNINDEXED,
  content,
  title_and_tags,
  tokenize='unicode61 remove_diacritics 2'
);
`

export function initializeKnowledgeSchema(
  sqlite: DatabaseSync,
  options: { enableFts5?: boolean } = {},
): { fts5Enabled: boolean } {
  const wantFts5 = options.enableFts5 ?? true

  sqlite.exec('BEGIN IMMEDIATE')
  try {
    sqlite.exec(CORE_SCHEMA_SQL)

    const versionRow = sqlite
      .prepare('SELECT value FROM knowledge_schema_meta WHERE key = ?')
      .get('schema_version') as { value?: unknown } | undefined

    if (versionRow === undefined) {
      sqlite
        .prepare('INSERT INTO knowledge_schema_meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(KNOWLEDGE_DB_SCHEMA_VERSION))
    } else {
      const parsedVersion = Number(versionRow.value)
      if (!Number.isInteger(parsedVersion) || parsedVersion < 1) {
        throw new KnowledgeStorageCorruptionError('Invalid knowledge database schema_version metadata')
      }
      if (parsedVersion > KNOWLEDGE_DB_SCHEMA_VERSION) {
        throw new KnowledgeStorageCorruptionError(
          `Unsupported newer knowledge database schema version: ${parsedVersion}`,
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
      // Ignore rollback error.
    }
    if (err instanceof KnowledgeStorageCorruptionError) {
      throw err
    }
    throw new KnowledgeStorageError(`Failed to initialize knowledge schema: ${sanitizeErrorMessage(err)}`)
  }
}
