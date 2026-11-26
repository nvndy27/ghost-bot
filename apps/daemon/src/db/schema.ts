import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const providerAccounts = sqliteTable('provider_accounts', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  authKind: text('auth_kind').notNull(),
  credentialRef: text('credential_ref').notNull(),
  status: text('status').notNull(),
  capabilitiesJson: text('capabilities_json').notNull(),
  checkedAt: text('checked_at').notNull(),
})

export const modelProfiles = sqliteTable('model_profiles', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => providerAccounts.id, { onDelete: 'cascade' }),
  runtimeId: text('runtime_id').notNull(),
  modelId: text('model_id').notNull(),
  effort: text('effort').notNull(),
  optionsJson: text('options_json').notNull(),
})

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    instructions: text('instructions').notNull(),
    avatarJson: text('avatar_json').notNull(),
    runtimeId: text('runtime_id').notNull(),
    modelProfileId: text('model_profile_id').references(() => modelProfiles.id, {
      onDelete: 'set null',
    }),
    modelId: text('model_id').notNull(),
    effort: text('effort').notNull(),
    workspacePath: text('workspace_path').notNull(),
    permissionMode: text('permission_mode').notNull(),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_agents_archived').on(t.archivedAt)],
)

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  leaderAgentId: text('leader_agent_id').references(() => agents.id, {
    onDelete: 'set null',
  }),
})

export const teamMembers = sqliteTable(
  'team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.agentId] })],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    accountId: text('account_id').notNull(),
    runtimeId: text('runtime_id').notNull(),
    externalSessionId: text('external_session_id'),
    title: text('title').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at'),
  },
  (t) => [
    index('idx_sessions_agent_created').on(t.agentId, t.createdAt),
    index('idx_sessions_agent_updated').on(t.agentId, t.archivedAt, t.updatedAt),
  ],
)

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    runtimeId: text('runtime_id').notNull(),
    modelId: text('model_id').notNull(),
    effort: text('effort').notNull(),
    permissionMode: text('permission_mode').notNull(),
    configSnapshotJson: text('config_snapshot_json').notNull(),
    status: text('status').notNull(),
    errorJson: text('error_json'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_runs_session_idempotency').on(t.sessionId, t.idempotencyKey),
    index('idx_runs_session_created').on(t.sessionId, t.createdAt),
    index('idx_runs_status').on(t.status),
  ],
)

export const runEvents = sqliteTable(
  'run_events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    seq: integer('seq').notNull(),
    eventKey: text('event_key').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    timestamp: text('timestamp').notNull(),
  },
  (t) => [
    uniqueIndex('idx_run_events_run_seq').on(t.runId, t.seq),
    uniqueIndex('idx_run_events_run_key').on(t.runId, t.eventKey),
  ],
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    contentJson: text('content_json').notNull(),
    seqOrder: integer('seq_order').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    runId: text('run_id'),
  },
  (t) => [index('idx_messages_session_order').on(t.sessionId, t.seqOrder, t.createdAt)],
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    runId: text('run_id'),
    kind: text('kind').notNull(),
    valueJson: text('value_json').notNull(),
    source: text('source').notNull(),
    observedAt: text('observed_at').notNull(),
    resetAt: text('reset_at'),
  },
  (t) => [index('idx_usage_account_observed').on(t.accountId, t.observedAt)],
)

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  outcome: text('outcome').notNull(),
  redactedJson: text('redacted_json').notNull(),
  timestamp: text('timestamp').notNull(),
})

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    runtimeGeneration: integer('runtime_generation').notNull(),
    accountId: text('account_id').notNull(),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    providerRequestId: text('provider_request_id'),
    actionType: text('action_type').notNull(),
    actionSummary: text('action_summary').notNull(),
    argsJson: text('args_json').notNull(),
    argsHash: text('args_hash').notNull(),
    permissionMode: text('permission_mode').notNull(),
    status: text('status').notNull(),
    decisionMetaJson: text('decision_meta_json'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    index('idx_approvals_run_status').on(t.runId, t.status),
    index('idx_approvals_session_created').on(t.sessionId, t.createdAt),
  ],
)

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
    scopeKind: text('scope_kind').notNull(),
    userId: text('user_id').notNull(),
    botId: text('bot_id').references(() => agents.id, { onDelete: 'restrict' }),
    workspaceId: text('workspace_id'),
    scopeKey: text('scope_key').notNull(),
    origin: text('origin').notNull(),
    category: text('category').notNull(),
    content: text('content').notNull(),
    normalizedContent: text('normalized_content').notNull(),
    contentHash: text('content_hash').notNull(),
    tagsJson: text('tags_json').notNull(),
    provenanceJson: text('provenance_json').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at'),
    expiresAt: text('expires_at'),
  },
  (t) => [
    index('idx_memories_scope').on(t.userId, t.scopeKind, t.status, t.updatedAt, t.id),
  ],
)

export const knowledgeCollections = sqliteTable('knowledge_collections', {
  id: text('id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  scopeKind: text('scope_kind').notNull(),
  userId: text('user_id').notNull(),
  botId: text('bot_id').references(() => agents.id, { onDelete: 'restrict' }),
  workspaceId: text('workspace_id'),
  scopeKey: text('scope_key').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  archivedAt: text('archived_at'),
})

export const knowledgeDocuments = sqliteTable(
  'knowledge_documents',
  {
    id: text('id').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
    collectionId: text('collection_id').references(() => knowledgeCollections.id, {
      onDelete: 'restrict',
    }),
    scopeKind: text('scope_kind').notNull(),
    userId: text('user_id').notNull(),
    botId: text('bot_id').references(() => agents.id, { onDelete: 'restrict' }),
    workspaceId: text('workspace_id'),
    scopeKey: text('scope_key').notNull(),
    title: text('title').notNull(),
    sourceType: text('source_type').notNull(),
    mediaType: text('media_type').notNull(),
    displayFilename: text('display_filename'),
    tagsJson: text('tags_json').notNull(),
    status: text('status').notNull(),
    currentRevisionId: text('current_revision_id').notNull(),
    rawFingerprint: text('raw_fingerprint').notNull(),
    extractedFingerprint: text('extracted_fingerprint').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at'),
  },
  (t) => [
    index('idx_knowledge_docs_scope').on(t.userId, t.scopeKind, t.status, t.updatedAt, t.id),
  ],
)

export const knowledgeDocumentRevisions = sqliteTable('knowledge_document_revisions', {
  id: text('id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  documentId: text('document_id')
    .notNull()
    .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
  revisionNumber: integer('revision_number').notNull(),
  rawFingerprint: text('raw_fingerprint').notNull(),
  extractedFingerprint: text('extracted_fingerprint').notNull(),
  charCount: integer('char_count').notNull(),
  chunkCount: integer('chunk_count').notNull(),
  createdAt: text('created_at').notNull(),
})

export const knowledgeChunks = sqliteTable(
  'knowledge_chunks',
  {
    id: text('id').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    revisionId: text('revision_id')
      .notNull()
      .references(() => knowledgeDocumentRevisions.id, { onDelete: 'cascade' }),
    scopeKind: text('scope_kind').notNull(),
    userId: text('user_id').notNull(),
    botId: text('bot_id'),
    workspaceId: text('workspace_id'),
    scopeKey: text('scope_key').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    normalizedContent: text('normalized_content').notNull(),
    contentHash: text('content_hash').notNull(),
    locationJson: text('location_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_knowledge_chunks_doc_rev').on(t.documentId, t.revisionId)],
)
