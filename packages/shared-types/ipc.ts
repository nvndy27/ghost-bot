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

export const AppSettingsSchema = z.object({
  general: GeneralSettingsSchema.default({}),
  appearance: AppearanceSettingsSchema.default({}),
  personalization: PersonalizationSettingsSchema.default({}),
  permissions: PermissionsSettingsSchema.default({}),
  privacy: PrivacySettingsSchema.default({}),
})

export type AppSettings = z.infer<typeof AppSettingsSchema>

export const AppSettingsPatchSchema = z
  .object({
    general: GeneralSettingsSchema.partial().optional(),
    appearance: AppearanceSettingsSchema.partial().optional(),
    personalization: PersonalizationSettingsSchema.partial().optional(),
    permissions: PermissionsSettingsSchema.partial().optional(),
    privacy: PrivacySettingsSchema.partial().optional(),
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

export const RuntimeSnapshotSchema = z.object({
  runtimeMode: z.enum(['codex', 'mock']),
  codexVersion: z.string().nullable(),
  status: RuntimeAvailabilityStatusSchema,
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
}

export type AppearanceSettingsInput = z.infer<typeof AppearanceSettingsSchema>
