import type { DatabaseSync } from 'node:sqlite'
import { sanitizeErrorMessage } from '@ghost-bot/memory'
import { McpStorageCorruptionError, McpStorageError } from '../contracts/errors.ts'

export const MCP_DB_SCHEMA_VERSION = 1

const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mcp_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'bot', 'workspace')),
  user_id TEXT NOT NULL,
  bot_id TEXT,
  workspace_id TEXT,
  scope_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  transport_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  trust_state TEXT NOT NULL CHECK (trust_state IN ('untrusted', 'trusted', 'revoked')),
  config_fingerprint TEXT NOT NULL,
  trusted_fingerprint TEXT,
  connect_timeout_ms INTEGER NOT NULL,
  request_timeout_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope_kind = 'user' AND bot_id IS NULL AND workspace_id IS NULL) OR
    (scope_kind = 'bot' AND bot_id IS NOT NULL AND workspace_id IS NULL) OR
    (scope_kind = 'workspace' AND bot_id IS NULL AND workspace_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_scope_name
  ON mcp_servers(scope_key, display_name);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope
  ON mcp_servers(user_id, scope_kind, updated_at DESC, id ASC);
`

export function initializeMcpSchema(sqlite: DatabaseSync): void {
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    sqlite.exec(CORE_SCHEMA_SQL)

    const versionRow = sqlite
      .prepare('SELECT value FROM mcp_schema_meta WHERE key = ?')
      .get('schema_version') as { value?: unknown } | undefined

    if (versionRow === undefined) {
      sqlite
        .prepare('INSERT INTO mcp_schema_meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(MCP_DB_SCHEMA_VERSION))
    } else {
      const parsedVersion = Number(versionRow.value)
      if (!Number.isInteger(parsedVersion) || parsedVersion < 1) {
        throw new McpStorageCorruptionError('Invalid MCP database schema_version metadata')
      }
      if (parsedVersion > MCP_DB_SCHEMA_VERSION) {
        throw new McpStorageCorruptionError(
          `Unsupported newer MCP database schema version: ${parsedVersion}`,
        )
      }
    }

    sqlite.exec('COMMIT')
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK')
    } catch {
      // Ignore rollback error.
    }
    if (err instanceof McpStorageCorruptionError) {
      throw err
    }
    throw new McpStorageError(`Failed to initialize MCP schema: ${sanitizeErrorMessage(err)}`)
  }
}
