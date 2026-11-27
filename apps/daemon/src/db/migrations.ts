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
  {
    version: 8,
    name: '0008_teams_coordination',
    sql: `
      ALTER TABLE teams ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE teams ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'local-user';
      ALTER TABLE teams ADD COLUMN lead_bot_id TEXT;
      ALTER TABLE teams ADD COLUMN member_bot_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE teams ADD COLUMN memory_sharing_policy TEXT NOT NULL DEFAULT 'explicit-only';
      ALTER TABLE teams ADD COLUMN bounds_json TEXT NOT NULL DEFAULT '{"maxDepth":3,"maxAttempts":2,"maxTokens":50000,"maxDurationMs":300000,"maxConcurrentTasks":3,"maxTasksPerRun":25,"maxMessages":200,"maxResultBytes":65536}';
      ALTER TABLE teams ADD COLUMN archived_at TEXT;
      ALTER TABLE teams ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE teams ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

      UPDATE teams
      SET
        lead_bot_id = COALESCE(lead_bot_id, leader_agent_id, ''),
        member_bot_ids_json = COALESCE(
          (
            SELECT json_group_array(tm.agent_id)
            FROM team_members tm
            WHERE tm.team_id = teams.id
          ),
          '[]'
        ),
        created_at = CASE WHEN created_at = '' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE created_at END,
        updated_at = CASE WHEN updated_at = '' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE updated_at END;

      CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id, archived_at);

      CREATE TABLE IF NOT EXISTS team_runs (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        lead_bot_id TEXT NOT NULL,
        root_task_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        goal TEXT NOT NULL,
        goal_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        bounds_json TEXT NOT NULL,
        tasks_created INTEGER NOT NULL DEFAULT 0,
        messages_posted INTEGER NOT NULL DEFAULT 0,
        tokens_reserved INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        duration_used_ms INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_team_runs_team ON team_runs(team_id, owner_id, status);

      CREATE TABLE IF NOT EXISTS team_tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        team_run_id TEXT,
        plan_key TEXT,
        owner_id TEXT NOT NULL,
        root_task_id TEXT NOT NULL,
        parent_task_id TEXT,
        depth INTEGER NOT NULL,
        assigned_bot_id TEXT NOT NULL,
        delegated_by_bot_id TEXT,
        idempotency_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        token_budget INTEGER NOT NULL,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        duration_budget_ms INTEGER NOT NULL,
        reserved_duration_ms INTEGER NOT NULL DEFAULT 0,
        duration_used_ms INTEGER NOT NULL DEFAULT 0,
        output_text TEXT,
        output_truncated INTEGER NOT NULL DEFAULT 0,
        usage_reported INTEGER NOT NULL DEFAULT 1,
        termination_confirmed INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_team_tasks_root ON team_tasks(root_task_id, depth, status);
      CREATE INDEX IF NOT EXISTS idx_team_tasks_queue ON team_tasks(team_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_team_tasks_run ON team_tasks(team_run_id, status);

      CREATE TABLE IF NOT EXISTS team_task_dependencies (
        team_run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_team_deps_run ON team_task_dependencies(team_run_id, depends_on_task_id);

      CREATE TABLE IF NOT EXISTS team_messages (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        team_run_id TEXT,
        conversation_id TEXT,
        owner_id TEXT NOT NULL,
        author_bot_id TEXT NOT NULL,
        target_bot_id TEXT,
        originating_task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
        sender_type TEXT NOT NULL DEFAULT 'worker',
        message_type TEXT NOT NULL DEFAULT 'worker_progress',
        visibility TEXT NOT NULL DEFAULT 'team',
        untrusted INTEGER NOT NULL DEFAULT 1,
        seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(team_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_team_messages_run ON team_messages(team_run_id, seq);

      CREATE TABLE IF NOT EXISTS team_execution_links (
        id TEXT PRIMARY KEY,
        team_run_id TEXT REFERENCES team_runs(id) ON DELETE CASCADE,
        team_task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        daemon_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('planner', 'worker', 'synthesizer')),
        created_at TEXT NOT NULL,
        UNIQUE(team_task_id, attempt, role)
      );

      CREATE INDEX IF NOT EXISTS idx_team_exec_links_run ON team_execution_links(team_run_id, daemon_run_id);
    `,
  },
  {
    version: 9,
    name: '0009_teams_legacy_leader_fix',
    sql: `
      -- Safely repair or archive legacy Phase 1C teams whose leader_agent_id was NULL (from ON DELETE SET NULL)
      -- while preserving all historical teams rows.
      UPDATE teams
      SET
        lead_bot_id = COALESCE(
          (
            SELECT tm.agent_id
            FROM team_members tm
            JOIN agents a ON a.id = tm.agent_id AND a.archived_at IS NULL
            WHERE tm.team_id = teams.id
            ORDER BY CASE WHEN tm.role = 'lead' THEN 0 ELSE 1 END, tm.agent_id ASC
            LIMIT 1
          ),
          lead_bot_id
        ),
        archived_at = CASE
          WHEN (
            SELECT a.id FROM agents a WHERE a.id = teams.lead_bot_id AND a.archived_at IS NULL LIMIT 1
          ) IS NULL
          AND (
            SELECT tm.agent_id
            FROM team_members tm
            JOIN agents a ON a.id = tm.agent_id AND a.archived_at IS NULL
            WHERE tm.team_id = teams.id
            LIMIT 1
          ) IS NULL
          THEN COALESCE(archived_at, CASE WHEN created_at <> '' THEN created_at ELSE '1970-01-01T00:00:00.000Z' END)
          ELSE archived_at
        END
      WHERE lead_bot_id = ''
         OR lead_bot_id NOT IN (SELECT id FROM agents WHERE archived_at IS NULL);
    `,
  },
  {
    version: 10,
    name: '0010_scheduler_routines',
    sql: `
      CREATE TABLE IF NOT EXISTS scheduler_routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        target_type TEXT NOT NULL DEFAULT 'bot',
        team_id TEXT REFERENCES teams(id) ON DELETE RESTRICT,
        trigger_json TEXT NOT NULL,
        timezone TEXT NOT NULL,
        task_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        archived_at TEXT,
        missed_run_policy TEXT NOT NULL,
        max_catch_up_runs INTEGER NOT NULL,
        concurrency_policy TEXT NOT NULL,
        max_concurrent_runs INTEGER NOT NULL,
        retry_policy_json TEXT NOT NULL,
        expires_at TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        last_evaluated_at TEXT,
        last_task_status TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        ownership TEXT NOT NULL DEFAULT 'ghost-bot',
        dedup_watermark_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduler_routines_scope
        ON scheduler_routines(owner_id, bot_id, archived_at, enabled);

      CREATE TABLE IF NOT EXISTS scheduler_tasks (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES scheduler_routines(id) ON DELETE CASCADE,
        routine_revision INTEGER NOT NULL DEFAULT 1,
        trigger_source TEXT NOT NULL DEFAULT 'schedule',
        owner_id TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        occurrence_key TEXT NOT NULL UNIQUE,
        scheduled_for TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        claim_owner TEXT,
        claim_lease_expires_at TEXT,
        uncertain_execution INTEGER NOT NULL DEFAULT 0,
        approval_required INTEGER NOT NULL DEFAULT 0,
        approval_state TEXT,
        approval_expires_at TEXT,
        approval_action_summary TEXT,
        task_snapshot_json TEXT NOT NULL,
        payload_hash TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_claim
        ON scheduler_tasks(status, scheduled_for, created_at);

      CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_routine
        ON scheduler_tasks(routine_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS scheduler_occurrence_dedup (
        occurrence_key TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES scheduler_routines(id) ON DELETE CASCADE,
        trigger_source TEXT NOT NULL,
        scheduled_for TEXT,
        payload_hash TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scheduler_dedup_routine
        ON scheduler_occurrence_dedup(routine_id, expires_at);

      CREATE TABLE IF NOT EXISTS scheduler_notifications (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES scheduler_routines(id) ON DELETE CASCADE,
        routine_revision INTEGER NOT NULL,
        task_id TEXT,
        occurrence_key TEXT,
        owner_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL,
        read_at TEXT,
        dismissed_at TEXT,
        delivery_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scheduler_notifications_scope
        ON scheduler_notifications(owner_id, bot_id, read_at, dismissed_at, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_scheduler_notifications_routine
        ON scheduler_notifications(routine_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS scheduler_execution_links (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES scheduler_routines(id) ON DELETE CASCADE,
        routine_revision INTEGER NOT NULL,
        occurrence_key TEXT NOT NULL,
        scheduler_task_id TEXT NOT NULL REFERENCES scheduler_tasks(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        team_id TEXT REFERENCES teams(id) ON DELETE RESTRICT,
        session_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
        daemon_run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
        team_run_id TEXT REFERENCES team_runs(id) ON DELETE RESTRICT,
        runtime_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(scheduler_task_id, attempt)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduler_exec_links_task
        ON scheduler_execution_links(scheduler_task_id, daemon_run_id, team_run_id);

      CREATE TABLE IF NOT EXISTS scheduler_approval_links (
        id TEXT PRIMARY KEY,
        scheduler_task_id TEXT NOT NULL REFERENCES scheduler_tasks(id) ON DELETE CASCADE,
        routine_id TEXT NOT NULL REFERENCES scheduler_routines(id) ON DELETE CASCADE,
        routine_revision INTEGER NOT NULL,
        occurrence_key TEXT NOT NULL,
        daemon_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        daemon_approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scheduler_task_id, daemon_approval_id)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduler_approval_links_run
        ON scheduler_approval_links(daemon_run_id, daemon_approval_id);
    `,
  },
  {
    version: 11,
    name: '0011_scheduler_task_approval_cols',
    sql: `
      ALTER TABLE scheduler_tasks ADD COLUMN daemon_run_id TEXT;
      ALTER TABLE scheduler_tasks ADD COLUMN daemon_approval_id TEXT;
    `,
  },
  {
    version: 12,
    name: '0012_computer_use_sessions_audit',
    sql: `
      CREATE TABLE IF NOT EXISTS cu_sessions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL,
        session_kind TEXT NOT NULL,
        state TEXT NOT NULL,
        allow_observation INTEGER NOT NULL,
        allow_navigation INTEGER NOT NULL,
        allow_interaction INTEGER NOT NULL,
        allowed_origins_json TEXT NOT NULL,
        inherited_from_team_or_routine INTEGER NOT NULL DEFAULT 0,
        worker_pid INTEGER,
        emergency_stop_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cu_sessions_owner_bot ON cu_sessions(owner_id, bot_id, state);

      CREATE TABLE IF NOT EXISTS cu_action_approvals (
        id TEXT PRIMARY KEY,
        cu_session_id TEXT NOT NULL REFERENCES cu_sessions(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tab_id TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        navigation_generation INTEGER NOT NULL,
        action_id TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(cu_session_id, action_id)
      );

      CREATE INDEX IF NOT EXISTS idx_cu_approvals_session ON cu_action_approvals(cu_session_id, status);

      CREATE TABLE IF NOT EXISTS cu_action_ledger (
        id TEXT PRIMARY KEY,
        cu_session_id TEXT NOT NULL REFERENCES cu_sessions(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tab_id TEXT,
        observation_id TEXT,
        navigation_generation INTEGER,
        action_id TEXT,
        action_kind TEXT NOT NULL,
        approval_id TEXT,
        outcome_status TEXT NOT NULL,
        sanitized_summary TEXT NOT NULL,
        error_code TEXT,
        replay_allowed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cu_ledger_session ON cu_action_ledger(cu_session_id, created_at);
    `,
  },
  {
    version: 13,
    name: '0013_terminal_and_skills',
    sql: `
      CREATE TABLE IF NOT EXISTS terminal_commands (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        canonical_workspace TEXT NOT NULL,
        executable TEXT NOT NULL,
        args_json TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        timed_out INTEGER NOT NULL DEFAULT 0,
        termination_confirmed INTEGER,
        stdout_preview TEXT NOT NULL DEFAULT '',
        stderr_preview TEXT NOT NULL DEFAULT '',
        truncated INTEGER NOT NULL DEFAULT 0,
        replay_allowed INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_terminal_commands_bot_created ON terminal_commands(bot_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_terminal_commands_status ON terminal_commands(status);

      CREATE TABLE IF NOT EXISTS local_skills (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        source_root TEXT NOT NULL,
        source_path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        trusted_fingerprint TEXT,
        trust_state TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        validation_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_local_skills_owner ON local_skills(owner_id, name);
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
