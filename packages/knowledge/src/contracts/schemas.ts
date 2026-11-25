import {
  MemoryAuthContextSchema,
  MemoryScopeKindSchema,
  MemoryScopeSchema,
  SafeIdentifierSchema,
  UtcTimestampSchema,
} from '@ghost-bot/memory'
import { z } from 'zod'
import { KNOWLEDGE_LIMITS, KNOWLEDGE_SCHEMA_VERSION } from './limits.ts'

function hasNoInlineControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return false
    }
  }
  return true
}

function hasNoDisallowedControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return false
    }
  }
  return true
}

export const CollectionIdSchema = SafeIdentifierSchema
export const DocumentIdSchema = SafeIdentifierSchema
export const RevisionIdSchema = SafeIdentifierSchema
export const ChunkIdSchema = SafeIdentifierSchema

export const KnowledgeScopeSchema = MemoryScopeSchema
export const KnowledgeScopeKindSchema = MemoryScopeKindSchema
export const KnowledgeAuthContextSchema = MemoryAuthContextSchema

export const KnowledgeSourceTypeSchema = z.enum(['direct_text', 'text_file', 'markdown'])
export const KnowledgeMediaTypeSchema = z.enum(['text/plain', 'text/markdown'])
export const KnowledgeDocumentStatusSchema = z.enum(['ready', 'archived'])
export const KnowledgeCollectionStatusSchema = z.enum(['active', 'archived'])

export const KnowledgeTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(KNOWLEDGE_LIMITS.maxTagLength)
  .refine(hasNoInlineControlChars, 'Tag must not contain control characters')

export const KnowledgeTagsSchema = z.array(KnowledgeTagSchema).max(KNOWLEDGE_LIMITS.maxTagsCount)

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const KnowledgeSourceLocationSchema = z
  .object({
    pageNumber: z.number().int().min(1).nullable(),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    startChar: z.number().int().min(0),
    endChar: z.number().int().min(1),
    sectionPath: z.array(z.string().min(1).max(KNOWLEDGE_LIMITS.maxTitleLength)).max(KNOWLEDGE_LIMITS.maxSectionPathDepth),
  })
  .strict()
  .refine((loc) => loc.endLine >= loc.startLine && loc.endChar > loc.startChar, {
    message: 'Invalid source location range',
  })

export const KnowledgeCollectionSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
    id: CollectionIdSchema,
    scope: KnowledgeScopeSchema,
    name: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.maxCollectionNameLength).refine(hasNoInlineControlChars),
    description: z.string().trim().max(KNOWLEDGE_LIMITS.maxCollectionDescriptionLength).refine(hasNoDisallowedControlChars).default(''),
    status: KnowledgeCollectionStatusSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    archivedAt: UtcTimestampSchema.nullable(),
  })
  .strict()

export const KnowledgeDocumentSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
    id: DocumentIdSchema,
    collectionId: CollectionIdSchema.nullable(),
    scope: KnowledgeScopeSchema,
    title: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.maxTitleLength).refine(hasNoInlineControlChars),
    sourceType: KnowledgeSourceTypeSchema,
    mediaType: KnowledgeMediaTypeSchema,
    displayFilename: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.maxFilenameLength).refine(hasNoInlineControlChars).nullable(),
    tags: KnowledgeTagsSchema,
    status: KnowledgeDocumentStatusSchema,
    currentRevisionId: RevisionIdSchema,
    rawFingerprint: Sha256HexSchema,
    extractedFingerprint: Sha256HexSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    archivedAt: UtcTimestampSchema.nullable(),
  })
  .strict()
  .refine((doc) => (doc.status === 'archived' ? doc.archivedAt !== null : doc.archivedAt === null), {
    message: 'archivedAt must be present if and only if status is archived',
  })

export const KnowledgeDocumentRevisionSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
    id: RevisionIdSchema,
    documentId: DocumentIdSchema,
    revisionNumber: z.number().int().min(1),
    rawFingerprint: Sha256HexSchema,
    extractedFingerprint: Sha256HexSchema,
    charCount: z.number().int().min(1),
    chunkCount: z.number().int().min(1).max(KNOWLEDGE_LIMITS.maxChunksPerDocument),
    createdAt: UtcTimestampSchema,
  })
  .strict()

export const KnowledgeChunkSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
    id: ChunkIdSchema,
    documentId: DocumentIdSchema,
    revisionId: RevisionIdSchema,
    scope: KnowledgeScopeSchema,
    chunkIndex: z.number().int().min(0),
    content: z.string().min(1).max(KNOWLEDGE_LIMITS.maxChunkChars).refine(hasNoDisallowedControlChars),
    normalizedContent: z.string().min(1).max(KNOWLEDGE_LIMITS.maxChunkChars),
    contentHash: Sha256HexSchema,
    location: KnowledgeSourceLocationSchema,
    createdAt: UtcTimestampSchema,
  })
  .strict()

export const KnowledgeCitationSchema = z
  .object({
    documentId: DocumentIdSchema,
    revisionId: RevisionIdSchema,
    chunkId: ChunkIdSchema,
    scope: KnowledgeScopeSchema,
    title: z.string().min(1).max(KNOWLEDGE_LIMITS.maxTitleLength),
    sourceType: KnowledgeSourceTypeSchema,
    displayFilename: z.string().min(1).max(KNOWLEDGE_LIMITS.maxFilenameLength).nullable(),
    pageNumber: z.number().int().min(1).nullable(),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    startChar: z.number().int().min(0),
    endChar: z.number().int().min(1),
    sectionPath: z.array(z.string()),
    excerpt: z.string().min(1).max(KNOWLEDGE_LIMITS.maxCitationExcerptChars),
  })
  .strict()

export const ChunkingOptionsSchema = z
  .object({
    targetChunkChars: z
      .number()
      .int()
      .min(KNOWLEDGE_LIMITS.minTargetChunkChars)
      .max(KNOWLEDGE_LIMITS.maxChunkChars)
      .default(KNOWLEDGE_LIMITS.defaultTargetChunkChars),
    maxChunkChars: z
      .number()
      .int()
      .min(KNOWLEDGE_LIMITS.minTargetChunkChars)
      .max(KNOWLEDGE_LIMITS.maxChunkChars)
      .default(KNOWLEDGE_LIMITS.maxChunkChars),
    overlapChars: z
      .number()
      .int()
      .min(0)
      .max(KNOWLEDGE_LIMITS.maxOverlapChars)
      .default(KNOWLEDGE_LIMITS.defaultOverlapChars),
  })
  .strict()
  .refine((opts) => opts.targetChunkChars <= opts.maxChunkChars, {
    message: 'targetChunkChars must not exceed maxChunkChars',
  })
  .refine((opts) => opts.overlapChars < opts.targetChunkChars, {
    message: 'overlapChars must be strictly less than targetChunkChars',
  })

export const CreateCollectionInputSchema = z
  .object({
    id: CollectionIdSchema.optional(),
    scope: KnowledgeScopeSchema,
    name: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.maxCollectionNameLength).refine(hasNoInlineControlChars),
    description: z.string().trim().max(KNOWLEDGE_LIMITS.maxCollectionDescriptionLength).refine(hasNoDisallowedControlChars).default(''),
  })
  .strict()

export const IngestBytesInputSchema = z
  .object({
    documentId: DocumentIdSchema.optional(),
    collectionId: CollectionIdSchema.nullable().default(null),
    scope: KnowledgeScopeSchema,
    title: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.maxTitleLength).refine(hasNoInlineControlChars),
    sourceType: KnowledgeSourceTypeSchema,
    mediaType: z.string().trim().min(1).max(128),
    displayFilename: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.maxFilenameLength).refine(hasNoInlineControlChars).nullable().default(null),
    tags: KnowledgeTagsSchema.default([]),
    chunking: ChunkingOptionsSchema.optional(),
  })
  .strict()

export const IngestFileInputSchema = z
  .object({
    documentId: DocumentIdSchema.optional(),
    collectionId: CollectionIdSchema.nullable().default(null),
    scope: KnowledgeScopeSchema,
    title: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.maxTitleLength).refine(hasNoInlineControlChars).optional(),
    filePath: z.string().min(1).max(4096),
    allowedRootDir: z.string().min(1).max(4096),
    mediaType: z.string().trim().min(1).max(128).optional(),
    tags: KnowledgeTagsSchema.default([]),
    chunking: ChunkingOptionsSchema.optional(),
  })
  .strict()

export const UpdateDocumentMetadataInputSchema = z
  .object({
    title: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.maxTitleLength).refine(hasNoInlineControlChars).optional(),
    collectionId: CollectionIdSchema.nullable().optional(),
    tags: KnowledgeTagsSchema.optional(),
  })
  .strict()
  .refine((val) => val.title !== undefined || val.collectionId !== undefined || val.tags !== undefined, {
    message: 'At least one metadata field must be provided',
  })

export const ListDocumentsQuerySchema = z
  .object({
    scopeKinds: z.array(KnowledgeScopeKindSchema).min(1).max(3).optional(),
    collectionId: CollectionIdSchema.optional(),
    tags: KnowledgeTagsSchema.optional(),
    includeUserWide: z.boolean().default(false),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().min(1).max(KNOWLEDGE_LIMITS.maxListLimit).default(KNOWLEDGE_LIMITS.defaultListLimit),
    offset: z.number().int().min(0).max(100_000).default(0),
  })
  .strict()

export const SearchKnowledgeQuerySchema = z
  .object({
    query: z.string().min(1).max(KNOWLEDGE_LIMITS.maxQueryLength).refine(hasNoDisallowedControlChars),
    scopeKinds: z.array(KnowledgeScopeKindSchema).min(1).max(3).optional(),
    collectionId: CollectionIdSchema.optional(),
    documentId: DocumentIdSchema.optional(),
    tags: KnowledgeTagsSchema.optional(),
    includeUserWide: z.boolean().default(false),
    limit: z.number().int().min(1).max(KNOWLEDGE_LIMITS.maxSearchLimit).default(KNOWLEDGE_LIMITS.defaultSearchLimit),
    deduplicateOverlappingChunks: z.boolean().default(true),
  })
  .strict()

export const KnowledgeContextBuildOptionsSchema = z
  .object({
    includeUserWide: z.boolean().default(false),
    maxDocuments: z.number().int().min(0).max(KNOWLEDGE_LIMITS.maxContextDocuments).default(5),
    maxChunks: z.number().int().min(0).max(KNOWLEDGE_LIMITS.maxContextChunks).default(12),
    maxChars: z.number().int().min(0).max(KNOWLEDGE_LIMITS.maxContextChars).default(16_384),
    maxBytes: z.number().int().min(0).max(KNOWLEDGE_LIMITS.maxContextBytes).default(32_768),
    maxEstimatedTokens: z.number().int().min(0).max(KNOWLEDGE_LIMITS.maxContextChars).optional(),
    deduplicate: z.boolean().default(true),
  })
  .strict()
