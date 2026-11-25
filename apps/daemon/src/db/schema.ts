import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
  },
  (t) => [index('idx_sessions_agent_created').on(t.agentId, t.createdAt)],
)

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  contentJson: text('content_json').notNull(),
  createdAt: text('created_at').notNull(),
  runId: text('run_id'),
})

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
