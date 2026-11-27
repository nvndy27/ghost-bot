import {
  WorkspaceDiscoveryOperationSchema, WorkspacePreviewInputSchema, WorkspaceSearchInputSchema,
  type WorkspacePreviewResult, type WorkspaceSearchResult,
} from '@ghost-bot/shared-types/workspace-discovery'
export * from '@ghost-bot/shared-types/workspace-discovery'
import { z } from 'zod'
import type { WorkspaceBrowserBounds, WorkspaceBrowserCommand, WorkspaceBrowserState } from '@ghost-bot/shared-types/workspace-browser'
import type {
  WorkspaceOutputCancelInput,
  WorkspaceOutputCancelResponse,
  WorkspaceOutputQuery,
  WorkspaceOutputResponse,
} from '@ghost-bot/shared-types/workspace-output'
export * from '@ghost-bot/shared-types/workspace-browser'
import type { WorkspaceGitInspect, WorkspaceGitOperation, WorkspaceGitResponse } from '@ghost-bot/shared-types/workspace-git'
export * from '@ghost-bot/shared-types/workspace-git'

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
  TEAM_DISCUSSION_LIST: 'ghost:teams:discussion:list',
  TEAM_DISCUSSION_SEND: 'ghost:teams:discussion:send',
  TEAM_DISCUSSION_CANCEL: 'ghost:teams:discussion:cancel',
  TEAM_TASKS_DELEGATE: 'ghost:teams:tasks:delegate',
  TEAM_TASKS_LIST_PRIVATE: 'ghost:teams:tasks:list-private',
  TEAM_TASKS_CANCEL_PRIVATE: 'ghost:teams:tasks:cancel-private',
  TEAM_MEMBER_ROUTING_GET: 'ghost:teams:member-routing:get',
  TEAM_MEMBER_ROUTING_SET: 'ghost:teams:member-routing:set',
  WORKSPACE_PICK: 'ghost:workspace:pick',
  WORKSPACE_AUTHORIZE_READ: 'ghost:workspace:authorize-read',
  WORKSPACE_RESOLVE_CONTEXT: 'ghost:workspace:resolve-context',
  WORKSPACE_LIST_DIR: 'ghost:workspace:list-dir',
  WORKSPACE_SEARCH: 'ghost:workspace:search',
  WORKSPACE_PREVIEW: 'ghost:workspace:preview',
  WORKSPACE_CANCEL_DISCOVERY: 'ghost:workspace:cancel-discovery',
  WORKSPACE_READ_FILE: 'ghost:workspace:read-file',
  WORKSPACE_SAVE_FILE: 'ghost:workspace:save-file',
  WORKSPACE_BROWSER_COMMAND: 'ghost:workspace:browser-command',
  WORKSPACE_BROWSER_BOUNDS: 'ghost:workspace:browser-bounds',
  WORKSPACE_BROWSER_SCREENSHOT: 'ghost:workspace:browser-screenshot',
  WORKSPACE_GIT_INSPECT: 'ghost:workspace:git-inspect',
  WORKSPACE_GIT_CANCEL: 'ghost:workspace:git-cancel',
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
  SESSIONS_MARK_READ: 'ghost:sessions:mark-read',
  SIDEBAR_GET_ORGANIZATION: 'ghost:sidebar:get-organization',
  SIDEBAR_UPDATE_ORGANIZATION: 'ghost:sidebar:update-organization',
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
  MCP_SECRET_STORE_STATUS: 'ghost:mcp:secrets:status',
  MCP_SERVER_SECRETS_LIST: 'ghost:mcp:servers:secrets:list',
  MCP_SERVER_SECRETS_SET: 'ghost:mcp:servers:secrets:set',
  MCP_SERVER_SECRETS_DELETE: 'ghost:mcp:servers:secrets:delete',
  TERMINAL_CAPABILITIES: 'ghost:terminal:capabilities',
  TERMINAL_COMMANDS_LIST: 'ghost:terminal:commands:list',
  TERMINAL_COMMAND_REQUEST: 'ghost:terminal:commands:request',
  TERMINAL_COMMAND_RESOLVE: 'ghost:terminal:commands:resolve',
  TERMINAL_COMMAND_CANCEL: 'ghost:terminal:commands:cancel',
  SKILLS_LIST: 'ghost:skills:list',
  SKILLS_DISCOVER: 'ghost:skills:discover',
  SKILLS_APPROVE_TRUST: 'ghost:skills:approve-trust',
  SKILLS_REVOKE_TRUST: 'ghost:skills:revoke-trust',
  SKILLS_SET_ENABLED: 'ghost:skills:set-enabled',
  OPENCLAW_STATUS: 'ghost:openclaw:status',
  OLLAMA_STATUS: 'ghost:ollama:status',
  CLAUDE_STATUS: 'ghost:claude:status',
  CLAUDE_CREDENTIAL_SET: 'ghost:claude:credential:set',
  CLAUDE_CREDENTIAL_DELETE: 'ghost:claude:credential:delete',
  CLAUDE_AUTH_SET: 'ghost:claude:auth:set',
  GEMINI_STATUS: 'ghost:gemini:status',
  GEMINI_CREDENTIAL_SET: 'ghost:gemini:credential:set',
  GEMINI_CREDENTIAL_DELETE: 'ghost:gemini:credential:delete',
  GEMINI_AUTH_SET: 'ghost:gemini:auth:set',
  KIMI_STATUS: 'ghost:kimi:status',
  LMSTUDIO_STATUS: 'ghost:lmstudio:status',
  LMSTUDIO_CONFIG_SET: 'ghost:lmstudio:config:set',
  LLAMACPP_STATUS: 'ghost:llamacpp:status',
  LLAMACPP_CONFIG_SET: 'ghost:llamacpp:config:set',
  OPENROUTER_STATUS: 'ghost:openrouter:status',
  OPENROUTER_CREDENTIAL_SET: 'ghost:openrouter:credential:set',
  OPENROUTER_CREDENTIAL_DELETE: 'ghost:openrouter:credential:delete',
  OPENROUTER_AUTH_SET: 'ghost:openrouter:auth:set',
  TEAM_AVATAR_PICK: 'ghost:teams:avatar-pick',
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
  COMPUTER_USE_CAPABILITIES: 'ghost:computer-use:capabilities',
  COMPUTER_USE_SESSION_CREATE: 'ghost:computer-use:session-create',
  COMPUTER_USE_SESSION_LIST: 'ghost:computer-use:session-list',
  COMPUTER_USE_SESSION_GET: 'ghost:computer-use:session-get',
  COMPUTER_USE_OBSERVE: 'ghost:computer-use:observe',
  COMPUTER_USE_APPROVAL_REQUEST: 'ghost:computer-use:approval-request',
  COMPUTER_USE_APPROVAL_RESOLVE: 'ghost:computer-use:approval-resolve',
  COMPUTER_USE_APPROVAL_LIST: 'ghost:computer-use:approval-list',
  COMPUTER_USE_ACTION_EXECUTE: 'ghost:computer-use:action-execute',
  COMPUTER_USE_LEDGER_LIST: 'ghost:computer-use:ledger-list',
  COMPUTER_USE_SESSION_CLOSE: 'ghost:computer-use:session-close',
  COMPUTER_USE_EMERGENCY_STOP: 'ghost:computer-use:emergency-stop',
  COMPUTER_USE_TEST_FIXTURE: 'ghost:computer-use:test-fixture',
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

export const WorkspaceTabIdSchema = z.enum(['overview', 'files', 'changes', 'browser', 'output'])
export type WorkspaceTabId = z.infer<typeof WorkspaceTabIdSchema>

export const AppearanceSettingsSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']).default('dark'),
  reducedMotion: z.boolean().default(false),
  leftWidth: z.number().min(180).max(380).default(240),
  rightWidth: z.number().min(220).max(2048).default(400),
  leftCollapsed: z.boolean().default(false),
  rightCollapsed: z.boolean().default(false),
  workspaceTab: WorkspaceTabIdSchema.default('overview'),
})

const AppearanceSettingsPatchSchema = z.object({
  theme: AppearanceSettingsSchema.shape.theme.unwrap().optional(),
  reducedMotion: AppearanceSettingsSchema.shape.reducedMotion.unwrap().optional(),
  leftWidth: AppearanceSettingsSchema.shape.leftWidth.unwrap().optional(),
  rightWidth: AppearanceSettingsSchema.shape.rightWidth.unwrap().optional(),
  leftCollapsed: AppearanceSettingsSchema.shape.leftCollapsed.unwrap().optional(),
  rightCollapsed: AppearanceSettingsSchema.shape.rightCollapsed.unwrap().optional(),
  workspaceTab: WorkspaceTabIdSchema.optional(),
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
    appearance: AppearanceSettingsPatchSchema.optional(),
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
  unread: z.boolean().optional(),
  lastCompletedRunStatus: RunStatusSchema.nullable().optional(),
  lastReadAt: z.string().nullable().optional(),
})

export type SessionRecord = z.infer<typeof SessionRecordSchema>

export const MarkSessionReadResponseSchema = z.object({
  sessionId: SessionIdSchema,
  lastReadAt: z.string().min(1),
})

export type MarkSessionReadResponse = z.infer<typeof MarkSessionReadResponseSchema>

export const SidebarOrganizationSchema = z.object({
  pinnedBotIds: z.array(BotIdSchema).default([]),
  botOrder: z.array(BotIdSchema).default([]),
  pinnedTeamIds: z.array(z.string().min(1).max(128)).default([]),
  teamOrder: z.array(z.string().min(1).max(128)).default([]),
})

export type SidebarOrganization = z.infer<typeof SidebarOrganizationSchema>

export const UpdateSidebarOrganizationInputSchema = z
  .object({
    pinnedBotIds: z.array(BotIdSchema).max(500).optional(),
    botOrder: z.array(BotIdSchema).max(500).optional(),
    pinnedTeamIds: z.array(z.string().min(1).max(128)).max(500).optional(),
    teamOrder: z.array(z.string().min(1).max(128)).max(500).optional(),
  })
  .strict()

export type UpdateSidebarOrganizationInput = z.infer<typeof UpdateSidebarOrganizationInputSchema>

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

export const TeamAppearanceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('bot'), avatar: BotAvatarConfigSchema }).strict(),
  z.object({
    mode: z.literal('upload'),
    dataUrl: z.string().max(107000).regex(/^data:image\/png;base64,[a-zA-Z0-9+/]+={0,2}$/),
  }).strict(),
])
export type TeamAppearance = z.infer<typeof TeamAppearanceSchema>
export const TeamAvatarPickResponseSchema = z.string().max(5600000)
  .regex(/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+={0,2}$/).nullable()

export const CreateTeamIpcInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    leadBotId: BotIdSchema,
    memberBotIds: z.array(BotIdSchema).min(1).max(12),
    bounds: TeamBoundsInputSchema.optional(),
    appearance: TeamAppearanceSchema.optional(),
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
    appearance: TeamAppearanceSchema.optional(),
  })
  .strict()

export const UpdateTeamMembersIpcInputSchema = z
  .object({
    teamId: TeamIpcIdSchema,
    memberBotIds: z.array(BotIdSchema).min(1).max(12),
  })
  .strict()

export const TeamIdParamSchema = z.object({ teamId: TeamIpcIdSchema }).strict()
const RoutingValueSchema = z.string().trim().min(1).max(160)
export const TeamMemberRoutingOverrideSchema = z.object({
  runtimeId: RoutingValueSchema.optional(),
  accountId: RoutingValueSchema.optional(),
  modelId: RoutingValueSchema.optional(),
  effort: RoutingValueSchema.optional(),
}).strict()
export const TeamMemberRoutingKeySchema = z.object({ teamId: TeamIpcIdSchema, botId: BotIdSchema }).strict()
export const SetTeamMemberRoutingSchema = TeamMemberRoutingKeySchema.extend({
  override: TeamMemberRoutingOverrideSchema.nullable(),
})
export const TeamMemberRoutingTupleSchema = z.object({
  runtimeId: RoutingValueSchema,
  accountId: RoutingValueSchema.nullable(),
  modelId: RoutingValueSchema,
  effort: RoutingValueSchema,
})
export const TeamMemberRoutingDtoSchema = z.object({
  override: TeamMemberRoutingOverrideSchema.nullable(),
  effective: TeamMemberRoutingTupleSchema,
  revision: z.string(),
  supported: z.boolean(),
  catalogs: z.array(z.object({
    runtimeId: RoutingValueSchema,
    accountId: RoutingValueSchema,
    models: z.array(RuntimeModelSummarySchema),
  })),
})
export type TeamMemberRoutingOverride = z.infer<typeof TeamMemberRoutingOverrideSchema>
export type TeamMemberRoutingKey = z.infer<typeof TeamMemberRoutingKeySchema>
export type SetTeamMemberRouting = z.infer<typeof SetTeamMemberRoutingSchema>
export type TeamMemberRoutingDto = z.infer<typeof TeamMemberRoutingDtoSchema>

export const TeamDiscussionListSchema = TeamIdParamSchema.extend({
  beforeSeq: z.number().int().positive().optional(),
})
export const TeamDiscussionSendSchema = TeamIdParamSchema.extend({
  operationId: z.uuid(),
  text: z.string().trim().min(1).max(4000),
  rounds: z.number().int().min(1).max(2).optional(),
})
export const TeamDiscussionCancelSchema = TeamIdParamSchema.extend({
  operationId: z.uuid().optional(),
})
export const TeamDiscussionCancelResponseSchema = z.object({
  teamId: TeamIpcIdSchema,
  cancelled: z.boolean(),
})
export const TeamDiscussionRepliesSchema = z.array(z.object({
  botId: BotIdSchema,
  routing: TeamMemberRoutingTupleSchema,
  revision: z.string().max(256),
  text: z.string().min(1).max(8192),
  round: z.number().int().min(1).max(2).optional(),
})).min(1).max(24)
export const PrivateTaskStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'denied',
  'uncertain',
  'budget_exhausted',
  'stopped_by_parent',
  'pending',
  'cancelling',
])

export const TaskSummaryMetaSchema = z.object({
  teamRunId: TeamIpcIdSchema,
  taskId: z.string().min(1),
  assignedBotId: BotIdSchema,
  sessionId: SessionIdSchema.nullable(),
  status: PrivateTaskStatusSchema,
  objective: z.string().max(500),
  blocker: z.string().max(500).nullable(),
})
export type TaskSummaryMeta = z.infer<typeof TaskSummaryMetaSchema>

export const TeamDiscussionTurnSchema = z.object({
  id: z.uuid(),
  seq: z.number().int().positive(),
  text: z.string().min(1).max(4000),
  replies: TeamDiscussionRepliesSchema,
  createdAt: z.string(),
  taskSummary: TaskSummaryMetaSchema.optional(),
})
export const TeamDiscussionPageSchema = z.object({
  turns: z.array(TeamDiscussionTurnSchema).max(20),
  nextBeforeSeq: z.number().int().positive().nullable(),
})
export type TeamDiscussionList = z.infer<typeof TeamDiscussionListSchema>
export type TeamDiscussionSend = z.infer<typeof TeamDiscussionSendSchema>
export type TeamDiscussionCancel = z.infer<typeof TeamDiscussionCancelSchema>
export type TeamDiscussionCancelResponse = z.infer<typeof TeamDiscussionCancelResponseSchema>

export const DelegateTeamTaskInputSchema = TeamIdParamSchema.extend({
  assignedBotId: BotIdSchema,
  objective: z.string().trim().min(1).max(2000),
  operationId: z.uuid(),
}).strict()

export type TeamMemberRoutingTuple = z.infer<typeof TeamMemberRoutingTupleSchema>

export const PrivateTaskChatRecordSchema = z.object({
  taskId: z.string().min(1),
  teamRunId: TeamIpcIdSchema,
  teamId: TeamIpcIdSchema,
  teamName: z.string(),
  assignedBotId: BotIdSchema,
  objective: z.string(),
  sessionId: SessionIdSchema.nullable(),
  daemonRunId: RunIdSchema.nullable(),
  status: PrivateTaskStatusSchema,
  routing: TeamMemberRoutingTupleSchema.nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const ListPrivateTasksInputSchema = z
  .object({
    teamId: TeamIpcIdSchema.optional(),
    botId: BotIdSchema.optional(),
  })
  .strict()

export const ListPrivateTasksResponseSchema = z.object({
  tasks: z.array(PrivateTaskChatRecordSchema),
})

export const CancelPrivateTaskInputSchema = z
  .object({
    teamId: TeamIpcIdSchema,
    teamRunId: TeamIpcIdSchema,
    taskId: z.string().min(1).max(128),
  })
  .strict()

export const CancelPrivateTaskResponseSchema = z.object({
  teamRunId: TeamIpcIdSchema,
  cancelled: z.boolean(),
})

export type DelegateTeamTaskInput = z.infer<typeof DelegateTeamTaskInputSchema>
export type PrivateTaskChatRecord = z.infer<typeof PrivateTaskChatRecordSchema>
export type ListPrivateTasksInput = z.infer<typeof ListPrivateTasksInputSchema>
export type CancelPrivateTaskInput = z.infer<typeof CancelPrivateTaskInputSchema>
export type TeamDiscussionTurn = z.infer<typeof TeamDiscussionTurnSchema>
export type TeamDiscussionPage = z.infer<typeof TeamDiscussionPageSchema>

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
  appearance: TeamAppearanceSchema.optional(),
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

export const TeamPlanPreviewDtoSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
  warnings: z.array(z.string()),
  layers: z.array(
    z.object({
      layer: z.number(),
      planKeys: z.array(z.string()),
    }),
  ),
  dependencies: z.array(
    z.object({
      planKey: z.string(),
      dependsOn: z.array(z.string()),
    }),
  ),
  assignedMembers: z.array(z.string()),
  estimatedTokenAllocation: z.record(z.string(), z.number()),
  maxPossibleConcurrency: z.number(),
  unboundedPeakWidth: z.number(),
  totalPlannedTasks: z.number(),
  isEstimateOnly: z.boolean(),
})

export const TeamRunDtoSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  ownerId: z.string().optional(),
  goal: z.string(),
  status: z.string(),
  tokensUsed: z.number().optional(),
  durationUsedMs: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  endedAt: z.string().nullable().optional(),
})

export const TeamTaskDtoSchema = z.object({
  id: z.string(),
  teamId: z.string().optional(),
  teamRunId: z.string().nullable(),
  planKey: z.string().nullable().optional(),
  assignedBotId: z.string(),
  status: z.string(),
  dependencyState: z.string().optional(),
  sanitizedFailureReason: z.string().nullable().optional(),
  tokensUsed: z.number().optional(),
  durationUsedMs: z.number().optional(),
})

export const TeamStartRunResponseDtoSchema = z.object({
  run: TeamRunDtoSchema,
  tasks: z.array(TeamTaskDtoSchema),
  created: z.boolean(),
})

export const TeamDiagnosticsDtoSchema = z.object({
  teamRunId: z.string(),
  status: z.string(),
  uncertainCount: z.number().optional(),
  cancellationState: z.string().nullable().optional(),
  quarantineReason: z.string().nullable().optional(),
})

export const TeamAggregateUsageDtoSchema = z.object({
  teamRunId: z.string(),
  teamId: z.string().optional(),
  rootTaskId: z.string().optional(),
  status: z.string().optional(),
  completedCount: z.number().optional(),
  failedCount: z.number().optional(),
  cancelledCount: z.number().optional(),
  blockedCount: z.number().optional(),
  uncertainCount: z.number().optional(),
  totalTasks: z.number().optional(),
  totalTokensUsed: z.number().optional(),
  totalTokens: z.number().optional(),
  totalDurationMs: z.number().optional(),
  unknownUsageCount: z.number().optional(),
})

export const TeamRunApprovalDtoSchema = z.object({
  approvalId: z.string(),
  daemonRunId: z.string(),
  teamTaskId: z.string(),
  workerBotId: z.string(),
  title: z.string(),
  command: z.string(),
  permissionMode: z.string(),
  status: z.string(),
  expiresAt: z.string(),
})

export const TeamMessageDtoSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  teamRunId: z.string().nullable().optional(),
  authorBotId: z.string(),
  targetBotId: z.string().nullable().optional(),
  senderType: z.string(),
  messageType: z.string().optional(),
  visibility: z.string().optional(),
  untrusted: z.boolean().optional(),
  fromBotId: z.string().nullable().optional(),
  senderRole: z.string().optional(),
  content: z.string(),
  seq: z.number().optional(),
  createdAt: z.string(),
})

export type TeamRecordDto = z.infer<typeof TeamRecordDtoSchema>
export type CreateTeamIpcInput = z.infer<typeof CreateTeamIpcInputSchema>
export type UpdateTeamIpcInput = z.infer<typeof UpdateTeamIpcInputSchema>
export type UpdateTeamMembersIpcInput = z.infer<typeof UpdateTeamMembersIpcInputSchema>
export type PreviewTeamPlanIpcInput = z.infer<typeof PreviewTeamPlanIpcInputSchema>
export type StartTeamRunIpcInput = z.infer<typeof StartTeamRunIpcInputSchema>
export type ListTeamMessagesIpcInput = z.infer<typeof ListTeamMessagesIpcInputSchema>

export const SecretStoreStatusDtoSchema = z.object({
  available: z.boolean(),
  locked: z.boolean(),
  backend: z.enum(['linux-secret-service', 'memory-test-only', 'unavailable']),
  reason: z.string().nullable(),
})

export type SecretStoreStatusDto = z.infer<typeof SecretStoreStatusDtoSchema>

export const McpServerSecretRefStatusDtoSchema = z.object({
  envVar: z.string(),
  refId: z.string(),
  label: z.string().optional(),
  hasStoredSecret: z.boolean(),
})

export type McpServerSecretRefStatusDto = z.infer<typeof McpServerSecretRefStatusDtoSchema>

export const ListMcpServerSecretsResponseSchema = z.object({
  status: SecretStoreStatusDtoSchema,
  refs: z.array(McpServerSecretRefStatusDtoSchema),
})

export type ListMcpServerSecretsResponse = z.infer<typeof ListMcpServerSecretsResponseSchema>

export const SetMcpServerSecretInputSchema = z
  .object({
    serverId: McpIpcIdSchema,
    envVar: z.string().trim().regex(/^[A-Z_][A-Z0-9_]{0,63}$/),
    refId: McpIpcIdSchema,
    label: z.string().trim().min(1).max(120).optional(),
    secretValue: z.string().min(1).max(16384),
  })
  .strict()

export type SetMcpServerSecretInput = z.infer<typeof SetMcpServerSecretInputSchema>

export const DeleteMcpServerSecretInputSchema = z
  .object({
    serverId: McpIpcIdSchema,
    refId: McpIpcIdSchema,
  })
  .strict()

export type DeleteMcpServerSecretInput = z.infer<typeof DeleteMcpServerSecretInputSchema>

export const TerminalCapabilitiesDtoSchema = z.object({
  bubblewrapAvailable: z.boolean(),
  interactivePtySupported: z.literal(false),
  hostUnisolatedFallbackAllowed: z.literal(false),
  maxOutputBytes: z.number().int(),
  maxDurationMs: z.number().int(),
  maxConcurrentCommands: z.number().int(),
  notes: z.array(z.string()),
})

export type TerminalCapabilitiesDto = z.infer<typeof TerminalCapabilitiesDtoSchema>

export const TerminalCommandDtoSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  botId: z.string(),
  runId: z.string(),
  canonicalWorkspace: z.string(),
  executable: z.string(),
  args: z.array(z.string()),
  permissionMode: z.string(),
  policyId: z.string(),
  commandHash: z.string(),
  status: z.enum(['awaiting_approval', 'queued', 'running', 'completed', 'failed', 'cancelled', 'uncertain']),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  terminationConfirmed: z.boolean().nullable(),
  stdoutPreview: z.string(),
  stderrPreview: z.string(),
  truncated: z.boolean(),
  replayAllowed: z.literal(false),
  errorCode: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  updatedAt: z.string(),
})

export type TerminalCommandDto = z.infer<typeof TerminalCommandDtoSchema>

export const RequestTerminalCommandInputSchema = z
  .object({
    botId: BotIdSchema,
    runId: z.string().min(1).max(128).optional(),
    executable: z.string().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(64).default([]),
    ttlMs: z.number().int().min(5000).max(300000).optional(),
  })
  .strict()

export type RequestTerminalCommandInput = z.infer<typeof RequestTerminalCommandInputSchema>

export const ResolveTerminalCommandInputSchema = z
  .object({
    commandId: McpIpcIdSchema,
    decision: z.enum(['approved', 'denied']),
    timeoutMs: z.number().int().min(100).max(60000).optional(),
    expectedCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict()

export type ResolveTerminalCommandInput = z.infer<typeof ResolveTerminalCommandInputSchema>

export const TerminalCommandIdParamSchema = z.object({ commandId: McpIpcIdSchema }).strict()

export const ListTerminalCommandsInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()

export const LocalSkillDtoSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  sourceRoot: z.string(),
  sourcePath: z.string(),
  name: z.string(),
  description: z.string(),
  manifest: z.object({ name: z.string(), description: z.string() }),
  contentFingerprint: z.string(),
  trustedFingerprint: z.string().nullable(),
  trustState: z.enum(['untrusted', 'trusted', 'revoked', 'invalid']),
  enabled: z.boolean(),
  validationError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type LocalSkillDto = z.infer<typeof LocalSkillDtoSchema>

export const DiscoverLocalSkillsInputSchema = z
  .object({
    roots: z.array(z.string().min(1).max(1024)).min(1).max(16),
  })
  .strict()

export type DiscoverLocalSkillsInput = z.infer<typeof DiscoverLocalSkillsInputSchema>

export const SkillIdParamSchema = z.object({ skillId: McpIpcIdSchema }).strict()

export const SetSkillEnabledInputSchema = z
  .object({
    skillId: McpIpcIdSchema,
    enabled: z.boolean(),
  })
  .strict()

export const OpenClawStatusDtoSchema = z.object({
  available: z.boolean(),
  gatewayUrl: z.string(),
  runtimeVersion: z.string().nullable(),
  supportedVersion: z.boolean(),
  hostDesktopEnabled: z.boolean(),
  pluginsLoaded: z.array(z.string()),
  authStatus: z.enum(['connected', 'disconnected', 'pending', 'error']),
  authDetail: z.string(),
  detail: z.string(),
  capabilities: z.object({
    streaming: z.boolean(),
    cancellation: z.boolean(),
    resume: z.boolean(),
    approvals: z.boolean(),
    usage: z.boolean(),
    sandbox: z.boolean(),
  }),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      efforts: z.array(z.string()),
    }),
  ),
  policyCompatibility: z.object({
    readOnlyAllowed: z.boolean(),
    askApprovalAllowed: z.boolean(),
    workspaceAllowed: z.boolean(),
    fullAccessAllowed: z.literal(false),
    gatedReason: z.string().nullable(),
  }),
})

export type OpenClawStatusDto = z.infer<typeof OpenClawStatusDtoSchema>

export const OllamaStatusDtoSchema = z.object({
  available: z.boolean(),
  baseUrl: z.string(),
  runtimeVersion: z.string().nullable(),
  authStatus: z.enum(['connected', 'disconnected', 'pending', 'error']),
  detail: z.string(),
  localOnlyVerified: z.boolean(),
  capabilities: z.object({
    streaming: z.boolean(),
    cancellation: z.boolean(),
    resume: z.boolean(),
    approvals: z.boolean(),
    usage: z.boolean(),
    sandbox: z.boolean(),
  }),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      sizeBytes: z.number().nullable(),
      digest: z.string().nullable(),
      parameterSize: z.string().nullable(),
      quantizationLevel: z.string().nullable(),
      family: z.string().nullable(),
      contextLength: z.number().nullable(),
      isCloud: z.boolean(),
    }),
  ),
  runningModels: z.array(
    z.object({
      name: z.string(),
      sizeBytes: z.number().nullable(),
      sizeVramBytes: z.number().nullable(),
      expiresAt: z.string().nullable(),
      parameterSize: z.string().nullable(),
      quantizationLevel: z.string().nullable(),
    }),
  ),
  resourceLimits: z.object({
    maxConcurrentRuns: z.number(),
    maxHistoryMessages: z.number(),
    maxHistoryBytes: z.number(),
    maxOutputTokens: z.number(),
    maxDurationMs: z.number(),
    maxStreamBytes: z.number(),
  }),
  diagnostics: z.array(z.string()),
  policyCompatibility: z.object({
    readOnlyAllowed: z.boolean(),
    askApprovalAllowed: z.literal(false),
    workspaceAllowed: z.literal(false),
    fullAccessAllowed: z.literal(false),
    gatedReason: z.string().nullable(),
  }),
})

export type OllamaStatusDto = z.infer<typeof OllamaStatusDtoSchema>

export const SetClaudeCredentialInputSchema = z
  .object({
    apiKey: z.string().min(8).max(4096),
    accountRef: z.string().min(1).max(64).default('default'),
  })
  .strict()

export type SetClaudeCredentialInput = z.infer<typeof SetClaudeCredentialInputSchema>

export const SetClaudeAuthInputSchema = z
  .object({
    authorized: z.boolean(),
  })
  .strict()

export type SetClaudeAuthInput = z.infer<typeof SetClaudeAuthInputSchema>

export const ClaudeStatusDtoSchema = z.object({
  available: z.boolean(),
  endpoint: z.string(),
  apiVersion: z.string(),
  billingMode: z.literal('api-key-billed'),
  authStatus: z.enum(['connected', 'disconnected', 'pending', 'error']),
  detail: z.string(),
  keyringAvailable: z.boolean(),
  keyringLocked: z.boolean(),
  credentialConfigured: z.boolean(),
  accountRef: z.string(),
  maskedKeyHint: z.string().nullable(),
  credentialGeneration: z.number().int().min(0),
  executionAuthorized: z.boolean(),
  capabilities: z.object({
    streaming: z.boolean(),
    cancellation: z.boolean(),
    resume: z.boolean(),
    approvals: z.boolean(),
    usage: z.boolean(),
    sandbox: z.boolean(),
    tools: z.literal(false),
    claudeCodeCli: z.literal(false),
  }),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    }),
  ),
  resourceLimits: z.object({
    maxConcurrentRuns: z.number(),
    maxHistoryMessages: z.number(),
    maxHistoryBytes: z.number(),
    maxOutputTokens: z.number(),
    maxDurationMs: z.number(),
    maxStreamBytes: z.number(),
  }),
  diagnostics: z.array(z.string()),
  policyCompatibility: z.object({
    readOnlyAllowed: z.boolean(),
    askApprovalAllowed: z.literal(false),
    workspaceAllowed: z.literal(false),
    fullAccessAllowed: z.literal(false),
    gatedReason: z.string().nullable(),
  }),
})

export type ClaudeStatusDto = z.infer<typeof ClaudeStatusDtoSchema>

export const SetGeminiCredentialInputSchema = z
  .object({
    apiKey: z.string().min(8).max(4096),
    accountRef: z.string().min(1).max(64).default('default'),
  })
  .strict()

export type SetGeminiCredentialInput = z.infer<typeof SetGeminiCredentialInputSchema>

export const SetGeminiAuthInputSchema = z
  .object({
    authorized: z.boolean(),
  })
  .strict()

export type SetGeminiAuthInput = z.infer<typeof SetGeminiAuthInputSchema>

export const GeminiStatusDtoSchema = z.object({
  available: z.boolean(),
  endpoint: z.string(),
  apiVersion: z.string(),
  billingMode: z.literal('api-key'),
  authStatus: z.enum(['connected', 'disconnected', 'pending', 'error']),
  detail: z.string(),
  keyringAvailable: z.boolean(),
  keyringLocked: z.boolean(),
  credentialConfigured: z.boolean(),
  accountRef: z.string(),
  maskedKeyHint: z.string().nullable(),
  credentialGeneration: z.number().int().min(0),
  executionAuthorized: z.boolean(),
  capabilities: z.object({
    streaming: z.boolean(),
    cancellation: z.boolean(),
    resume: z.boolean(),
    approvals: z.boolean(),
    usage: z.boolean(),
    sandbox: z.boolean(),
    tools: z.literal(false),
    geminiCli: z.literal(false),
  }),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    }),
  ),
  resourceLimits: z.object({
    maxConcurrentRuns: z.number(),
    maxHistoryMessages: z.number(),
    maxHistoryBytes: z.number(),
    maxOutputTokens: z.number(),
    maxDurationMs: z.number(),
    maxStreamBytes: z.number(),
  }),
  diagnostics: z.array(z.string()),
  policyCompatibility: z.object({
    readOnlyAllowed: z.boolean(),
    askApprovalAllowed: z.literal(false),
    workspaceAllowed: z.literal(false),
    fullAccessAllowed: z.literal(false),
    gatedReason: z.string().nullable(),
  }),
})

export type GeminiStatusDto = z.infer<typeof GeminiStatusDtoSchema>

export const KimiStatusDtoSchema = z.object({
  cliAvailable: z.boolean(),
  cliVersion: z.string().nullable(),
  protocolVersion: z.number().nullable(),
  acpProtocolSupported: z.boolean(),
  authenticated: z.boolean(),
  authStatus: z.enum(['connected', 'disconnected', 'pending', 'error']),
  detail: z.string(),
  loginGuidance: z.string(),
  capabilities: z.object({
    streaming: z.boolean(),
    cancellation: z.boolean(),
    resume: z.boolean(),
    approvals: z.boolean(),
    usage: z.boolean(),
    clientFsSupported: z.literal(false),
    clientTerminalSupported: z.literal(false),
  }),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    }),
  ),
  diagnostics: z.array(z.string()),
  policyCompatibility: z.object({
    readOnlyAllowed: z.boolean(),
    askApprovalAllowed: z.boolean(),
    workspaceAllowed: z.literal(false),
    fullAccessAllowed: z.literal(false),
    gatedReason: z.string().nullable(),
  }),
})

export type KimiStatusDto = z.infer<typeof KimiStatusDtoSchema>

export const SetLocalCompatConfigInputSchema = z
  .object({
    baseUrl: z.string().min(10).max(256),
    executionAuthorized: z.boolean().optional(),
  })
  .strict()

export type SetLocalCompatConfigInput = z.infer<typeof SetLocalCompatConfigInputSchema>

export const LocalOpenAiCompatStatusDtoSchema = z.object({
  id: z.enum(['lmstudio', 'llamacpp']),
  available: z.boolean(),
  baseUrl: z.string(),
  authStatus: z.enum(['connected', 'disconnected', 'pending', 'error']),
  detail: z.string(),
  loopbackVerified: z.boolean(),
  executionAuthorized: z.boolean(),
  capabilities: z.object({
    streaming: z.boolean(),
    cancellation: z.boolean(),
    usage: z.boolean(),
    tools: z.literal(false),
  }),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    }),
  ),
  resourceLimits: z.object({
    maxConcurrentRuns: z.number(),
    maxHistoryMessages: z.number(),
    maxHistoryBytes: z.number(),
    maxOutputTokens: z.number(),
    maxDurationMs: z.number(),
    maxStreamBytes: z.number(),
  }),
  diagnostics: z.array(z.string()),
  policyCompatibility: z.object({
    readOnlyAllowed: z.boolean(),
    askApprovalAllowed: z.literal(false),
    workspaceAllowed: z.literal(false),
    fullAccessAllowed: z.literal(false),
    gatedReason: z.string().nullable(),
  }),
})

export type LocalOpenAiCompatStatusDto = z.infer<typeof LocalOpenAiCompatStatusDtoSchema>

export const SetOpenRouterCredentialInputSchema = z
  .object({
    apiKey: z.string().min(8).max(4096),
    accountRef: z.string().min(1).max(64).default('default'),
  })
  .strict()

export type SetOpenRouterCredentialInput = z.infer<typeof SetOpenRouterCredentialInputSchema>

export const SetOpenRouterAuthInputSchema = z
  .object({
    authorized: z.boolean(),
  })
  .strict()

export type SetOpenRouterAuthInput = z.infer<typeof SetOpenRouterAuthInputSchema>

export const OpenRouterStatusDtoSchema = z.object({
  available: z.boolean(),
  endpoint: z.string(),
  billingMode: z.literal('api-key-billed'),
  authStatus: z.enum(['connected', 'disconnected', 'pending', 'error']),
  detail: z.string(),
  keyringAvailable: z.boolean(),
  keyringLocked: z.boolean(),
  credentialConfigured: z.boolean(),
  accountRef: z.string(),
  maskedKeyHint: z.string().nullable(),
  credentialGeneration: z.number().int().min(0),
  executionAuthorized: z.boolean(),
  capabilities: z.object({
    streaming: z.boolean(),
    cancellation: z.boolean(),
    usage: z.boolean(),
    tools: z.literal(false),
    fallbacksDisabled: z.literal(true),
  }),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    }),
  ),
  resourceLimits: z.object({
    maxConcurrentRuns: z.number(),
    maxHistoryMessages: z.number(),
    maxHistoryBytes: z.number(),
    maxOutputTokens: z.number(),
    maxDurationMs: z.number(),
    maxStreamBytes: z.number(),
  }),
  diagnostics: z.array(z.string()),
  policyCompatibility: z.object({
    readOnlyAllowed: z.boolean(),
    askApprovalAllowed: z.literal(false),
    workspaceAllowed: z.literal(false),
    fullAccessAllowed: z.literal(false),
    gatedReason: z.string().nullable(),
  }),
})

export type OpenRouterStatusDto = z.infer<typeof OpenRouterStatusDtoSchema>

export const WorkspaceAuthorizeReadInputSchema = z.object({ botId: BotIdSchema }).strict()

export const WorkspaceReadGrantSchema = WorkspaceAuthorizeReadInputSchema.extend({
  workspaceId: z.string().min(1).max(128),
  selectedRoot: z.string().min(1).max(4096),
}).strict()

export const WorkspaceSelectorIpcSchema = z
  .object({
    botId: BotIdSchema.optional(),
    teamId: TeamIpcIdSchema.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export type WorkspaceSelectorIpcInput = z.infer<typeof WorkspaceSelectorIpcSchema>

export const WorkspaceContextIpcResponseSchema = z.object({
  authorized: z.boolean(),
  workspaceId: z.string().min(1).nullable(),
  canonicalRoot: z.string().nullable(),
  ownerKind: z.enum(['bot', 'team']),
  ownerId: z.string().min(1),
  ownerName: z.string(),
  canWrite: z.boolean(),
  writeAuthorized: z.boolean().optional(),
  permissionMode: z.string(),
  authGeneration: z.string().nullable(),
  reason: z.string().nullable(),
})

export const WorkspaceWriteGrantSchema = z.object({
  botId: BotIdSchema,
  workspaceId: z.string().min(1).max(128),
  authGeneration: z.string().min(1).max(64),
})

export const WorkspaceCreateEntryIpcInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    teamId: TeamIpcIdSchema.optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    relativePath: z.string().min(1).max(512),
    kind: z.enum(['file', 'directory']),
    content: z.string().max(1024 * 1024).optional(),
  })
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export const WorkspaceCreateEntryIpcResponseSchema = z.object({
  workspaceId: z.string(),
  relativePath: z.string(),
  kind: z.enum(['file', 'directory']),
  revision: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
})

export const WorkspaceRenameEntryIpcInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    teamId: TeamIpcIdSchema.optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    fromPath: z.string().min(1).max(512),
    toPath: z.string().min(1).max(512),
    expectedRevision: z.string().min(1).max(256),
  })
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export const WorkspaceRenameEntryIpcResponseSchema = z.object({
  workspaceId: z.string(),
  fromPath: z.string(),
  toPath: z.string(),
  revision: z.string(),
})

export const WorkspaceDeleteFileIpcInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    teamId: TeamIpcIdSchema.optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    relativePath: z.string().min(1).max(512),
    expectedRevision: z.string().min(1).max(256),
  })
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export const WorkspaceDeleteFileIpcResponseSchema = z.object({
  workspaceId: z.string(),
  relativePath: z.string(),
  quarantined: z.boolean(),
})

export type WorkspaceCreateEntryIpcInput = z.infer<typeof WorkspaceCreateEntryIpcInputSchema>
export type WorkspaceCreateEntryIpcResponse = z.infer<typeof WorkspaceCreateEntryIpcResponseSchema>
export type WorkspaceRenameEntryIpcInput = z.infer<typeof WorkspaceRenameEntryIpcInputSchema>
export type WorkspaceRenameEntryIpcResponse = z.infer<typeof WorkspaceRenameEntryIpcResponseSchema>
export type WorkspaceDeleteFileIpcInput = z.infer<typeof WorkspaceDeleteFileIpcInputSchema>
export type WorkspaceDeleteFileIpcResponse = z.infer<typeof WorkspaceDeleteFileIpcResponseSchema>

export type WorkspaceContextIpcResponse = z.infer<typeof WorkspaceContextIpcResponseSchema>

export const WorkspaceListDirectoryIpcInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    teamId: TeamIpcIdSchema.optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    relativePath: z.string().max(512).default(''),
  })
  .strict()
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export type WorkspaceListDirectoryIpcInput = z.infer<typeof WorkspaceListDirectoryIpcInputSchema>

export const WorkspaceListDirectoryIpcResponseSchema = z.object({
  workspaceId: z.string(),
  canonicalRoot: z.string(),
  relativePath: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      relativePath: z.string(),
      kind: z.enum(['directory', 'file']),
      sizeBytes: z.number().int().nonnegative().nullable(),
      sensitive: z.boolean().optional(),
    }),
  ),
  truncated: z.boolean(),
  totalScanned: z.number().int().nonnegative(),
})

export type WorkspaceListDirectoryIpcResponse = z.infer<typeof WorkspaceListDirectoryIpcResponseSchema>

export const WorkspaceReadFileIpcInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    teamId: TeamIpcIdSchema.optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    relativePath: z.string().min(1).max(512),
  })
  .strict()
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export type WorkspaceReadFileIpcInput = z.infer<typeof WorkspaceReadFileIpcInputSchema>

export const WorkspaceReadFileIpcResponseSchema = z.object({
  workspaceId: z.string(),
  relativePath: z.string(),
  name: z.string(),
  content: z.string(),
  revision: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  readOnly: z.boolean(),
  language: z.string(),
})

export type WorkspaceReadFileIpcResponse = z.infer<typeof WorkspaceReadFileIpcResponseSchema>

export const WorkspaceSaveFileIpcInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    teamId: TeamIpcIdSchema.optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    relativePath: z.string().min(1).max(512),
    content: z.string().max(1024 * 1024),
    expectedRevision: z.string().min(1).max(256),
  })
  .strict()
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export type WorkspaceSaveFileIpcInput = z.infer<typeof WorkspaceSaveFileIpcInputSchema>

export const WorkspaceSaveFileIpcResponseSchema = z.object({
  workspaceId: z.string(),
  relativePath: z.string(),
  revision: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  savedAt: z.string(),
})

export type WorkspaceSaveFileIpcResponse = z.infer<typeof WorkspaceSaveFileIpcResponseSchema>

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
  searchWorkspaceFiles(input: z.input<typeof WorkspaceSearchInputSchema>): Promise<WorkspaceSearchResult>
  previewWorkspaceFile(input: z.input<typeof WorkspacePreviewInputSchema>): Promise<WorkspacePreviewResult>
  cancelWorkspaceDiscovery(input: z.input<typeof WorkspaceDiscoveryOperationSchema>): Promise<boolean>
  authorizeWorkspaceRead(botId: string): Promise<boolean>
  resolveWorkspaceContext(selector: WorkspaceSelectorIpcInput): Promise<WorkspaceContextIpcResponse>
  listWorkspaceDirectory(
    params: WorkspaceListDirectoryIpcInput,
  ): Promise<WorkspaceListDirectoryIpcResponse>
  readWorkspaceFile(params: WorkspaceReadFileIpcInput): Promise<WorkspaceReadFileIpcResponse>
  saveWorkspaceFile(params: WorkspaceSaveFileIpcInput): Promise<WorkspaceSaveFileIpcResponse>
  authorizeWorkspaceWrite(botId: string): Promise<boolean>
  revokeWorkspaceWrite(botId: string): Promise<boolean>
  createWorkspaceEntry(params: WorkspaceCreateEntryIpcInput): Promise<WorkspaceCreateEntryIpcResponse>
  renameWorkspaceEntry(params: WorkspaceRenameEntryIpcInput): Promise<WorkspaceRenameEntryIpcResponse>
  deleteWorkspaceFile(params: WorkspaceDeleteFileIpcInput): Promise<WorkspaceDeleteFileIpcResponse>
  workspaceBrowserCommand(input: WorkspaceBrowserCommand): Promise<WorkspaceBrowserState>
  setWorkspaceBrowserBounds(bounds: WorkspaceBrowserBounds): Promise<void>
  captureWorkspaceBrowser(tabId: string): Promise<string>
  onWorkspaceBrowserState(listener: (state: WorkspaceBrowserState) => void): () => void
  listWorkspaceOutput(input: WorkspaceOutputQuery): Promise<WorkspaceOutputResponse>
  cancelWorkspaceOutput(input: WorkspaceOutputCancelInput): Promise<WorkspaceOutputCancelResponse>
  inspectWorkspaceGit(params: WorkspaceGitInspect): Promise<WorkspaceGitResponse>
  cancelWorkspaceGit(params: WorkspaceGitOperation): Promise<boolean>
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
  markSessionRead(sessionId: string): Promise<MarkSessionReadResponse>
  getSidebarOrganization(): Promise<SidebarOrganization>
  updateSidebarOrganization(input: UpdateSidebarOrganizationInput): Promise<SidebarOrganization>
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
  getSecretStoreStatus(): Promise<SecretStoreStatusDto>
  listMcpServerSecrets(serverId: string): Promise<ListMcpServerSecretsResponse>
  setMcpServerSecret(input: SetMcpServerSecretInput): Promise<McpServerDto>
  deleteMcpServerSecret(input: DeleteMcpServerSecretInput): Promise<McpServerDto>
  getTerminalCapabilities(): Promise<TerminalCapabilitiesDto>
  listTerminalCommands(input?: { botId?: string; limit?: number }): Promise<{ commands: TerminalCommandDto[] }>
  requestTerminalCommand(input: RequestTerminalCommandInput): Promise<TerminalCommandDto>
  resolveTerminalCommand(input: ResolveTerminalCommandInput): Promise<TerminalCommandDto>
  cancelTerminalCommand(commandId: string): Promise<TerminalCommandDto>
  listLocalSkills(): Promise<{ skills: LocalSkillDto[] }>
  discoverLocalSkills(input: DiscoverLocalSkillsInput): Promise<{ skills: LocalSkillDto[] }>
  approveLocalSkillTrust(skillId: string): Promise<LocalSkillDto>
  revokeLocalSkillTrust(skillId: string): Promise<LocalSkillDto>
  setLocalSkillEnabled(input: { skillId: string; enabled: boolean }): Promise<LocalSkillDto>
  getOpenClawStatus(): Promise<OpenClawStatusDto>
  getOllamaStatus(): Promise<OllamaStatusDto>
  getClaudeStatus(): Promise<ClaudeStatusDto>
  setClaudeCredential(input: SetClaudeCredentialInput): Promise<ClaudeStatusDto>
  deleteClaudeCredential(): Promise<ClaudeStatusDto>
  setClaudeExecutionAuthorized(input: SetClaudeAuthInput): Promise<ClaudeStatusDto>
  getGeminiStatus(): Promise<GeminiStatusDto>
  setGeminiCredential(input: SetGeminiCredentialInput): Promise<GeminiStatusDto>
  deleteGeminiCredential(): Promise<GeminiStatusDto>
  setGeminiExecutionAuthorized(input: SetGeminiAuthInput): Promise<GeminiStatusDto>
  getKimiStatus(): Promise<KimiStatusDto>
  getLmStudioStatus(): Promise<LocalOpenAiCompatStatusDto>
  setLmStudioConfig(input: SetLocalCompatConfigInput): Promise<LocalOpenAiCompatStatusDto>
  getLlamaCppStatus(): Promise<LocalOpenAiCompatStatusDto>
  setLlamaCppConfig(input: SetLocalCompatConfigInput): Promise<LocalOpenAiCompatStatusDto>
  getOpenRouterStatus(): Promise<OpenRouterStatusDto>
  setOpenRouterCredential(input: SetOpenRouterCredentialInput): Promise<OpenRouterStatusDto>
  deleteOpenRouterCredential(): Promise<OpenRouterStatusDto>
  setOpenRouterExecutionAuthorized(input: SetOpenRouterAuthInput): Promise<OpenRouterStatusDto>
  listTeamDiscussion(input: TeamDiscussionList): Promise<TeamDiscussionPage>
  sendTeamDiscussion(input: TeamDiscussionSend): Promise<TeamDiscussionTurn>
  cancelTeamDiscussion(input: TeamDiscussionCancel): Promise<TeamDiscussionCancelResponse>
  delegateTeamTask(input: DelegateTeamTaskInput): Promise<PrivateTaskChatRecord>
  listPrivateTaskChats(input?: ListPrivateTasksInput): Promise<{ tasks: PrivateTaskChatRecord[] }>
  cancelPrivateTaskChat(input: CancelPrivateTaskInput): Promise<{ teamRunId: string; cancelled: boolean }>
  getTeamMemberRouting(input: TeamMemberRoutingKey): Promise<TeamMemberRoutingDto>
  setTeamMemberRouting(input: SetTeamMemberRouting): Promise<TeamMemberRoutingDto>
  pickTeamAvatar(): Promise<string | null>
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
  getComputerUseCapabilities(): Promise<z.infer<typeof ComputerUseCapabilitiesDtoSchema>>
  createComputerUseSession(input: z.infer<typeof CreateComputerUseSessionInputSchema>): Promise<z.infer<typeof ComputerUseSessionDtoSchema>>
  listComputerUseSessions(input?: z.infer<typeof ListComputerUseSessionsInputSchema>): Promise<{ sessions: Array<z.infer<typeof ComputerUseSessionDtoSchema>> }>
  getComputerUseSession(input: z.infer<typeof ComputerUseSessionIdParamSchema>): Promise<z.infer<typeof ComputerUseSessionDtoSchema>>
  observeComputerUseTab(input: z.infer<typeof ComputerUseObserveInputSchema>): Promise<z.infer<typeof ComputerUseObservationDtoSchema>>
  requestComputerUseApproval(input: z.infer<typeof RequestComputerUseApprovalInputSchema>): Promise<z.infer<typeof ComputerUseApprovalDtoSchema>>
  resolveComputerUseApproval(input: z.infer<typeof ResolveComputerUseApprovalInputSchema>): Promise<z.infer<typeof ComputerUseApprovalDtoSchema>>
  listComputerUseApprovals(input: z.infer<typeof ComputerUseSessionListParamSchema>): Promise<{ approvals: Array<z.infer<typeof ComputerUseApprovalDtoSchema>> }>
  executeComputerUseAction(input: z.infer<typeof ExecuteComputerUseActionInputSchema>): Promise<z.infer<typeof ExecuteComputerUseActionResultDtoSchema>>
  listComputerUseLedger(input: z.infer<typeof ComputerUseSessionListParamSchema>): Promise<{ entries: Array<z.infer<typeof ComputerUseLedgerEntryDtoSchema>> }>
  closeComputerUseSession(input: z.infer<typeof ComputerUseSessionIdParamSchema>): Promise<z.infer<typeof ComputerUseSessionDtoSchema>>
  emergencyStopComputerUseSession(input: z.infer<typeof ComputerUseEmergencyStopInputSchema>): Promise<{ session: z.infer<typeof ComputerUseSessionDtoSchema>; confirmed: boolean }>
  startComputerUseTestFixture?(input: { sessionId: string; routes: Record<string, string>; port?: number }): Promise<{ baseUrl: string }>
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
  z.object({ kind: z.literal('one-time'), runAt: z.string().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal('interval'),
      intervalMs: z.number().int().min(60_000).max(31_536_000_000),
      anchorAt: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal('daily'),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      second: z.number().int().min(0).max(59).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('weekly'),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      second: z.number().int().min(0).max(59).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().min(5).max(120) }).strict(),
  z
    .object({
      kind: z.literal('event'),
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
        idempotent: z.boolean().optional(),
      })
      .strict(),
    enabled: z.boolean().optional(),
    missedRunPolicy: z.enum(['skip', 'run-once', 'bounded-catch-up']).optional(),
    maxCatchUpRuns: z.number().int().min(1).max(10).optional(),
    concurrencyPolicy: z.enum(['forbid', 'allow-bounded']).optional(),
    maxConcurrentRuns: z.number().int().min(1).max(5).optional(),
    retryPolicy: z
      .object({
        maxAttempts: z.number().int().min(1).max(5),
        backoffMs: z.number().int().min(1000).max(3_600_000),
        retryNonIdempotent: z.literal(false),
      })
      .strict()
      .optional(),
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
        idempotent: z.boolean().optional(),
      })
      .strict()
      .optional(),
    missedRunPolicy: z.enum(['skip', 'run-once', 'bounded-catch-up']).optional(),
    maxCatchUpRuns: z.number().int().min(1).max(10).optional(),
    concurrencyPolicy: z.enum(['forbid', 'allow-bounded']).optional(),
    maxConcurrentRuns: z.number().int().min(1).max(5).optional(),
    retryPolicy: z
      .object({
        maxAttempts: z.number().int().min(1).max(5),
        backoffMs: z.number().int().min(1000).max(3_600_000),
        retryNonIdempotent: z.literal(false),
      })
      .strict()
      .optional(),
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

export const RoutineRecordDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  ownerId: z.string(),
  botId: z.string(),
  targetType: z.enum(['bot', 'team']).optional(),
  teamId: z.string().nullable().optional(),
  trigger: z.record(z.string(), z.unknown()),
  timezone: z.string(),
  task: z.object({
    prompt: z.string(),
    idempotent: z.boolean(),
    metadata: z.record(z.string(), z.string()).optional(),
    requestedPermissionHint: z.string().optional(),
  }),
  enabled: z.boolean(),
  archivedAt: z.string().nullable(),
  missedRunPolicy: z.string(),
  maxCatchUpRuns: z.number(),
  concurrencyPolicy: z.string(),
  maxConcurrentRuns: z.number(),
  retryPolicy: z.object({
    maxAttempts: z.number(),
    backoffMs: z.number(),
    retryNonIdempotent: z.literal(false),
  }),
  expiresAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastEvaluatedAt: z.string().nullable(),
  lastTaskStatus: z.string().nullable(),
  revision: z.number(),
  ownership: z.string(),
  dedupWatermarkAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const RoutineTaskDtoSchema = z.object({
  id: z.string(),
  routineId: z.string(),
  routineRevision: z.number(),
  triggerSource: z.string(),
  ownerId: z.string(),
  botId: z.string(),
  occurrenceKey: z.string(),
  scheduledFor: z.string(),
  status: z.string(),
  attempt: z.number(),
  maxAttempts: z.number(),
  uncertainExecution: z.boolean(),
  approvalRequired: z.boolean(),
  approvalState: z.string().nullable().optional(),
  approvalExpiresAt: z.string().nullable().optional(),
  approvalActionSummary: z.string().nullable().optional(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  executionLink: z
    .object({
      daemonRunId: z.string().nullable(),
      teamRunId: z.string().nullable(),
      sessionId: z.string().nullable(),
    })
    .nullable()
    .optional(),
  approvalLink: z
    .object({
      daemonApprovalId: z.string(),
      daemonRunId: z.string(),
      state: z.string(),
      expiresAt: z.string(),
    })
    .nullable()
    .optional(),
})

export const RoutineTriggerResponseDtoSchema = z.object({
  task: RoutineTaskDtoSchema,
  created: z.boolean(),
})

export const RoutinePreviewDtoSchema = z.object({
  valid: z.boolean(),
  validationError: z.string().nullable(),
  status: z.enum(['ok', 'event_driven', 'invalid', 'no_occurrences_in_horizon', 'expired']),
  timezone: z.string(),
  routineRevision: z.number(),
  requestedCount: z.number(),
  occurrences: z.array(
    z.object({
      scheduledAtUtc: z.string(),
      localDateTime: z.string(),
      timezone: z.string(),
      dstTransitionNote: z.string().optional(),
    }),
  ),
  truncatedByExpiration: z.boolean(),
  truncatedByHorizon: z.boolean(),
})

export const RoutineDiagnosticsDtoSchema = z.object({
  routineId: z.string(),
  ownerId: z.string(),
  botId: z.string(),
  revision: z.number(),
  eligibleForScheduling: z.boolean(),
  reasonCodes: z.array(z.string()),
  nextRunAt: z.string().nullable(),
  activeTaskCount: z.number(),
  uncertainTaskCount: z.number(),
  staleQueuedTaskCount: z.number(),
  awaitingApprovalCount: z.number(),
  authorizationNote: z.string(),
})

export const RoutineSimulationDtoSchema = z.object({
  simulatedOnly: z.literal(true),
  routineCount: z.number(),
  ticksExecuted: z.number(),
  expectedOccurrences: z.number(),
  skippedOccurrences: z.number(),
  deduplicatedOccurrences: z.number(),
  estimatedDispatchOpportunities: z.number(),
  taskStates: z.record(z.string(), z.number()),
  blockingReasonCodes: z.array(z.string()),
  warnings: z.array(z.string()),
  tasks: z.array(z.record(z.string(), z.unknown())).optional(),
})

export const RoutineStatsDtoSchema = z.object({
  routineId: z.string(),
  ownerId: z.string(),
  botId: z.string(),
  scheduledOccurrences: z.number(),
  completedTasks: z.number(),
  failedTasks: z.number(),
  cancelledTasks: z.number(),
  expiredTasks: z.number(),
  interruptedTasks: z.number(),
  uncertainExecutionCount: z.number(),
  successRate: z.number().nullable(),
  successRateDenominator: z.number(),
  averageDurationMs: z.number().nullable(),
  durationSampleCount: z.number(),
  lastExecutionAt: z.string().nullable(),
  nextScheduledAt: z.string().nullable(),
  retentionNote: z.string(),
})

export const RoutineImportPreviewDtoSchema = z.object({
  valid: z.boolean(),
  totalParsed: z.number(),
  wouldCreate: z.number(),
  wouldSkip: z.number(),
  wouldRename: z.number(),
  wouldOverwrite: z.number(),
  conflicts: z.array(z.string()),
  validatedInputs: z.array(z.record(z.string(), z.unknown())).optional(),
})

export const RoutineImportCommitDtoSchema = z.object({
  imported: z.array(RoutineRecordDtoSchema),
  skipped: z.number(),
})

export const RoutineExportBundleDtoSchema = z.object({
  schema: z.string(),
  schemaVersion: z.union([z.number(), z.string()]),
  exportedAt: z.string(),
  routines: z.array(z.record(z.string(), z.unknown())),
})

export const RoutineNotificationDtoSchema = z.object({
  id: z.string(),
  routineId: z.string(),
  routineRevision: z.number(),
  taskId: z.string().nullable(),
  occurrenceKey: z.string().nullable(),
  ownerId: z.string(),
  botId: z.string(),
  category: z.string(),
  severity: z.string(),
  dedupKey: z.string(),
  summary: z.string(),
  readAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
  deliveryStatus: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
})

export type RoutineRecordDto = z.infer<typeof RoutineRecordDtoSchema>
export type RoutineTaskDto = z.infer<typeof RoutineTaskDtoSchema>
export type RoutineNotificationDto = z.infer<typeof RoutineNotificationDtoSchema>

// ── Computer Use Strict Contracts (CU.4) ──────────────────────────────────────
const CuIdSchema = z.string().min(1).max(128)

export const ComputerUseActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      actionId: CuIdSchema,
      kind: z.literal('navigate'),
      tabId: CuIdSchema,
      url: z.string().min(1).max(2048),
      description: z.string().max(240).optional(),
    })
    .strict(),
  z
    .object({
      actionId: CuIdSchema,
      kind: z.literal('click_selector'),
      tabId: CuIdSchema,
      selector: z.string().min(1).max(512),
      observationId: CuIdSchema.optional(),
      navigationGeneration: z.number().int().nonnegative().optional(),
      description: z.string().max(240).optional(),
    })
    .strict(),
  z
    .object({
      actionId: CuIdSchema,
      kind: z.literal('click_point'),
      tabId: CuIdSchema,
      x: z.number().finite().min(0).max(8192),
      y: z.number().finite().min(0).max(8192),
      observationId: CuIdSchema.optional(),
      navigationGeneration: z.number().int().nonnegative().optional(),
      description: z.string().max(240).optional(),
    })
    .strict(),
  z
    .object({
      actionId: CuIdSchema,
      kind: z.literal('type_text'),
      tabId: CuIdSchema,
      selector: z.string().min(1).max(512),
      text: z.string().max(4096),
      observationId: CuIdSchema.optional(),
      navigationGeneration: z.number().int().nonnegative().optional(),
      description: z.string().max(240).optional(),
    })
    .strict(),
  z
    .object({
      actionId: CuIdSchema,
      kind: z.literal('scroll'),
      tabId: CuIdSchema,
      deltaX: z.number().finite().min(-10_000).max(10_000),
      deltaY: z.number().finite().min(-10_000).max(10_000),
      observationId: CuIdSchema.optional(),
      navigationGeneration: z.number().int().nonnegative().optional(),
      description: z.string().max(240).optional(),
    })
    .strict(),
  z
    .object({
      actionId: CuIdSchema,
      kind: z.literal('key_press'),
      tabId: CuIdSchema,
      key: z.string().min(1).max(32),
      observationId: CuIdSchema.optional(),
      navigationGeneration: z.number().int().nonnegative().optional(),
      description: z.string().max(240).optional(),
    })
    .strict(),
])

export const CreateComputerUseSessionInputSchema = z
  .object({
    botId: BotIdSchema,
    runId: RunIdSchema.optional(),
    explicitConsent: z.boolean(),
    inheritedFromTeamOrRoutine: z.boolean().optional(),
    allowObservation: z.boolean(),
    allowNavigation: z.boolean(),
    allowInteraction: z.boolean(),
    allowedOrigins: z.array(z.string().min(1).max(512)).max(25),
    viewport: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(240).max(2160),
      })
      .strict()
      .optional(),
    liveModelDriven: z.boolean().optional(),
  })
  .strict()

export const ListComputerUseSessionsInputSchema = z
  .object({
    botId: BotIdSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()

export const ComputerUseSessionIdParamSchema = z
  .object({
    sessionId: CuIdSchema,
  })
  .strict()

export const ComputerUseSessionListParamSchema = z
  .object({
    sessionId: CuIdSchema,
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()

export const ComputerUseObserveInputSchema = z
  .object({
    sessionId: CuIdSchema,
    tabId: CuIdSchema.optional(),
  })
  .strict()

export const RequestComputerUseApprovalInputSchema = z
  .object({
    sessionId: CuIdSchema,
    tabId: CuIdSchema,
    observationId: CuIdSchema,
    navigationGeneration: z.number().int().nonnegative(),
    action: ComputerUseActionSchema,
    ttlMs: z.number().int().min(5_000).max(300_000).optional(),
  })
  .strict()

export const ResolveComputerUseApprovalInputSchema = z
  .object({
    sessionId: CuIdSchema,
    approvalId: CuIdSchema,
    decision: z.enum(['approved', 'denied']),
  })
  .strict()

export const ExecuteComputerUseActionInputSchema = z
  .object({
    sessionId: CuIdSchema,
    approvalId: CuIdSchema,
    observationId: CuIdSchema,
    navigationGeneration: z.number().int().nonnegative(),
    action: ComputerUseActionSchema,
  })
  .strict()

export const ComputerUseEmergencyStopInputSchema = z
  .object({
    sessionId: CuIdSchema,
    reason: z.string().min(1).max(240).optional(),
  })
  .strict()

export const ComputerUseCapabilitiesDtoSchema = z.object({
  browser: z.object({
    engine: z.literal('chromium'),
    executablePath: z.string().nullable(),
    sandboxed: z.boolean(),
    headless: z.boolean(),
    contextIsolation: z.boolean(),
    temporaryProfileSupported: z.boolean(),
    networkPolicyMode: z.literal('allowlist'),
    notes: z.array(z.string()),
  }),
  virtualDesktop: z.object({
    backendKind: z.enum(['weston-headless', 'xvfb', 'podman-desktop']),
    compositorAvailable: z.boolean(),
    isolatedSocketSupported: z.boolean(),
    frameCaptureSupported: z.literal(false),
    inputInjectionSupported: z.literal(false),
    hostDesktopIsolated: z.literal(true),
    notes: z.array(z.string()),
  }),
  liveModelDrivenEnabled: z.literal(false),
  hostDesktopControlSupported: z.literal(false),
})

export const ComputerUseSessionDtoSchema = z.object({
  id: CuIdSchema,
  ownerId: z.string(),
  botId: z.string(),
  runId: z.string(),
  sessionKind: z.literal('isolated-browser'),
  state: z.enum(['created', 'active', 'stopped', 'emergency_stopped', 'failed', 'interrupted']),
  allowObservation: z.boolean(),
  allowNavigation: z.boolean(),
  allowInteraction: z.boolean(),
  allowedOrigins: z.array(z.string()),
  inheritedFromTeamOrRoutine: z.literal(false),
  workerPid: z.number().int().nullable(),
  emergencyStopReason: z.string().nullable(),
  activeTabId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
})

export const LiveViewerFrameDtoSchema = z.object({
  sessionId: z.string(),
  frameSeq: z.number().int().nonnegative(),
  timestamp: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: z.enum(['image/png', 'image/raw']),
  byteLength: z.number().int().nonnegative().max(2 * 1024 * 1024),
  captureStatus: z.enum(['streaming', 'paused', 'stopped', 'error']),
  backpressureDropCount: z.number().int().nonnegative(),
  stale: z.boolean(),
  executionStatus: z.enum(['idle', 'completed', 'failed', 'denied', 'cancelled', 'uncertain']),
  emergencyStopSignaled: z.boolean(),
})

export const ComputerUseObservationDtoSchema = z.object({
  observationId: z.string(),
  sessionId: z.string(),
  tabId: z.string(),
  url: z.string(),
  navigationGeneration: z.number().int().nonnegative(),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  mimeType: z.literal('image/png'),
  byteLength: z.number().int().nonnegative().max(2 * 1024 * 1024),
  sha256: z.string(),
  capturedAt: z.string(),
  sanitizedSummary: z.string(),
  isIsolatedBrowser: z.literal(true),
  imageBase64: z.string().max(3 * 1024 * 1024),
  viewerFrame: LiveViewerFrameDtoSchema,
})

export const ComputerUseApprovalDtoSchema = z.object({
  id: z.string(),
  cuSessionId: z.string(),
  ownerId: z.string(),
  botId: z.string(),
  runId: z.string(),
  tabId: z.string(),
  observationId: z.string(),
  navigationGeneration: z.number().int().nonnegative(),
  actionId: z.string(),
  actionKind: z.string(),
  actionHash: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'consumed', 'revoked', 'expired']),
  expiresAt: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
})

export const ExecuteComputerUseActionResultDtoSchema = z.object({
  outcomeStatus: z.enum(['completed', 'failed', 'cancelled', 'uncertain']),
  navigationGeneration: z.number().int().nonnegative(),
  errorCode: z.string().optional(),
  sanitizedSummary: z.string(),
})

export const ComputerUseLedgerEntryDtoSchema = z.object({
  id: z.string(),
  cuSessionId: z.string(),
  ownerId: z.string(),
  botId: z.string(),
  runId: z.string(),
  tabId: z.string().nullable(),
  observationId: z.string().nullable(),
  navigationGeneration: z.number().int().nullable(),
  actionId: z.string().nullable(),
  actionKind: z.string(),
  approvalId: z.string().nullable(),
  outcomeStatus: z.enum(['completed', 'failed', 'denied', 'cancelled', 'uncertain']),
  sanitizedSummary: z.string(),
  errorCode: z.string().nullable(),
  replayAllowed: z.literal(false),
  createdAt: z.string(),
})

export * from '@ghost-bot/shared-types/workspace-output'
export type AppearanceSettingsInput = z.infer<typeof AppearanceSettingsSchema>
