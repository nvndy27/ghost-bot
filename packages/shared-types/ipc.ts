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
}
