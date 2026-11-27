import { z } from 'zod'

export const WorkspaceOutputSourceSchema = z.enum(['run', 'tool', 'terminal', 'build', 'system'])
export const WorkspaceOutputSeveritySchema = z.enum(['info', 'warn', 'error'])
export const WorkspaceOutputStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'uncertain',
])

export const WorkspaceOutputQuerySchema = z
  .object({
    botId: z.string().min(1).max(128).optional(),
    teamId: z.string().min(1).max(128).optional(),
    sessionId: z.string().min(1).max(128).optional(),
    runId: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(200).default(120),
  })
  .strict()
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export const WorkspaceOutputEntrySchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sessionId: z.string().nullable(),
  taskId: z.string().nullable(),
  source: WorkspaceOutputSourceSchema,
  severity: WorkspaceOutputSeveritySchema,
  status: WorkspaceOutputStatusSchema,
  timestamp: z.string(),
  title: z.string().max(240),
  message: z.string().max(4096),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  cancellable: z.boolean(),
})

export const WorkspaceOutputRunSummarySchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  status: WorkspaceOutputStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  cancellable: z.boolean(),
})

export const WorkspaceOutputResponseSchema = z.object({
  authorized: z.boolean(),
  ownerKind: z.enum(['bot', 'team']),
  ownerId: z.string().min(1),
  runs: z.array(WorkspaceOutputRunSummarySchema).max(40),
  entries: z.array(WorkspaceOutputEntrySchema).max(200),
  truncated: z.boolean(),
  reason: z.string().nullable(),
})

export const WorkspaceOutputCancelInputSchema = z
  .object({
    botId: z.string().min(1).max(128).optional(),
    teamId: z.string().min(1).max(128).optional(),
    sessionId: z.string().min(1).max(128).optional(),
    runId: z.string().min(1).max(128),
    terminalCommandId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export const WorkspaceOutputCancelResponseSchema = z.object({
  cancelled: z.boolean(),
  runId: z.string().min(1),
  status: WorkspaceOutputStatusSchema,
})

export type WorkspaceOutputQuery = z.input<typeof WorkspaceOutputQuerySchema>
export type WorkspaceOutputEntry = z.infer<typeof WorkspaceOutputEntrySchema>
export type WorkspaceOutputRunSummary = z.infer<typeof WorkspaceOutputRunSummarySchema>
export type WorkspaceOutputResponse = z.infer<typeof WorkspaceOutputResponseSchema>
export type WorkspaceOutputCancelInput = z.infer<typeof WorkspaceOutputCancelInputSchema>
export type WorkspaceOutputCancelResponse = z.infer<typeof WorkspaceOutputCancelResponseSchema>
