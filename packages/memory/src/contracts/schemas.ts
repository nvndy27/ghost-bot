import { z } from 'zod'
import { MEMORY_LIMITS, MEMORY_SCHEMA_VERSION } from './limits.ts'

const SAFE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const UTC_ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function hasNoControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return false
    }
  }
  return true
}

function hasNoInlineControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return false
    }
  }
  return true
}

export const SafeIdentifierSchema = z
  .string()
  .min(1)
  .max(MEMORY_LIMITS.maxIdLength)
  .regex(SAFE_ID_REGEX, 'Identifier must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')

export const MemoryIdSchema = SafeIdentifierSchema
export const UserIdSchema = SafeIdentifierSchema
export const BotIdSchema = SafeIdentifierSchema
export const WorkspaceIdSchema = SafeIdentifierSchema

export const UtcTimestampSchema = z
  .string()
  .regex(UTC_ISO_REGEX, 'Timestamp must be an ISO-8601 UTC string (YYYY-MM-DDTHH:mm:ss.sssZ)')
  .refine((val) => Number.isFinite(Date.parse(val)), 'Timestamp must be a valid calendar date')

export const MemoryScopeKindSchema = z.enum(['user', 'bot', 'workspace'])

export const UserMemoryScopeSchema = z
  .object({
    kind: z.literal('user'),
    userId: UserIdSchema,
  })
  .strict()

export const BotMemoryScopeSchema = z
  .object({
    kind: z.literal('bot'),
    userId: UserIdSchema,
    botId: BotIdSchema,
  })
  .strict()

export const WorkspaceMemoryScopeSchema = z
  .object({
    kind: z.literal('workspace'),
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .strict()

export const MemoryScopeSchema = z.discriminatedUnion('kind', [
  UserMemoryScopeSchema,
  BotMemoryScopeSchema,
  WorkspaceMemoryScopeSchema,
])

export const MemoryCategorySchema = z.enum([
  'preference',
  'fact',
  'instruction_note',
  'project_context',
  'glossary',
  'other',
])

export const MemoryOriginSchema = z.enum(['explicit', 'inferred'])
export const MemoryStatusSchema = z.enum(['active', 'archived'])

export const MemoryTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_LIMITS.maxTagLength)
  .refine(hasNoInlineControlChars, 'Tag must not contain control characters')

export const MemoryTagsSchema = z
  .array(MemoryTagSchema)
  .max(MEMORY_LIMITS.maxTagsCount)

export const MemoryContentSchema = z
  .string()
  .min(1)
  .max(MEMORY_LIMITS.maxContentLength)
  .refine((val) => val.trim().length > 0, 'Content must not be whitespace only')
  .refine(hasNoControlChars, 'Content must not contain NUL or disallowed control characters')

export const SourceReferenceKindSchema = z.enum([
  'user_input',
  'session',
  'message',
  'file',
  'external_import',
])

export const SourceReferenceSchema = z
  .object({
    kind: SourceReferenceKindSchema,
    refId: z.string().min(1).max(MEMORY_LIMITS.maxSourceRefIdLength).refine(hasNoInlineControlChars).optional(),
    label: z.string().min(1).max(MEMORY_LIMITS.maxSourceLabelLength).refine(hasNoInlineControlChars).optional(),
    uri: z.string().min(1).max(MEMORY_LIMITS.maxSourceUriLength).refine(hasNoInlineControlChars).optional(),
  })
  .strict()

export const MemoryProvenanceSchema = z
  .object({
    origin: MemoryOriginSchema,
    createdBy: SafeIdentifierSchema,
    sourceRefs: z.array(SourceReferenceSchema).max(MEMORY_LIMITS.maxSourceRefsCount),
    note: z.string().min(1).max(MEMORY_LIMITS.maxProvenanceNoteLength).refine(hasNoControlChars).optional(),
  })
  .strict()

export const MemoryRecordSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    id: MemoryIdSchema,
    scope: MemoryScopeSchema,
    origin: MemoryOriginSchema,
    category: MemoryCategorySchema,
    content: MemoryContentSchema,
    normalizedContent: z.string().min(1).max(MEMORY_LIMITS.maxContentLength),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    tags: MemoryTagsSchema,
    provenance: MemoryProvenanceSchema,
    status: MemoryStatusSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    archivedAt: UtcTimestampSchema.nullable(),
    expiresAt: UtcTimestampSchema.nullable(),
  })
  .strict()
  .refine((rec) => rec.origin === rec.provenance.origin, {
    message: 'Record origin must match provenance.origin',
  })
  .refine((rec) => (rec.status === 'archived' ? rec.archivedAt !== null : rec.archivedAt === null), {
    message: 'archivedAt must be present if and only if status is archived',
  })

export const MemoryAuthContextSchema = z
  .object({
    actorId: SafeIdentifierSchema,
    userId: UserIdSchema,
    botId: BotIdSchema.optional(),
    workspaceId: WorkspaceIdSchema.optional(),
    allowUserWideRead: z.boolean(),
    allowUserWideWrite: z.boolean().optional(),
    allowArchivedRead: z.boolean().optional(),
  })
  .strict()

export const CreateMemoryInputSchema = z
  .object({
    id: MemoryIdSchema.optional(),
    scope: MemoryScopeSchema,
    origin: MemoryOriginSchema.default('explicit'),
    category: MemoryCategorySchema,
    content: MemoryContentSchema,
    tags: MemoryTagsSchema.default([]),
    sourceRefs: z.array(SourceReferenceSchema).max(MEMORY_LIMITS.maxSourceRefsCount).default([]),
    provenanceNote: z.string().min(1).max(MEMORY_LIMITS.maxProvenanceNoteLength).refine(hasNoControlChars).optional(),
    expiresAt: UtcTimestampSchema.nullable().default(null),
  })
  .strict()

export const UpdateMemoryInputSchema = z
  .object({
    category: MemoryCategorySchema.optional(),
    content: MemoryContentSchema.optional(),
    tags: MemoryTagsSchema.optional(),
    sourceRefs: z.array(SourceReferenceSchema).max(MEMORY_LIMITS.maxSourceRefsCount).optional(),
    provenanceNote: z.string().min(1).max(MEMORY_LIMITS.maxProvenanceNoteLength).refine(hasNoControlChars).nullable().optional(),
    expiresAt: UtcTimestampSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (val) =>
      val.category !== undefined ||
      val.content !== undefined ||
      val.tags !== undefined ||
      val.sourceRefs !== undefined ||
      val.provenanceNote !== undefined ||
      val.expiresAt !== undefined,
    { message: 'At least one updatable field must be provided' },
  )

export const ListMemoriesQuerySchema = z
  .object({
    scopeKinds: z.array(MemoryScopeKindSchema).min(1).max(3).optional(),
    category: MemoryCategorySchema.optional(),
    tags: MemoryTagsSchema.optional(),
    includeUserWide: z.boolean().default(false),
    includeArchived: z.boolean().default(false),
    includeExpired: z.boolean().default(false),
    limit: z.number().int().min(1).max(MEMORY_LIMITS.maxListLimit).default(MEMORY_LIMITS.defaultListLimit),
    offset: z.number().int().min(0).max(100_000).default(0),
  })
  .strict()

export const SearchMemoriesQuerySchema = z
  .object({
    query: z.string().min(1).max(MEMORY_LIMITS.maxQueryLength).refine(hasNoControlChars),
    scopeKinds: z.array(MemoryScopeKindSchema).min(1).max(3).optional(),
    category: MemoryCategorySchema.optional(),
    tags: MemoryTagsSchema.optional(),
    includeUserWide: z.boolean().default(false),
    limit: z.number().int().min(1).max(MEMORY_LIMITS.maxSearchLimit).default(MEMORY_LIMITS.defaultSearchLimit),
    deduplicateAcrossScopes: z.boolean().default(true),
  })
  .strict()

export const ContextBuildOptionsSchema = z
  .object({
    includeUserWide: z.boolean().default(false),
    maxRecords: z.number().int().min(0).max(MEMORY_LIMITS.maxContextRecords).default(12),
    maxChars: z.number().int().min(0).max(MEMORY_LIMITS.maxContextChars).default(8192),
    maxBytes: z.number().int().min(0).max(MEMORY_LIMITS.maxContextBytes).default(16384),
    maxEstimatedTokens: z.number().int().min(0).max(MEMORY_LIMITS.maxContextChars).optional(),
    deduplicate: z.boolean().default(true),
  })
  .strict()
