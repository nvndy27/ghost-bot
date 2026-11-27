import { z } from 'zod'

export const WORKSPACE_LIMITS = {
  maxDirectoryEntries: 500,
  maxDirectoryScan: 2000,
  maxFileBytes: 1024 * 1024, // 1 MiB
  maxRelativePathLength: 512,
  maxPathDepth: 24,
} as const

export const WorkspaceSelectorSchema = z
  .object({
    botId: z.string().min(1).max(128).optional(),
    teamId: z.string().min(1).max(128).optional(),
  })
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export const WorkspaceContextResponseSchema = z.object({
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

export type WorkspaceContextResponse = z.infer<typeof WorkspaceContextResponseSchema>

export const WorkspaceRelativePathSchema = z
  .string()
  .max(WORKSPACE_LIMITS.maxRelativePathLength)
  .default('')

export const WorkspaceListDirectoryInputSchema = z
  .object({
    botId: z.string().min(1).max(128).optional(),
    teamId: z.string().min(1).max(128).optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    relativePath: WorkspaceRelativePathSchema,
  })
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export const WorkspaceDirectoryEntrySchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  kind: z.enum(['directory', 'file']),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sensitive: z.boolean().optional(),
})

export type WorkspaceDirectoryEntry = z.infer<typeof WorkspaceDirectoryEntrySchema>

export const WorkspaceListDirectoryResponseSchema = z.object({
  workspaceId: z.string(),
  canonicalRoot: z.string(),
  relativePath: z.string(),
  entries: z.array(WorkspaceDirectoryEntrySchema),
  truncated: z.boolean(),
  totalScanned: z.number().int().nonnegative(),
})

export type WorkspaceListDirectoryResponse = z.infer<typeof WorkspaceListDirectoryResponseSchema>

export const WorkspaceReadFileInputSchema = z
  .object({
    botId: z.string().min(1).max(128).optional(),
    teamId: z.string().min(1).max(128).optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    relativePath: z.string().min(1).max(WORKSPACE_LIMITS.maxRelativePathLength),
  })
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export const WorkspaceReadFileResponseSchema = z.object({
  workspaceId: z.string(),
  relativePath: z.string(),
  name: z.string(),
  content: z.string(),
  revision: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  readOnly: z.boolean(),
  language: z.string(),
})

export type WorkspaceReadFileResponse = z.infer<typeof WorkspaceReadFileResponseSchema>

export const WorkspaceSaveFileInputSchema = z
  .object({
    botId: z.string().min(1).max(128).optional(),
    teamId: z.string().min(1).max(128).optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    relativePath: z.string().min(1).max(WORKSPACE_LIMITS.maxRelativePathLength),
    content: z.string().max(WORKSPACE_LIMITS.maxFileBytes),
    expectedRevision: z.string().min(1).max(256),
  })
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })
  .refine((v) => Buffer.byteLength(v.content, 'utf8') <= WORKSPACE_LIMITS.maxFileBytes, {
    message: 'Content exceeds maximum UTF-8 byte limit',
  })

export const WorkspaceSaveFileResponseSchema = z.object({
  workspaceId: z.string(),
  relativePath: z.string(),
  revision: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  savedAt: z.string(),
})

export type WorkspaceSaveFileResponse = z.infer<typeof WorkspaceSaveFileResponseSchema>

export const WorkspaceCreateEntryInputSchema = z
  .object({
    botId: z.string().min(1).max(128).optional(),
    teamId: z.string().min(1).max(128).optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    relativePath: z.string().min(1).max(WORKSPACE_LIMITS.maxRelativePathLength),
    kind: z.enum(['file', 'directory']),
    content: z.string().max(WORKSPACE_LIMITS.maxFileBytes).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })
  .refine(
    (v) => v.content === undefined || Buffer.byteLength(v.content, 'utf8') <= WORKSPACE_LIMITS.maxFileBytes,
    { message: 'Content exceeds maximum UTF-8 byte limit' },
  )

export const WorkspaceCreateEntryResponseSchema = z.object({
  workspaceId: z.string(),
  relativePath: z.string(),
  kind: z.enum(['file', 'directory']),
  revision: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
})

export const WorkspaceRenameEntryInputSchema = z
  .object({
    botId: z.string().min(1).max(128).optional(),
    teamId: z.string().min(1).max(128).optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    fromPath: z.string().min(1).max(WORKSPACE_LIMITS.maxRelativePathLength),
    toPath: z.string().min(1).max(WORKSPACE_LIMITS.maxRelativePathLength),
    expectedRevision: z.string().min(1).max(256),
  })
  .strict()
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export const WorkspaceRenameEntryResponseSchema = z.object({
  workspaceId: z.string(),
  fromPath: z.string(),
  toPath: z.string(),
  revision: z.string(),
})

export const WorkspaceDeleteFileInputSchema = z
  .object({
    botId: z.string().min(1).max(128).optional(),
    teamId: z.string().min(1).max(128).optional(),
    workspaceId: z.string().min(1).max(128),
    authGeneration: z.string().min(1).max(64),
    relativePath: z.string().min(1).max(WORKSPACE_LIMITS.maxRelativePathLength),
    expectedRevision: z.string().min(1).max(256),
  })
  .strict()
  .refine((v) => Boolean(v.botId) !== Boolean(v.teamId), {
    message: 'Exactly one of botId or teamId is required',
  })

export const WorkspaceDeleteFileResponseSchema = z.object({
  workspaceId: z.string(),
  relativePath: z.string(),
  quarantined: z.boolean(),
  quarantinePath: z.string().optional(),
})

export type WorkspaceCreateEntryResponse = z.infer<typeof WorkspaceCreateEntryResponseSchema>
export type WorkspaceRenameEntryResponse = z.infer<typeof WorkspaceRenameEntryResponseSchema>
export type WorkspaceDeleteFileResponse = z.infer<typeof WorkspaceDeleteFileResponseSchema>
