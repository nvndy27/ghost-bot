import { z } from 'zod'

export const IPC_CHANNELS = {
  APP_INFO: 'ghost:app:info',
  DAEMON_HEALTH: 'ghost:daemon:health',
  PROVIDERS_LIST: 'ghost:providers:list',
  BOTS_LIST: 'ghost:bots:list',
  BOTS_CREATE: 'ghost:bots:create',
  BOTS_UPDATE: 'ghost:bots:update',
  BOTS_DUPLICATE: 'ghost:bots:duplicate',
  BOTS_DELETE: 'ghost:bots:delete',
  BOTS_SET_ACTIVE: 'ghost:bots:set-active',
  AVATAR_IMPORT_SVG: 'ghost:avatar:import-svg',
  WORKSPACE_PICK: 'ghost:workspace:pick',
  SETTINGS_GET: 'ghost:settings:get',
  SETTINGS_UPDATE: 'ghost:settings:update',
  SETTINGS_RESET: 'ghost:settings:reset',
  SETTINGS_MIGRATE_LOCAL: 'ghost:settings:migrate-local',
  RUNTIME_SNAPSHOT: 'ghost:runtime:snapshot',
  SESSIONS_LIST: 'ghost:sessions:list',
  SESSIONS_CREATE: 'ghost:sessions:create',
  SESSIONS_RENAME: 'ghost:sessions:rename',
  SESSIONS_ARCHIVE: 'ghost:sessions:archive',
  SESSIONS_SET_ACTIVE: 'ghost:sessions:set-active',
  MESSAGES_LIST: 'ghost:messages:list',
  RUNS_START: 'ghost:runs:start',
  RUNS_GET: 'ghost:runs:get',
  RUNS_CANCEL: 'ghost:runs:cancel',
  RUNS_EVENTS: 'ghost:runs:events',
  RUNS_RESOLVE_APPROVAL: 'ghost:runs:resolve-approval',
  RUNTIME_RECONNECT: 'ghost:runtime:reconnect',
  SESSIONS_INSPECT: 'ghost:sessions:inspect',
  RUNS_RETRY: 'ghost:runs:retry',
  MEMORY_LIST: 'ghost:memory:list',
  MEMORY_SEARCH: 'ghost:memory:search',
  MEMORY_CREATE: 'ghost:memory:create',
  MEMORY_UPDATE: 'ghost:memory:update',
  MEMORY_ARCHIVE: 'ghost:memory:archive',
  MEMORY_DELETE: 'ghost:memory:delete',
  KNOWLEDGE_COLLECTIONS_LIST: 'ghost:knowledge:collections:list',
  KNOWLEDGE_COLLECTIONS_CREATE: 'ghost:knowledge:collections:create',
  KNOWLEDGE_DOCS_LIST: 'ghost:knowledge:docs:list',
  KNOWLEDGE_DOCS_SEARCH: 'ghost:knowledge:docs:search',
  KNOWLEDGE_DOCS_INGEST_TEXT: 'ghost:knowledge:docs:ingest-text',
  KNOWLEDGE_DOCS_PICK_AND_INGEST: 'ghost:knowledge:docs:pick-and-ingest',
  KNOWLEDGE_DOCS_UPDATE: 'ghost:knowledge:docs:update',
  KNOWLEDGE_DOCS_REPLACE_TEXT: 'ghost:knowledge:docs:replace-text',
  KNOWLEDGE_DOCS_ARCHIVE: 'ghost:knowledge:docs:archive',
  KNOWLEDGE_DOCS_DELETE: 'ghost:knowledge:docs:delete',
  KNOWLEDGE_CITATIONS_RESOLVE: 'ghost:knowledge:citations:resolve',
  MCP_SERVERS_LIST: 'ghost:mcp:servers:list',
  MCP_SERVERS_REGISTER: 'ghost:mcp:servers:register',
  MCP_SERVERS_UPDATE: 'ghost:mcp:servers:update',
  MCP_SERVERS_APPROVE_TRUST: 'ghost:mcp:servers:approve-trust',
  MCP_SERVERS_REVOKE_TRUST: 'ghost:mcp:servers:revoke-trust',
  MCP_SERVERS_SET_ENABLED: 'ghost:mcp:servers:set-enabled',
  MCP_SERVERS_DELETE: 'ghost:mcp:servers:delete',
  MCP_SERVERS_CONNECT: 'ghost:mcp:servers:connect',
  MCP_SERVERS_DISCONNECT: 'ghost:mcp:servers:disconnect',
  MCP_SERVERS_CAPABILITIES: 'ghost:mcp:servers:capabilities',
  MCP_SERVERS_READ_RESOURCE: 'ghost:mcp:servers:read-resource',
  MCP_SERVERS_GET_PROMPT: 'ghost:mcp:servers:get-prompt',
  TEAMS_LIST: 'ghost:teams:list',
  TEAMS_CREATE: 'ghost:teams:create',
  TEAMS_UPDATE: 'ghost:teams:update',
  TEAMS_UPDATE_MEMBERS: 'ghost:teams:update-members',
  TEAMS_ARCHIVE: 'ghost:teams:archive',
  TEAMS_PREVIEW_PLAN: 'ghost:teams:preview-plan',
  TEAMS_RUN_START: 'ghost:teams:runs:start',
  TEAMS_RUN_LIST: 'ghost:teams:runs:list',
  TEAMS_RUN_GET: 'ghost:teams:runs:get',
  TEAMS_RUN_CANCEL: 'ghost:teams:runs:cancel',
  TEAMS_RUN_TASKS: 'ghost:teams:runs:tasks',
  TEAMS_RUN_DIAGNOSTICS: 'ghost:teams:runs:diagnostics',
  TEAMS_RUN_USAGE: 'ghost:teams:runs:usage',
  TEAMS_RUN_APPROVALS: 'ghost:teams:runs:approvals',
  TEAMS_MESSAGES_LIST: 'ghost:teams:messages:list',
  ROUTINES_LIST: 'ghost:routines:list',
  ROUTINES_GET: 'ghost:routines:get',
  ROUTINES_CREATE: 'ghost:routines:create',
  ROUTINES_UPDATE: 'ghost:routines:update',
  ROUTINES_ENABLE: 'ghost:routines:enable',
  ROUTINES_DISABLE: 'ghost:routines:disable',
  ROUTINES_ARCHIVE: 'ghost:routines:archive',
  ROUTINES_TRIGGER: 'ghost:routines:trigger',
  ROUTINES_TASK_GET: 'ghost:routines:tasks:get',
  ROUTINES_TASK_CANCEL: 'ghost:routines:tasks:cancel',
  ROUTINES_PREVIEW: 'ghost:routines:preview',
  ROUTINES_DIAGNOSE: 'ghost:routines:diagnose',
  ROUTINES_SIMULATE: 'ghost:routines:simulate',
  ROUTINES_IMPORT_PREVIEW: 'ghost:routines:import-preview',
  ROUTINES_IMPORT_COMMIT: 'ghost:routines:import-commit',
  ROUTINES_EXPORT: 'ghost:routines:export',
  ROUTINES_STATS: 'ghost:routines:stats',
  ROUTINES_HISTORY: 'ghost:routines:history',
  ROUTINE_NOTIFICATIONS_LIST: 'ghost:routine-notifications:list',
  ROUTINE_NOTIFICATIONS_UNREAD_COUNT: 'ghost:routine-notifications:unread-count',
  ROUTINE_NOTIFICATIONS_MARK_READ: 'ghost:routine-notifications:mark-read',
  ROUTINE_NOTIFICATIONS_DISMISS: 'ghost:routine-notifications:dismiss',
} as const

export const AppErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().default(false),
})

export type AppError = z.infer<typeof AppErrorSchema>

export const DaemonHealthResponseSchema = z.object({
  ok: z.boolean(),
  pid: z.number().int().positive(),
  uptimeSec: z.number().nonnegative(),
  runtimeMode: z.enum(['codex', 'mock']),
})

export type DaemonHealthResponse = z.infer<typeof DaemonHealthResponseSchema>

export const ProviderSummarySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['subscription', 'local', 'mock']),
  status: z.enum(['connected', 'disconnected', 'unavailable', 'mock']),
  detail: z.string(),
})

export type ProviderSummary = z.infer<typeof ProviderSummarySchema>

export const AppInfoResponseSchema = z.object({
  name: z.literal('ghost-bot'),
  version: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  sandboxed: z.boolean(),
})

export type AppInfoResponse = z.infer<typeof AppInfoResponseSchema>

export const BotIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid bot identifier')

export const BotPermissionSchema = z.enum(['read-only', 'ask-approval', 'workspace'])

export const PresetAvatarSchema = z.object({
  kind: z.literal('preset').optional(),
  shape: z.enum([
    'ghost',
    'chief',
    'developer',
    'researcher',
    'creative',
    'assistant',
    'automation',
    'observer',
    'writer',
    'security',
    'analyst',
    'personal',
  ]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color'),
  eyes: z.enum(['classic', 'round', 'happy', 'sleepy']),
  rotation: z.number().min(-25).max(25),
  animation: z.boolean(),
})

export const CustomAvatarSchema = z.object({
  kind: z.literal('custom'),
  svgDataUrl: z
    .string()
    .min(30)
    .max(64 * 1024)
    .startsWith('data:image/svg+xml;base64,'),
  label: z.string().max(64).optional(),
})

export const BotAvatarConfigSchema = z.union([PresetAvatarSchema, CustomAvatarSchema])

export const BotRecordSchema = z.object({
  id: BotIdSchema,
  name: z.string().trim().min(1).max(60),
  description: z.string().max(160),
  instructions: z.string().max(4000),
  avatar: BotAvatarConfigSchema,
  runtimeId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
  effort: z.enum(['low', 'medium', 'high']),
  workspacePath: z.string().min(1).max(512),
  permission: BotPermissionSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export type BotRecord = z.infer<typeof BotRecordSchema>

export const BotsListResponseSchema = z.object({
  bots: z.array(BotRecordSchema),
  activeBotId: BotIdSchema.nullable(),
})

export type BotsListResponse = z.infer<typeof BotsListResponseSchema>

export const CreateBotInputSchema = z.object({
  name: z.string().trim().min(1, 'Bot name is required').max(60),
  description: z.string().trim().max(160).default(''),
  instructions: z.string().trim().max(4000).default(''),
  avatar: BotAvatarConfigSchema,
  runtimeId: z.string().min(1).max(64).default('mock-offline'),
  modelId: z.string().min(1).max(128).default('gpt-6.2-mock'),
  effort: z.enum(['low', 'medium', 'high']).default('medium'),
  workspacePath: z.string().trim().min(1).max(512).default('~'),
  permission: BotPermissionSchema.default('ask-approval'),
})

export type CreateBotInput = z.infer<typeof CreateBotInputSchema>

export const UpdateBotInputSchema = z.object({
  id: BotIdSchema,
  patch: z
    .object({
      name: z.string().trim().min(1).max(60).optional(),
      description: z.string().trim().max(160).optional(),
      instructions: z.string().trim().max(4000).optional(),
      avatar: BotAvatarConfigSchema.optional(),
      runtimeId: z.string().min(1).max(64).optional(),
      modelId: z.string().min(1).max(128).optional(),
      effort: z.enum(['low', 'medium', 'high']).optional(),
      workspacePath: z.string().trim().min(1).max(512).optional(),
      permission: BotPermissionSchema.optional(),
    })
    .strict(),
})

export type UpdateBotInput = z.infer<typeof UpdateBotInputSchema>

export const BotIdParamsSchema = z.object({ id: BotIdSchema }).strict()

export const SetActiveBotParamsSchema = z
  .object({ id: BotIdSchema.nullable() })
  .strict()

export const ImportAvatarSvgInputSchema = z
  .object({
    rawSvg: z.string().min(1).max(32 * 1024),
    label: z.string().trim().max(64).optional(),
  })
  .strict()

export const ImportAvatarSvgResponseSchema = z.object({
  svgDataUrl: z.string().startsWith('data:image/svg+xml;base64,'),
  label: z.string().optional(),
})

export type ImportAvatarSvgResponse = z.infer<typeof ImportAvatarSvgResponseSchema>

export const WorkspacePickResponseSchema = z.object({
  canceled: z.boolean(),
  path: z.string().nullable(),
})

export type WorkspacePickResponse = z.infer<typeof WorkspacePickResponseSchema>

export const EmptyParamsSchema = z.object({}).strict().optional()

export const GeneralSettingsSchema = z.object({
  launchBehavior: z.enum(['restore', 'new-session']).default('restore'),
  diagnosticsOptIn: z.boolean().default(false),
})

export const AppearanceSettingsSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']).default('dark'),
  reducedMotion: z.boolean().default(false),
  leftWidth: z.number().min(180).max(380).default(240),
  rightWidth: z.number().min(220).max(420).default(285),
  leftCollapsed: z.boolean().default(false),
  rightCollapsed: z.boolean().default(false),
})

export const PersonalizationSettingsSchema = z.object({
  defaultInstructions: z.string().max(2000).default(''),
  responseStyle: z.enum(['concise', 'balanced', 'detailed']).default('balanced'),
})

export const PermissionsSettingsSchema = z.object({
  defaultPermissionMode: BotPermissionSchema.default('ask-approval'),
})

export const PrivacySettingsSchema = z.object({
  redactLogs: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(365).default(30),
})

export const MemorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  automaticRetrieval: z.boolean().default(false),
  includeUserWide: z.boolean().default(false),
  externalProviderConsent: z.boolean().default(false),
})

export const MemorySettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    automaticRetrieval: z.boolean().optional(),
    includeUserWide: z.boolean().optional(),
    externalProviderConsent: z.boolean().optional(),
  })
  .strict()

export const KnowledgeSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  automaticRetrieval: z.boolean().default(false),
  includeUserWide: z.boolean().default(false),
  externalProviderConsent: z.boolean().default(false),
})

export const KnowledgeSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    automaticRetrieval: z.boolean().optional(),
    includeUserWide: z.boolean().optional(),
    externalProviderConsent: z.boolean().optional(),
  })
  .strict()

export const McpSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  externalProviderTransmissionConsent: z.boolean().default(false),
})

export const McpSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    externalProviderTransmissionConsent: z.boolean().optional(),
  })
  .strict()

export const AppSettingsSchema = z.object({
  general: GeneralSettingsSchema.prefault({}),
  appearance: AppearanceSettingsSchema.prefault({}),
  personalization: PersonalizationSettingsSchema.prefault({}),
  permissions: PermissionsSettingsSchema.prefault({}),
  privacy: PrivacySettingsSchema.prefault({}),
  memory: MemorySettingsSchema.prefault({}),
  knowledge: KnowledgeSettingsSchema.prefault({}),
  mcp: McpSettingsSchema.prefault({}),
})

export type AppSettings = z.infer<typeof AppSettingsSchema>

export const AppSettingsPatchSchema = z
  .object({
    general: GeneralSettingsSchema.partial().optional(),
    appearance: AppearanceSettingsSchema.partial().optional(),
    personalization: PersonalizationSettingsSchema.partial().optional(),
    permissions: PermissionsSettingsSchema.partial().optional(),
    privacy: PrivacySettingsSchema.partial().optional(),
    memory: MemorySettingsPatchSchema.optional(),
    knowledge: KnowledgeSettingsPatchSchema.optional(),
    mcp: McpSettingsPatchSchema.optional(),
  })
  .strict()

export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>

export const RuntimeAvailabilityStatusSchema = z.enum([
  'available',
  'stale',
  'unavailable',
  'unsupported',
  'auth-required',
  'disconnected',
  'error',
  'mock',
])

export type RuntimeAvailabilityStatus = z.infer<typeof RuntimeAvailabilityStatusSchema>

export const RuntimeUsageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number().min(0).max(100).nullable(),
  resetAt: z.string().nullable(),
})

export const RuntimeModelSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  efforts: z.array(z.string()),
})

export const RuntimeLifecycleStateSchema = z.enum([
  'unavailable',
  'connecting',
  'connected',
  'disconnected',
  'reconnecting',
  'authentication_required',
  'unsupported',
  'failed',
])

export type RuntimeLifecycleState = z.infer<typeof RuntimeLifecycleStateSchema>

export const RuntimeSnapshotSchema = z.object({
  runtimeMode: z.enum(['codex', 'mock']),
  codexVersion: z.string().nullable(),
  status: RuntimeAvailabilityStatusSchema,
  lifecycleState: RuntimeLifecycleStateSchema.optional(),
  authStatus: z.enum(['connected', 'disconnected', 'pending', 'error']),
  authMethod: z.enum(['chatgpt', 'apiKey', 'mock', 'none']),
  planType: z.string().nullable(),
  workspaceName: z.string().nullable(),
  detail: z.string(),
  models: z.array(RuntimeModelSummarySchema),
  usageStatus: RuntimeAvailabilityStatusSchema,
  usageWindows: z.array(RuntimeUsageWindowSchema),
  usageObservedAt: z.string().nullable(),
  verifiedPermissionModes: z.array(BotPermissionSchema),
  observedAt: z.string(),
  cached: z.boolean(),
})

export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>

export const RuntimeSnapshotParamsSchema = z
  .object({ refresh: z.boolean().optional() })
  .strict()
  .optional()

export const SessionIdSchema = z.string().trim().min(1).max(100)
export const RunIdSchema = z.string().trim().min(1).max(100)

export const RunStatusSchema = z.enum([
  'queued',
  'starting',
  'running',
  'awaiting_approval',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
])

export const SessionRecordSchema = z.object({
  id: SessionIdSchema,
  agentId: BotIdSchema,
  accountId: z.string(),
  runtimeId: z.string(),
  externalSessionId: z.string().nullable(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  lastMessagePreview: z.string().optional(),
  activeRunId: RunIdSchema.nullable().optional(),
  activeRunStatus: RunStatusSchema.nullable().optional(),
})

export type SessionRecord = z.infer<typeof SessionRecordSchema>

export const ListSessionsParamsSchema = z
  .object({
    agentId: BotIdSchema,
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict()

export const SessionsListResponseSchema = z.object({
  sessions: z.array(SessionRecordSchema),
  activeSessionId: SessionIdSchema.nullable(),
  total: z.number().int().nonnegative(),
})

export type SessionsListResponse = z.infer<typeof SessionsListResponseSchema>

export const CreateSessionInputSchema = z
  .object({
    agentId: BotIdSchema,
    title: z.string().trim().max(120).optional(),
  })
  .strict()

export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>

export const RenameSessionInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    title: z.string().trim().min(1).max(120),
  })
  .strict()

export type RenameSessionInput = z.infer<typeof RenameSessionInputSchema>

export const SessionIdParamsSchema = z.object({ sessionId: SessionIdSchema }).strict()

export const SetActiveSessionInputSchema = z
  .object({
    agentId: BotIdSchema,
    sessionId: SessionIdSchema.nullable(),
  })
  .strict()

export type SetActiveSessionInput = z.infer<typeof SetActiveSessionInputSchema>

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export const MessageStatusSchema = z.enum([
  'complete',
  'streaming',
  'interrupted',
  'cancelled',
  'failed',
])

export const PersistedMessageSchema = z.object({
  id: z.string(),
  sessionId: SessionIdSchema,
  role: MessageRoleSchema,
  text: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  seqOrder: z.number().int().nonnegative(),
  status: MessageStatusSchema,
  runId: RunIdSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type PersistedMessage = z.infer<typeof PersistedMessageSchema>

export const ListMessagesParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict()

export const MessagesListResponseSchema = z.object({
  session: SessionRecordSchema,
  messages: z.array(PersistedMessageSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})

export type MessagesListResponse = z.infer<typeof MessagesListResponseSchema>

export const ApprovalLifecycleStatusSchema = z.enum([
  'pending',
  'resolving',
  'approved',
  'denied',
  'expired',
  'revoked',
  'resolution_failed',
])

export const PendingApprovalSchema = z.object({
  approvalId: z.string(),
  title: z.string(),
  command: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  actionType: z.string().optional(),
  argsHash: z.string().optional(),
  permissionMode: z.string().optional(),
  expiresAt: z.string().optional(),
  isMock: z.boolean().optional(),
  status: ApprovalLifecycleStatusSchema.optional(),
})

export const RunRecordSchema = z.object({
  id: RunIdSchema,
  sessionId: SessionIdSchema,
  agentId: BotIdSchema,
  idempotencyKey: z.string(),
  runtimeId: z.string(),
  modelId: z.string(),
  effort: z.string(),
  permissionMode: z.string(),
  configSnapshot: z.record(z.string(), z.unknown()),
  status: RunStatusSchema,
  error: AppErrorSchema.nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  createdAt: z.string(),
  pendingApproval: PendingApprovalSchema.nullable(),
})

export type RunRecord = z.infer<typeof RunRecordSchema>

export const StartRunInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    idempotencyKey: z.string().trim().min(1).max(128),
    text: z.string().trim().min(1).max(32_000),
  })
  .strict()

export type StartRunInput = z.infer<typeof StartRunInputSchema>

export const StartRunResponseSchema = z.object({
  run: RunRecordSchema,
  deduplicated: z.boolean(),
  userMessageId: z.string(),
  assistantMessageId: z.string(),
})

export type StartRunResponse = z.infer<typeof StartRunResponseSchema>

export const RunIdParamsSchema = z.object({ runId: RunIdSchema }).strict()

export const CancelRunResponseSchema = z.object({
  run: RunRecordSchema,
  alreadyTerminal: z.boolean(),
})

export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>

export const PersistedRunEventSchema = z.object({
  id: z.string(),
  runId: RunIdSchema,
  seq: z.number().int().positive(),
  eventKey: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  timestamp: z.string(),
})

export type PersistedRunEvent = z.infer<typeof PersistedRunEventSchema>

export const ListRunEventsParamsSchema = z
  .object({
    runId: RunIdSchema,
    afterSeq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()

export const RunEventsResponseSchema = z.object({
  events: z.array(PersistedRunEventSchema),
  hasMore: z.boolean(),
  lastSeq: z.number().int().nonnegative(),
})

export type RunEventsResponse = z.infer<typeof RunEventsResponseSchema>

export const ResolveApprovalInputSchema = z
  .object({
    runId: RunIdSchema,
    approvalId: z.string().trim().min(1).max(128),
    decision: z.enum(['approved', 'denied']),
    argsHash: z.string().trim().min(1).max(128).optional(),
  })
  .strict()

export type ResolveApprovalInput = z.infer<typeof ResolveApprovalInputSchema>

export const ResolveApprovalResponseSchema = z.object({
  run: RunRecordSchema,
})

export type ResolveApprovalResponse = z.infer<typeof ResolveApprovalResponseSchema>

export const SessionInspectionResponseSchema = z.object({
  sessionId: SessionIdSchema,
  agentId: BotIdSchema,
  runtimeId: z.string(),
  externalSessionId: z.string().nullable(),
  providerThreadStatus: z
    .enum(['not_applicable', 'accessible', 'unavailable', 'unknown'])
    .optional(),
  hasToolActivity: z.boolean().optional(),
  resumable: z.boolean(),
  reason: z.string(),
  quarantined: z.boolean(),
  lastRun: RunRecordSchema.nullable(),
  approvalsCount: z.number().int().nonnegative(),
})

export type SessionInspectionResponse = z.infer<typeof SessionInspectionResponseSchema>

export const RetryRunInputSchema = z
  .object({
    runId: RunIdSchema,
    idempotencyKey: z.string().trim().min(1).max(128),
    confirmSideEffects: z.boolean().optional(),
  })
  .strict()

export type RetryRunInput = z.infer<typeof RetryRunInputSchema>

export const MemoryIpcIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid memory identifier')

export const MemoryCategoryIpcSchema = z.enum([
  'preference',
  'fact',
  'instruction_note',
  'project_context',
  'glossary',
  'other',
])

export const MemoryScopeInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('bot'), botId: BotIdSchema }).strict(),
  z.object({ kind: z.literal('workspace'), botId: BotIdSchema }).strict(),
])

export const MemoryRecordDtoSchema = z.object({
  id: MemoryIpcIdSchema,
  scopeKind: z.enum(['user', 'bot', 'workspace']),
  botId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  origin: z.enum(['explicit', 'inferred']),
  category: MemoryCategoryIpcSchema,
  content: z.string(),
  tags: z.array(z.string()),
  status: z.enum(['active', 'archived']),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
})

export type MemoryRecordDto = z.infer<typeof MemoryRecordDtoSchema>

export const ListMemoriesIpcInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    scopeKind: z.enum(['user', 'bot', 'workspace']).optional(),
    includeUserWide: z.boolean().default(false),
    includeArchived: z.boolean().default(false),
    category: MemoryCategoryIpcSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
  .strict()

export type ListMemoriesIpcInput = z.infer<typeof ListMemoriesIpcInputSchema>

export const ListMemoriesResponseSchema = z.object({
  records: z.array(MemoryRecordDtoSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})

export type ListMemoriesResponse = z.infer<typeof ListMemoriesResponseSchema>

export const SearchMemoriesIpcInputSchema = z
  .object({
    query: z.string().trim().min(1).max(256),
    botId: BotIdSchema.optional(),
    scopeKind: z.enum(['user', 'bot', 'workspace']).optional(),
    includeUserWide: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()

export type SearchMemoriesIpcInput = z.infer<typeof SearchMemoriesIpcInputSchema>

export const SearchMemoriesResponseSchema = z.object({
  matches: z.array(
    z.object({
      record: MemoryRecordDtoSchema,
      score: z.number(),
    }),
  ),
  engine: z.enum(['fts5', 'lexical_fallback']),
  total: z.number().int().nonnegative(),
})

export type SearchMemoriesResponse = z.infer<typeof SearchMemoriesResponseSchema>

export const CreateMemoryIpcInputSchema = z
  .object({
    scope: MemoryScopeInputSchema,
    category: MemoryCategoryIpcSchema,
    content: z.string().trim().min(1).max(4000),
    tags: z.array(z.string().trim().min(1).max(48)).max(16).default([]),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()

export type CreateMemoryIpcInput = z.infer<typeof CreateMemoryIpcInputSchema>

export const UpdateMemoryIpcInputSchema = z
  .object({
    id: MemoryIpcIdSchema,
    content: z.string().trim().min(1).max(4000).optional(),
    category: MemoryCategoryIpcSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(16).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()

export type UpdateMemoryIpcInput = z.infer<typeof UpdateMemoryIpcInputSchema>

export const MemoryIdParamSchema = z
  .object({
    id: MemoryIpcIdSchema,
  })
  .strict()

export const KnowledgeIpcIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid knowledge identifier')

export const KnowledgeScopeInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('bot'), botId: BotIdSchema }).strict(),
  z.object({ kind: z.literal('workspace'), botId: BotIdSchema }).strict(),
])

export const KnowledgeCollectionDtoSchema = z.object({
  id: KnowledgeIpcIdSchema,
  scopeKind: z.enum(['user', 'bot', 'workspace']),
  botId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  status: z.enum(['active', 'archived']),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type KnowledgeCollectionDto = z.infer<typeof KnowledgeCollectionDtoSchema>

export const KnowledgeDocumentDtoSchema = z.object({
  id: KnowledgeIpcIdSchema,
  collectionId: KnowledgeIpcIdSchema.nullable(),
  scopeKind: z.enum(['user', 'bot', 'workspace']),
  botId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  title: z.string(),
  sourceType: z.enum(['direct_text', 'text_file', 'markdown']),
  mediaType: z.enum(['text/plain', 'text/markdown']),
  displayFilename: z.string().nullable(),
  tags: z.array(z.string()),
  status: z.enum(['ready', 'archived']),
  currentRevisionId: KnowledgeIpcIdSchema,
  revisionNumber: z.number().int().positive().optional(),
  chunkCount: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
})

export type KnowledgeDocumentDto = z.infer<typeof KnowledgeDocumentDtoSchema>

export const KnowledgeCitationDtoSchema = z.object({
  documentId: KnowledgeIpcIdSchema,
  revisionId: KnowledgeIpcIdSchema,
  chunkId: KnowledgeIpcIdSchema,
  title: z.string(),
  displayFilename: z.string().nullable(),
  sectionPath: z.array(z.string()),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().nonnegative(),
  pageNumber: z.number().int().positive().nullable(),
  excerpt: z.string(),
})

export type KnowledgeCitationDto = z.infer<typeof KnowledgeCitationDtoSchema>

export const ListKnowledgeCollectionsInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    scopeKind: z.enum(['user', 'bot', 'workspace']).optional(),
    includeUserWide: z.boolean().default(false),
  })
  .strict()

export type ListKnowledgeCollectionsInput = z.infer<typeof ListKnowledgeCollectionsInputSchema>

export const CreateKnowledgeCollectionInputSchema = z
  .object({
    scope: KnowledgeScopeInputSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(240).default(''),
  })
  .strict()

export type CreateKnowledgeCollectionInput = z.infer<typeof CreateKnowledgeCollectionInputSchema>

export const ListKnowledgeDocsInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    scopeKind: z.enum(['user', 'bot', 'workspace']).optional(),
    collectionId: KnowledgeIpcIdSchema.optional(),
    includeUserWide: z.boolean().default(false),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
  .strict()

export type ListKnowledgeDocsInput = z.infer<typeof ListKnowledgeDocsInputSchema>

export const ListKnowledgeDocsResponseSchema = z.object({
  documents: z.array(KnowledgeDocumentDtoSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})

export type ListKnowledgeDocsResponse = z.infer<typeof ListKnowledgeDocsResponseSchema>

export const SearchKnowledgeDocsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(256),
    botId: BotIdSchema.optional(),
    scopeKind: z.enum(['user', 'bot', 'workspace']).optional(),
    collectionId: KnowledgeIpcIdSchema.optional(),
    includeUserWide: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()

export type SearchKnowledgeDocsInput = z.infer<typeof SearchKnowledgeDocsInputSchema>

export const SearchKnowledgeDocsResponseSchema = z.object({
  matches: z.array(
    z.object({
      document: KnowledgeDocumentDtoSchema,
      citation: KnowledgeCitationDtoSchema,
      score: z.number(),
    }),
  ),
  engine: z.enum(['fts5', 'lexical_fallback']),
  total: z.number().int().nonnegative(),
})

export type SearchKnowledgeDocsResponse = z.infer<typeof SearchKnowledgeDocsResponseSchema>

export const IngestKnowledgeTextInputSchema = z
  .object({
    scope: KnowledgeScopeInputSchema,
    collectionId: KnowledgeIpcIdSchema.nullable().default(null),
    title: z.string().trim().min(1).max(160),
    sourceType: z.enum(['direct_text', 'markdown']).default('direct_text'),
    text: z.string().min(1).max(512 * 1024),
    tags: z.array(z.string().trim().min(1).max(48)).max(16).default([]),
  })
  .strict()

export type IngestKnowledgeTextInput = z.infer<typeof IngestKnowledgeTextInputSchema>

export const PickAndIngestKnowledgeFileInputSchema = z
  .object({
    scope: KnowledgeScopeInputSchema,
    collectionId: KnowledgeIpcIdSchema.nullable().default(null),
    tags: z.array(z.string().trim().min(1).max(48)).max(16).default([]),
  })
  .strict()

export type PickAndIngestKnowledgeFileInput = z.infer<typeof PickAndIngestKnowledgeFileInputSchema>

export const UpdateKnowledgeDocInputSchema = z
  .object({
    id: KnowledgeIpcIdSchema,
    title: z.string().trim().min(1).max(160).optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(16).optional(),
    collectionId: KnowledgeIpcIdSchema.nullable().optional(),
  })
  .strict()

export type UpdateKnowledgeDocInput = z.infer<typeof UpdateKnowledgeDocInputSchema>

export const ReplaceKnowledgeDocTextInputSchema = z
  .object({
    id: KnowledgeIpcIdSchema,
    title: z.string().trim().min(1).max(160).optional(),
    sourceType: z.enum(['direct_text', 'markdown']).default('direct_text'),
    text: z.string().min(1).max(512 * 1024),
    tags: z.array(z.string().trim().min(1).max(48)).max(16).optional(),
  })
  .strict()

export type ReplaceKnowledgeDocTextInput = z.infer<typeof ReplaceKnowledgeDocTextInputSchema>

export const KnowledgeIdParamSchema = z
  .object({
    id: KnowledgeIpcIdSchema,
  })
  .strict()

export const ResolveKnowledgeCitationInputSchema = z
  .object({
    documentId: KnowledgeIpcIdSchema,
    revisionId: KnowledgeIpcIdSchema,
    chunkId: KnowledgeIpcIdSchema,
    botId: BotIdSchema.optional(),
    includeUserWide: z.boolean().default(false),
  })
  .strict()

export type ResolveKnowledgeCitationInput = z.infer<typeof ResolveKnowledgeCitationInputSchema>

export const ResolveKnowledgeCitationResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  citation: KnowledgeCitationDtoSchema.nullable(),
})

export type ResolveKnowledgeCitationResponse = z.infer<typeof ResolveKnowledgeCitationResponseSchema>

export const McpIpcIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/, 'Invalid MCP identifier')

export const McpEnvVarNameDtoSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'Invalid environment variable name')

export const McpScopeInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('bot'), botId: BotIdSchema }).strict(),
  z
    .object({
      kind: z.literal('workspace'),
      workspacePath: z.string().trim().min(1).max(512),
    })
    .strict(),
])

export type McpScopeInput = z.infer<typeof McpScopeInputSchema>

export const McpSecretRefDtoSchema = z
  .object({
    envVar: McpEnvVarNameDtoSchema,
    refId: McpIpcIdSchema,
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict()

export const McpStdioTransportDtoSchema = z
  .object({
    type: z.literal('stdio'),
    executablePath: z.string().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(64).default([]),
    cwd: z.string().min(1).max(1024),
    envAllowlist: z.array(McpEnvVarNameDtoSchema).max(64).default([]),
    secretRefs: z.array(McpSecretRefDtoSchema).max(32).default([]),
  })
  .strict()

export const McpTrustStateDtoSchema = z.enum(['untrusted', 'trusted', 'revoked'])
export type McpTrustStateDto = z.infer<typeof McpTrustStateDtoSchema>

export const McpConnectionStateDtoSchema = z.enum([
  'disconnected',
  'connecting',
  'ready',
  'disconnecting',
  'failed',
])
export type McpConnectionStateDto = z.infer<typeof McpConnectionStateDtoSchema>

export const McpServerDtoSchema = z.object({
  id: McpIpcIdSchema,
  scope: McpScopeInputSchema,
  displayName: z.string(),
  description: z.string(),
  transport: McpStdioTransportDtoSchema,
  enabled: z.boolean(),
  trustState: McpTrustStateDtoSchema,
  configFingerprint: z.string(),
  trustedFingerprint: z.string().nullable(),
  trustedBinaryDigest: z.string().nullable(),
  connectTimeoutMs: z.number().int(),
  requestTimeoutMs: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  connectionState: McpConnectionStateDtoSchema.optional(),
  lastError: z.string().nullable().optional(),
  pid: z.number().int().nullable().optional(),
  generation: z.number().int().nonnegative().optional(),
})

export type McpServerDto = z.infer<typeof McpServerDtoSchema>

export const McpToolDescriptorDtoSchema = z.object({
  capabilityKey: z.string(),
  serverId: McpIpcIdSchema,
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  definitionHash: z.string(),
})

export const McpResourceDescriptorDtoSchema = z.object({
  capabilityKey: z.string(),
  serverId: McpIpcIdSchema,
  uri: z.string(),
  name: z.string(),
  description: z.string(),
  mimeType: z.string().optional(),
})

export const McpResourceTemplateDescriptorDtoSchema = z.object({
  capabilityKey: z.string(),
  serverId: McpIpcIdSchema,
  uriTemplate: z.string(),
  name: z.string(),
  description: z.string(),
  mimeType: z.string().optional(),
})

export const McpPromptArgumentDtoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
})

export const McpPromptDescriptorDtoSchema = z.object({
  capabilityKey: z.string(),
  serverId: McpIpcIdSchema,
  name: z.string(),
  description: z.string(),
  arguments: z.array(McpPromptArgumentDtoSchema).optional(),
})

export const McpCapabilitySnapshotDtoSchema = z.object({
  serverId: McpIpcIdSchema,
  discoveredAt: z.string(),
  configFingerprint: z.string(),
  tools: z.array(McpToolDescriptorDtoSchema),
  resources: z.array(McpResourceDescriptorDtoSchema),
  resourceTemplates: z.array(McpResourceTemplateDescriptorDtoSchema),
  prompts: z.array(McpPromptDescriptorDtoSchema),
})

export type McpCapabilitySnapshotDto = z.infer<typeof McpCapabilitySnapshotDtoSchema>

export const ListMcpServersInputSchema = z
  .object({
    scopeKinds: z.array(z.enum(['user', 'bot', 'workspace'])).min(1).max(3).optional(),
    botId: BotIdSchema.optional(),
    includeUserWide: z.boolean().default(true),
    enabledOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(100),
    offset: z.number().int().min(0).max(100_000).default(0),
  })
  .strict()

export type ListMcpServersInput = z.infer<typeof ListMcpServersInputSchema>

export const ListMcpServersResponseSchema = z.object({
  servers: z.array(McpServerDtoSchema),
  total: z.number().int().nonnegative(),
})

export type ListMcpServersResponse = z.infer<typeof ListMcpServersResponseSchema>

export const RegisterMcpServerIpcInputSchema = z
  .object({
    id: McpIpcIdSchema.optional(),
    scope: McpScopeInputSchema,
    displayName: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(''),
    transport: McpStdioTransportDtoSchema,
    connectTimeoutMs: z.number().int().min(500).max(30_000).optional(),
    requestTimeoutMs: z.number().int().min(500).max(30_000).optional(),
  })
  .strict()

export type RegisterMcpServerIpcInput = z.infer<typeof RegisterMcpServerIpcInputSchema>

export const UpdateMcpServerIpcInputSchema = z
  .object({
    id: McpIpcIdSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    transport: McpStdioTransportDtoSchema.optional(),
    connectTimeoutMs: z.number().int().min(500).max(30_000).optional(),
    requestTimeoutMs: z.number().int().min(500).max(30_000).optional(),
  })
  .strict()

export type UpdateMcpServerIpcInput = z.infer<typeof UpdateMcpServerIpcInputSchema>

export const McpServerIdParamSchema = z
  .object({
    id: McpIpcIdSchema,
  })
  .strict()

export const SetMcpServerEnabledInputSchema = z
  .object({
    id: McpIpcIdSchema,
    enabled: z.boolean(),
  })
  .strict()

export type SetMcpServerEnabledInput = z.infer<typeof SetMcpServerEnabledInputSchema>

export const McpConnectionStatusDtoSchema = z.object({
  serverId: McpIpcIdSchema,
  state: McpConnectionStateDtoSchema,
  generation: z.number().int().nonnegative(),
  configFingerprint: z.string(),
  pid: z.number().int().nullable(),
  lastError: z.string().nullable(),
  hasCapabilities: z.boolean(),
})

export type McpConnectionStatusDto = z.infer<typeof McpConnectionStatusDtoSchema>

export const ReadMcpResourceInputSchema = z
  .object({
    serverId: McpIpcIdSchema,
    uri: z.string().min(1).max(2048),
    botId: BotIdSchema.optional(),
  })
  .strict()

export type ReadMcpResourceInput = z.infer<typeof ReadMcpResourceInputSchema>

export const ReadMcpResourceResponseSchema = z.object({
  serverId: McpIpcIdSchema,
  uri: z.string(),
  contents: z.array(
    z.object({
      uri: z.string(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
      blobBase64: z.string().optional(),
    }),
  ),
})

export type ReadMcpResourceResponse = z.infer<typeof ReadMcpResourceResponseSchema>

export const GetMcpPromptInputSchema = z
  .object({
    serverId: McpIpcIdSchema,
    name: z.string().min(1).max(160),
    args: z.record(z.string(), z.string().max(4096)).optional(),
    botId: BotIdSchema.optional(),
  })
  .strict()

export type GetMcpPromptInput = z.infer<typeof GetMcpPromptInputSchema>

export const GetMcpPromptResponseSchema = z.object({
  serverId: McpIpcIdSchema,
  name: z.string(),
  description: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.object({
        type: z.string(),
        text: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    }),
  ),
})

export type GetMcpPromptResponse = z.infer<typeof GetMcpPromptResponseSchema>

export const TeamIpcIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid team identifier')

export const TeamBoundsInputSchema = z
  .object({
    maxDepth: z.number().int().min(0).max(5).optional(),
    maxAttempts: z.number().int().min(1).max(5).optional(),
    maxTokens: z.number().int().min(100).max(500_000).optional(),
    maxDurationMs: z.number().int().min(1000).max(3_600_000).optional(),
    maxConcurrentTasks: z.number().int().min(1).max(6).optional(),
    maxTasksPerRun: z.number().int().min(1).max(100).optional(),
    maxMessages: z.number().int().min(1).max(2000).optional(),
    maxResultBytes: z.number().int().min(1024).max(524_288).optional(),
  })
  .strict()

export const ListTeamsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict()

export const CreateTeamIpcInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    leadBotId: BotIdSchema,
    memberBotIds: z.array(BotIdSchema).min(1).max(12),
    bounds: TeamBoundsInputSchema.optional(),
  })
  .strict()

export const UpdateTeamIpcInputSchema = z
  .object({
    teamId: TeamIpcIdSchema,
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    leadBotId: BotIdSchema.optional(),
    memberBotIds: z.array(BotIdSchema).min(1).max(12).optional(),
    bounds: TeamBoundsInputSchema.optional(),
  })
  .strict()

export const UpdateTeamMembersIpcInputSchema = z
  .object({
    teamId: TeamIpcIdSchema,
    memberBotIds: z.array(BotIdSchema).min(1).max(12),
  })
  .strict()

export const TeamIdParamSchema = z.object({ teamId: TeamIpcIdSchema }).strict()
export const TeamRunIdParamSchema = z.object({ teamRunId: TeamIpcIdSchema }).strict()

export const TeamPlanTaskInputSchema = z
  .object({
    planKey: z.string().min(1).max(64),
    assignedBotId: BotIdSchema,
    prompt: z.string().min(1).max(16_384),
    dependsOn: z.array(z.string().min(1).max(64)).max(25).optional(),
    tokenBudget: z.number().int().min(1).max(500_000).optional(),
    durationBudgetMs: z.number().int().min(1000).max(3_600_000).optional(),
  })
  .strict()

export const TeamPlanInputSchema = z
  .object({
    summary: z.string().min(1).max(1000),
    tasks: z.array(TeamPlanTaskInputSchema).min(1).max(100),
  })
  .strict()

export const PreviewTeamPlanIpcInputSchema = z
  .object({
    teamId: TeamIpcIdSchema,
    plan: TeamPlanInputSchema,
  })
  .strict()

export const StartTeamRunIpcInputSchema = z
  .object({
    teamId: TeamIpcIdSchema,
    goal: z.string().min(1).max(16_384),
    idempotencyKey: z.string().min(1).max(128),
    plan: TeamPlanInputSchema.optional(),
    autoExecute: z.boolean().optional(),
  })
  .strict()

export const ListTeamMessagesIpcInputSchema = z
  .object({
    teamId: TeamIpcIdSchema,
    teamRunId: TeamIpcIdSchema.optional(),
    viewerBotId: BotIdSchema.optional(),
    afterSeq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict()

export const TeamRecordDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  ownerId: z.string(),
  leadBotId: z.string(),
  memberBotIds: z.array(z.string()),
  memorySharingPolicy: z.literal('explicit-only'),
  bounds: z.record(z.string(), z.number()),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type TeamRecordDto = z.infer<typeof TeamRecordDtoSchema>
export type CreateTeamIpcInput = z.infer<typeof CreateTeamIpcInputSchema>
export type UpdateTeamIpcInput = z.infer<typeof UpdateTeamIpcInputSchema>
export type UpdateTeamMembersIpcInput = z.infer<typeof UpdateTeamMembersIpcInputSchema>
export type PreviewTeamPlanIpcInput = z.infer<typeof PreviewTeamPlanIpcInputSchema>
export type StartTeamRunIpcInput = z.infer<typeof StartTeamRunIpcInputSchema>
export type ListTeamMessagesIpcInput = z.infer<typeof ListTeamMessagesIpcInputSchema>

export interface GhostBotBridge {
  getAppInfo(): Promise<AppInfoResponse>
  getDaemonHealth(): Promise<DaemonHealthResponse>
  listProviders(): Promise<ProviderSummary[]>
  listBots(): Promise<BotsListResponse>
  createBot(input: CreateBotInput): Promise<BotRecord>
  updateBot(input: UpdateBotInput): Promise<BotRecord>
  duplicateBot(id: string): Promise<BotRecord>
  deleteBot(id: string): Promise<{ deletedId: string; activeBotId: string | null }>
  setActiveBot(id: string | null): Promise<{ activeBotId: string | null }>
  importAvatarSvg(rawSvg: string, label?: string): Promise<ImportAvatarSvgResponse>
  pickWorkspace(): Promise<WorkspacePickResponse>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: AppSettingsPatch): Promise<AppSettings>
  resetSettings(): Promise<AppSettings>
  migrateLocalSettings(legacy: Partial<AppearanceSettingsInput>): Promise<AppSettings>
  getRuntimeSnapshot(refresh?: boolean): Promise<RuntimeSnapshot>
  listSessions(params: { agentId: string; limit?: number; offset?: number }): Promise<SessionsListResponse>
  createSession(input: CreateSessionInput): Promise<SessionRecord>
  renameSession(input: RenameSessionInput): Promise<SessionRecord>
  archiveSession(sessionId: string): Promise<{ archivedId: string; activeSessionId: string | null }>
  setActiveSession(input: SetActiveSessionInput): Promise<{ agentId: string; activeSessionId: string | null }>
  listMessages(params: { sessionId: string; limit?: number; offset?: number }): Promise<MessagesListResponse>
  startRun(input: StartRunInput): Promise<StartRunResponse>
  getRun(runId: string): Promise<RunRecord>
  cancelRun(runId: string): Promise<CancelRunResponse>
  getRunEvents(params: { runId: string; afterSeq?: number; limit?: number }): Promise<RunEventsResponse>
  resolveApproval(input: ResolveApprovalInput): Promise<ResolveApprovalResponse>
  reconnectRuntime(): Promise<RuntimeSnapshot>
  inspectSession(sessionId: string): Promise<SessionInspectionResponse>
  retryRun(input: RetryRunInput): Promise<StartRunResponse>
  listMemories(input?: Partial<ListMemoriesIpcInput>): Promise<ListMemoriesResponse>
  searchMemories(input: SearchMemoriesIpcInput): Promise<SearchMemoriesResponse>
  createMemory(input: CreateMemoryIpcInput): Promise<MemoryRecordDto>
  updateMemory(input: UpdateMemoryIpcInput): Promise<MemoryRecordDto>
  archiveMemory(id: string): Promise<MemoryRecordDto>
  deleteMemory(id: string): Promise<{ deletedId: string }>
  listKnowledgeCollections(input?: Partial<ListKnowledgeCollectionsInput>): Promise<{ collections: KnowledgeCollectionDto[] }>
  createKnowledgeCollection(input: CreateKnowledgeCollectionInput): Promise<KnowledgeCollectionDto>
  listKnowledgeDocuments(input?: Partial<ListKnowledgeDocsInput>): Promise<ListKnowledgeDocsResponse>
  searchKnowledgeDocuments(input: SearchKnowledgeDocsInput): Promise<SearchKnowledgeDocsResponse>
  ingestKnowledgeText(input: IngestKnowledgeTextInput): Promise<KnowledgeDocumentDto>
  pickAndIngestKnowledgeFile(input: PickAndIngestKnowledgeFileInput): Promise<{ canceled: boolean; document: KnowledgeDocumentDto | null }>
  updateKnowledgeDocument(input: UpdateKnowledgeDocInput): Promise<KnowledgeDocumentDto>
  replaceKnowledgeDocumentText(input: ReplaceKnowledgeDocTextInput): Promise<KnowledgeDocumentDto>
  archiveKnowledgeDocument(id: string): Promise<KnowledgeDocumentDto>
  deleteKnowledgeDocument(id: string): Promise<{ deletedId: string }>
  resolveKnowledgeCitation(input: ResolveKnowledgeCitationInput): Promise<ResolveKnowledgeCitationResponse>
  listMcpServers(input?: Partial<ListMcpServersInput>): Promise<ListMcpServersResponse>
  registerMcpServer(input: RegisterMcpServerIpcInput): Promise<McpServerDto>
  updateMcpServer(input: UpdateMcpServerIpcInput): Promise<McpServerDto>
  approveMcpTrust(id: string): Promise<McpServerDto>
  revokeMcpTrust(id: string): Promise<McpServerDto>
  setMcpServerEnabled(input: SetMcpServerEnabledInput): Promise<McpServerDto>
  deleteMcpServer(id: string): Promise<{ deletedId: string }>
  connectMcpServer(id: string): Promise<McpConnectionStatusDto>
  disconnectMcpServer(id: string): Promise<McpConnectionStatusDto>
  getMcpCapabilities(id: string): Promise<McpCapabilitySnapshotDto | null>
  readMcpResource(input: ReadMcpResourceInput): Promise<ReadMcpResourceResponse>
  getMcpPrompt(input: GetMcpPromptInput): Promise<GetMcpPromptResponse>
  listTeams(input?: z.infer<typeof ListTeamsInputSchema>): Promise<{ teams: TeamRecordDto[]; total: number }>
  createTeam(input: CreateTeamIpcInput): Promise<TeamRecordDto>
  updateTeam(input: UpdateTeamIpcInput): Promise<TeamRecordDto>
  updateTeamMembers(input: UpdateTeamMembersIpcInput): Promise<TeamRecordDto>
  archiveTeam(teamId: string): Promise<TeamRecordDto>
  previewTeamPlan(input: PreviewTeamPlanIpcInput): Promise<Record<string, unknown>>
  startTeamRun(input: StartTeamRunIpcInput): Promise<Record<string, unknown>>
  listTeamRuns(teamId: string): Promise<{ runs: Array<Record<string, unknown>> }>
  getTeamRun(teamRunId: string): Promise<Record<string, unknown>>
  cancelTeamRun(teamRunId: string): Promise<Record<string, unknown>>
  listTeamRunTasks(teamRunId: string): Promise<{ tasks: Array<Record<string, unknown>> }>
  getTeamDiagnostics(teamRunId: string): Promise<Record<string, unknown>>
  getTeamAggregateUsage(teamRunId: string): Promise<Record<string, unknown>>
  listTeamRunApprovals(teamRunId: string): Promise<{ approvals: Array<Record<string, unknown>> }>
  listTeamMessages(input: ListTeamMessagesIpcInput): Promise<{ messages: Array<Record<string, unknown>> }>
  listRoutines(input?: z.infer<typeof ListRoutinesIpcInputSchema>): Promise<{ routines: Array<Record<string, unknown>> }>
  getRoutine(input: z.infer<typeof RoutineScopeParamSchema>): Promise<Record<string, unknown>>
  createRoutine(input: z.infer<typeof CreateRoutineIpcInputSchema>): Promise<Record<string, unknown>>
  updateRoutine(input: z.infer<typeof UpdateRoutineIpcInputSchema>): Promise<Record<string, unknown>>
  enableRoutine(input: z.infer<typeof RoutineScopeParamSchema>): Promise<Record<string, unknown>>
  disableRoutine(input: z.infer<typeof RoutineScopeParamSchema>): Promise<Record<string, unknown>>
  archiveRoutine(input: z.infer<typeof RoutineScopeParamSchema>): Promise<Record<string, unknown>>
  triggerRoutine(input: z.infer<typeof TriggerRoutineIpcInputSchema>): Promise<Record<string, unknown>>
  getRoutineTask(input: z.infer<typeof RoutineTaskParamSchema>): Promise<Record<string, unknown>>
  cancelRoutineTask(input: z.infer<typeof RoutineTaskParamSchema>): Promise<Record<string, unknown>>
  previewRoutineSchedule(input: z.infer<typeof RoutineCountParamSchema>): Promise<Record<string, unknown>>
  diagnoseRoutine(input: z.infer<typeof RoutineScopeParamSchema>): Promise<Record<string, unknown>>
  simulateRoutine(input: z.infer<typeof RoutineCountParamSchema>): Promise<Record<string, unknown>>
  previewRoutineImport(input: z.infer<typeof ImportRoutineIpcInputSchema>): Promise<Record<string, unknown>>
  commitRoutineImport(input: z.infer<typeof ImportRoutineIpcInputSchema>): Promise<Record<string, unknown>>
  exportRoutines(input: { botId: string }): Promise<Record<string, unknown>>
  getRoutineStats(input: z.infer<typeof RoutineScopeParamSchema>): Promise<Record<string, unknown>>
  listRoutineHistory(input: z.infer<typeof RoutineCountParamSchema>): Promise<{ tasks: Array<Record<string, unknown>> }>
  listRoutineNotifications(input: z.infer<typeof ListRoutineNotificationsIpcInputSchema>): Promise<{ notifications: Array<Record<string, unknown>> }>
  getRoutineUnreadNotificationCount(input: { botId: string }): Promise<{ unreadCount: number }>
  markRoutineNotificationRead(input: z.infer<typeof RoutineNotificationParamSchema>): Promise<Record<string, unknown>>
  dismissRoutineNotification(input: z.infer<typeof RoutineNotificationParamSchema>): Promise<Record<string, unknown>>
}

export const RoutineIpcIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{3,128}$/)

export const RoutineScopeParamSchema = z
  .object({
    routineId: RoutineIpcIdSchema,
    botId: BotIdSchema,
  })
  .strict()

export const RoutineCountParamSchema = z
  .object({
    routineId: RoutineIpcIdSchema,
    botId: BotIdSchema,
    count: z.number().int().min(1).max(100).optional(),
  })
  .strict()

export const RoutineTaskParamSchema = z
  .object({
    taskId: RoutineIpcIdSchema,
    botId: BotIdSchema,
  })
  .strict()

export const ListRoutinesIpcInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict()

export const RoutineTriggerInputSchema = z.union([
  z.object({ kind: z.literal('one_time'), runAt: z.string().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal('interval'),
      intervalMs: z.number().int().min(60_000).max(31_536_000_000),
      startAt: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('daily'),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
  z
    .object({
      kind: z.literal('weekly'),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().min(5).max(120) }).strict(),
  z
    .object({
      kind: z.literal('event'),
      source: z.string().min(1).max(64),
      eventType: z.string().min(1).max(120),
    })
    .strict(),
])

export const CreateRoutineIpcInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    botId: BotIdSchema,
    targetType: z.enum(['bot', 'team']).optional(),
    teamId: TeamIpcIdSchema.nullable().optional(),
    trigger: RoutineTriggerInputSchema,
    timezone: z.string().min(1).max(64).optional(),
    task: z
      .object({
        prompt: z.string().min(1).max(16_384),
        kind: z.enum(['prompt', 'team_goal']).optional(),
      })
      .strict(),
    enabled: z.boolean().optional(),
    missedRunPolicy: z.enum(['skip', 'run_once', 'catch_up_bounded']).optional(),
    maxCatchUpRuns: z.number().int().min(1).max(10).optional(),
    concurrencyPolicy: z.enum(['forbid', 'allow_bounded', 'replace']).optional(),
    maxConcurrentRuns: z.number().int().min(1).max(5).optional(),
    expiresAt: z.string().min(1).max(64).nullable().optional(),
  })
  .strict()

export const UpdateRoutineIpcInputSchema = z
  .object({
    routineId: RoutineIpcIdSchema,
    botId: BotIdSchema,
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    targetType: z.enum(['bot', 'team']).optional(),
    teamId: TeamIpcIdSchema.nullable().optional(),
    trigger: RoutineTriggerInputSchema.optional(),
    timezone: z.string().min(1).max(64).optional(),
    task: z
      .object({
        prompt: z.string().min(1).max(16_384),
        kind: z.enum(['prompt', 'team_goal']).optional(),
      })
      .strict()
      .optional(),
    missedRunPolicy: z.enum(['skip', 'run_once', 'catch_up_bounded']).optional(),
    maxCatchUpRuns: z.number().int().min(1).max(10).optional(),
    concurrencyPolicy: z.enum(['forbid', 'allow_bounded', 'replace']).optional(),
    maxConcurrentRuns: z.number().int().min(1).max(5).optional(),
    expiresAt: z.string().min(1).max(64).nullable().optional(),
  })
  .strict()

export const TriggerRoutineIpcInputSchema = z
  .object({
    routineId: RoutineIpcIdSchema,
    botId: BotIdSchema,
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict()

export const ImportRoutineIpcInputSchema = z
  .object({
    botId: BotIdSchema,
    bundle: z.record(z.string(), z.unknown()),
    conflictPolicy: z.enum(['skip', 'overwrite', 'rename']).optional(),
  })
  .strict()

export const ListRoutineNotificationsIpcInputSchema = z
  .object({
    botId: BotIdSchema,
    unreadOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict()

export const RoutineNotificationParamSchema = z
  .object({
    notificationId: RoutineIpcIdSchema,
    botId: BotIdSchema,
  })
  .strict()

export type AppearanceSettingsInput = z.infer<typeof AppearanceSettingsSchema>
