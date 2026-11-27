export { KNOWLEDGE_LIMITS, KNOWLEDGE_SCHEMA_VERSION } from './contracts/limits.ts'

export {
  KnowledgeAuthorizationError,
  KnowledgeCredentialError,
  KnowledgeDuplicateError,
  KnowledgeError,
  KnowledgeNotFoundError,
  KnowledgeStorageCorruptionError,
  KnowledgeStorageError,
  KnowledgeUnsafePathError,
  KnowledgeUnsupportedFormatError,
  KnowledgeValidationError,
  type KnowledgeErrorCode,
} from './contracts/errors.ts'

export {
  ChunkIdSchema,
  ChunkingOptionsSchema,
  CollectionIdSchema,
  CreateCollectionInputSchema,
  DocumentIdSchema,
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
  KnowledgeTagSchema,
  KnowledgeTagsSchema,
  ListDocumentsQuerySchema,
  RevisionIdSchema,
  SearchKnowledgeQuerySchema,
  Sha256HexSchema,
  UpdateDocumentMetadataInputSchema,
} from './contracts/schemas.ts'

export type {
  ChunkingOptions,
  Clock,
  CreateCollectionInput,
  IdGenerator,
  IngestBytesInput,
  IngestFileInput,
  KnowledgeAuthContext,
  KnowledgeChunk,
  KnowledgeCitation,
  KnowledgeCollection,
  KnowledgeContextBuildOptions,
  KnowledgeDocument,
  KnowledgeDocumentRevision,
  KnowledgeDocumentStatus,
  KnowledgeMediaType,
  KnowledgeScope,
  KnowledgeScopeKind,
  KnowledgeSourceLocation,
  KnowledgeSourceType,
  ListDocumentsQuery,
  SearchKnowledgeQuery,
  UpdateDocumentMetadataInput,
} from './contracts/types.ts'

export { extractUtf8DocumentText, resolveSupportedFormat, type ExtractedDocumentText } from './extractors/text-extractor.ts'
export { chunkDocumentText, type ProducedChunk } from './chunking/chunker.ts'

export type {
  KnowledgeListResult,
  KnowledgeRepository,
  KnowledgeSearchResult,
  PersistedDocumentResult,
  PersistPreparedDocumentInput,
} from './repository/interface.ts'

export {
  createBorrowedKnowledgeDatabaseHandle,
  openKnowledgeDatabase,
  type BorrowedKnowledgeDatabaseOptions,
  type KnowledgeDatabaseHandle,
  type OpenKnowledgeDatabaseOptions,
} from './storage/sqlite-client.ts'
export { SqliteKnowledgeRepository, type SqliteKnowledgeRepositoryOptions } from './storage/sqlite-repository.ts'
export { initializeKnowledgeSchema, KNOWLEDGE_DB_SCHEMA_VERSION } from './storage/sqlite-schema.ts'

export { KnowledgeIngestionPipeline } from './ingestion/pipeline.ts'

export { parseKnowledgeQuery, scoreKnowledgeChunk, type KnowledgeSearchMatch, type ParsedKnowledgeQuery } from './retrieval/lexical.ts'
export { compareKnowledgeMatches, rankAndSuppressChunks } from './retrieval/ranker.ts'

export { buildBoundedExcerpt, buildKnowledgeCitation } from './citations/builder.ts'
export { serializeKnowledgeEnvelope, type SerializedKnowledgeEnvelope, type SerializedKnowledgeItem } from './context/serializer.ts'
export {
  buildKnowledgeContext,
  buildValidatedKnowledgeContext,
  estimateKnowledgeTokensHeuristic,
  revalidateKnowledgeCandidates,
  type KnowledgeContextBuildResult,
  type KnowledgeContextCandidate,
} from './context/builder.ts'

export { readAuthorizedSourceFile } from './security/path-guard.ts'
export { assertNoCredentialsInKnowledgeFields, containsCredentialPattern, redactSecrets, sanitizeErrorMessage } from './security/redaction.ts'
export {
  authorizeKnowledgeCreateScope,
  getScopeKey,
  isAuthorizedToReadKnowledgeScope,
  isAuthorizedToWriteKnowledgeScope,
  resolveAuthorizedKnowledgeScopes,
  validateKnowledgeAuthContext,
} from './security/authorization.ts'
