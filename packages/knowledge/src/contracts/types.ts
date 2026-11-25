import type { z } from 'zod'
import type {
  ChunkingOptionsSchema,
  CreateCollectionInputSchema,
  IngestBytesInputSchema,
  IngestFileInputSchema,
  KnowledgeAuthContextSchema,
  KnowledgeChunkSchema,
  KnowledgeCitationSchema,
  KnowledgeCollectionSchema,
  KnowledgeContextBuildOptionsSchema,
  KnowledgeDocumentRevisionSchema,
  KnowledgeDocumentSchema,
  KnowledgeDocumentStatusSchema,
  KnowledgeMediaTypeSchema,
  KnowledgeScopeKindSchema,
  KnowledgeScopeSchema,
  KnowledgeSourceLocationSchema,
  KnowledgeSourceTypeSchema,
  ListDocumentsQuerySchema,
  SearchKnowledgeQuerySchema,
  UpdateDocumentMetadataInputSchema,
} from './schemas.ts'

export type KnowledgeScopeKind = z.infer<typeof KnowledgeScopeKindSchema>
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>
export type KnowledgeAuthContext = z.infer<typeof KnowledgeAuthContextSchema>
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceTypeSchema>
export type KnowledgeMediaType = z.infer<typeof KnowledgeMediaTypeSchema>
export type KnowledgeDocumentStatus = z.infer<typeof KnowledgeDocumentStatusSchema>
export type KnowledgeSourceLocation = z.infer<typeof KnowledgeSourceLocationSchema>
export type KnowledgeCollection = z.infer<typeof KnowledgeCollectionSchema>
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>
export type KnowledgeDocumentRevision = z.infer<typeof KnowledgeDocumentRevisionSchema>
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>
export type KnowledgeCitation = z.infer<typeof KnowledgeCitationSchema>

export type ChunkingOptions = z.input<typeof ChunkingOptionsSchema>
export type CreateCollectionInput = z.input<typeof CreateCollectionInputSchema>
export type IngestBytesInput = z.input<typeof IngestBytesInputSchema>
export type IngestFileInput = z.input<typeof IngestFileInputSchema>
export type UpdateDocumentMetadataInput = z.input<typeof UpdateDocumentMetadataInputSchema>
export type ListDocumentsQuery = z.input<typeof ListDocumentsQuerySchema>
export type SearchKnowledgeQuery = z.input<typeof SearchKnowledgeQuerySchema>
export type KnowledgeContextBuildOptions = z.input<typeof KnowledgeContextBuildOptionsSchema>

export type Clock = () => Date
export type IdGenerator = () => string
