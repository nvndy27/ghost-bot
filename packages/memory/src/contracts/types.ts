import type { z } from 'zod'
import type {
  BotMemoryScopeSchema,
  ContextBuildOptionsSchema,
  CreateMemoryInputSchema,
  ListMemoriesQuerySchema,
  MemoryAuthContextSchema,
  MemoryCategorySchema,
  MemoryOriginSchema,
  MemoryProvenanceSchema,
  MemoryRecordSchema,
  MemoryScopeKindSchema,
  MemoryScopeSchema,
  MemoryStatusSchema,
  SearchMemoriesQuerySchema,
  SourceReferenceSchema,
  UpdateMemoryInputSchema,
  UserMemoryScopeSchema,
  WorkspaceMemoryScopeSchema,
} from './schemas.ts'

export type MemoryScopeKind = z.infer<typeof MemoryScopeKindSchema>
export type UserMemoryScope = z.infer<typeof UserMemoryScopeSchema>
export type BotMemoryScope = z.infer<typeof BotMemoryScopeSchema>
export type WorkspaceMemoryScope = z.infer<typeof WorkspaceMemoryScopeSchema>
export type MemoryScope = z.infer<typeof MemoryScopeSchema>

export type MemoryCategory = z.infer<typeof MemoryCategorySchema>
export type MemoryOrigin = z.infer<typeof MemoryOriginSchema>
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>
export type SourceReference = z.infer<typeof SourceReferenceSchema>
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>
export type MemoryAuthContext = z.infer<typeof MemoryAuthContextSchema>

export type CreateMemoryInput = z.input<typeof CreateMemoryInputSchema>
export type ParsedCreateMemoryInput = z.output<typeof CreateMemoryInputSchema>
export type UpdateMemoryInput = z.input<typeof UpdateMemoryInputSchema>
export type ListMemoriesQuery = z.input<typeof ListMemoriesQuerySchema>
export type SearchMemoriesQuery = z.input<typeof SearchMemoriesQuerySchema>
export type ContextBuildOptions = z.input<typeof ContextBuildOptionsSchema>

export type Clock = () => Date
export type IdGenerator = () => string
