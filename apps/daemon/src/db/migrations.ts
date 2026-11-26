import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '0001_initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS provider_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        auth_kind TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        effort TEXT NOT NULL,
        options_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        avatar_json TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
        model_id TEXT NOT NULL,
        effort TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agents_archived ON agents(archived_at);

      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        leader_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS team_members (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        PRIMARY KEY (team_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        account_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        external_session_id TEXT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_agent_created ON sessions(agent_id, created_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        run_id TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        run_id TEXT,
        kind TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        reset_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_usage_account_observed ON usage_records(account_id, observed_at);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        outcome TEXT NOT NULL,
        redacted_json TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: '0002_sessions_restrict_agent_delete',
    sql: `
      CREATE TABLE sessions_new (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        account_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        external_session_id TEXT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO sessions_new (id, agent_id, account_id, runtime_id, external_session_id, title, created_at)
      SELECT id, agent_id, account_id, runtime_id, external_session_id, title, created_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_agent_created ON sessions(agent_id, created_at);
    `,
  },
  {
    version: 3,
    name: '0003_execution_foundation',
    sql: `
      ALTER TABLE sessions ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE sessions ADD COLUMN archived_at TEXT;
      UPDATE sessions SET updated_at = created_at WHERE updated_at = '';
      CREATE INDEX IF NOT EXISTS idx_sessions_agent_updated ON sessions(agent_id, archived_at, updated_at);

      ALTER TABLE messages ADD COLUMN seq_order INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
      ALTER TABLE messages ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      UPDATE messages SET updated_at = created_at WHERE updated_at = '';
      CREATE INDEX IF NOT EXISTS idx_messages_session_order ON messages(session_id, seq_order, created_at);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        effort TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        config_snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error_json TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session_created ON runs(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        seq INTEGER NOT NULL,
        event_key TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        UNIQUE(run_id, seq),
        UNIQUE(run_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
    `,
  },
  {
    version: 4,
    name: '0004_durable_approvals',
    sql: `
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        runtime_generation INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        provider_request_id TEXT,
        action_type TEXT NOT NULL,
        action_summary TEXT NOT NULL,
        args_json TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        decision_meta_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_run_status ON approvals(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_approvals_session_created ON approvals(session_id, created_at);
    `,
  },
  {
    version: 5,
    name: '0005_memory_core',
    sql: `
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'bot', 'workspace')),
        user_id TEXT NOT NULL,
        bot_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
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

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED,
        content,
        tags_text,
        tokenize='unicode61 remove_diacritics 2'
      );
    `,
  },
  {
    version: 6,
    name: '0006_knowledge_core',
    sql: `
      CREATE TABLE IF NOT EXISTS knowledge_collections (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'bot', 'workspace')),
        user_id TEXT NOT NULL,
        bot_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
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
        bot_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
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

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        revision_id UNINDEXED,
        content,
        title_and_tags,
        tokenize='unicode61 remove_diacritics 2'
      );
    `,
  },
  {
    version: 7,
    name: '0007_mcp_core',
    sql: `
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'bot', 'workspace')),
        user_id TEXT NOT NULL,
        bot_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
        workspace_id TEXT,
        scope_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        transport_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        trust_state TEXT NOT NULL CHECK (trust_state IN ('untrusted', 'trusted', 'revoked')),
        config_fingerprint TEXT NOT NULL,
        trusted_fingerprint TEXT,
        trusted_binary_digest TEXT,
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

      CREATE TABLE IF NOT EXISTS mcp_approval_bindings (
        approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
        server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        config_fingerprint TEXT NOT NULL,
        trusted_binary_digest TEXT,
        connection_generation INTEGER NOT NULL,
        capability_key TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        dispatch_state TEXT NOT NULL CHECK (
          dispatch_state IN ('pending', 'dispatched', 'uncertain', 'completed', 'failed', 'cancelled')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_bindings_server
        ON mcp_approval_bindings(server_id, dispatch_state);
    `,
  },
]

export function runMigrations(sqlite: DatabaseSync): number {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const rows = sqlite.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number
  }>
  const applied = new Set(rows.map((r) => r.version))
  const latestSupported = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
  for (const v of applied) {
    if (v > latestSupported) {
      throw new Error(
        `Unsupported database schema version ${v} (latest supported: ${latestSupported})`,
      )
    }
  }
  let count = 0

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    if (migration.version === 2) {
      // Rebuild sessions with ON DELETE RESTRICT without triggering CASCADE on messages during DROP TABLE sessions.
      sqlite.exec('PRAGMA foreign_keys = OFF;')
    }
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      sqlite.exec(migration.sql)
      sqlite
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString())
      sqlite.exec('COMMIT')
      if (migration.version === 2) {
        sqlite.exec('PRAGMA foreign_keys = ON;')
        const fkViolations = sqlite.prepare('PRAGMA foreign_key_check').all()
        if (fkViolations.length > 0) {
          throw new Error('Foreign key check failed after migration 0002')
        }
      }
      count += 1
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {
        // Ignore rollback failure.
      }
      if (migration.version === 2) {
        sqlite.exec('PRAGMA foreign_keys = ON;')
      }
      throw err
    }
  }

  return count
}
