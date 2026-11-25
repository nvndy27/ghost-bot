import { z } from 'zod'

export const IPC_CHANNELS = {
  APP_INFO: 'ghost:app:info',
  DAEMON_HEALTH: 'ghost:daemon:health',
  PROVIDERS_LIST: 'ghost:providers:list',
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

export const EmptyParamsSchema = z.object({}).strict().optional()

export interface GhostBotBridge {
  getAppInfo(): Promise<AppInfoResponse>
  getDaemonHealth(): Promise<DaemonHealthResponse>
  listProviders(): Promise<ProviderSummary[]>
}
