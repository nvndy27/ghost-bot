export {
  MEMORY_LIMITS,
  MEMORY_SCHEMA_VERSION,
} from './contracts/limits.ts'

export {
  MemoryAuthorizationError,
  MemoryCredentialError,
  MemoryDuplicateError,
  MemoryError,
  MemoryNotFoundError,
  MemoryStorageCorruptionError,
  MemoryStorageError,
  MemoryUnsafePathError,
  MemoryUnsupportedOriginError,
  MemoryValidationError,
  type MemoryErrorCode,
} from './contracts/errors.ts'

export {
  BotIdSchema,
  BotMemoryScopeSchema,
  ContextBuildOptionsSchema,
  CreateMemoryInputSchema,
  ListMemoriesQuerySchema,
  MemoryAuthContextSchema,
  MemoryCategorySchema,
  MemoryContentSchema,
  MemoryIdSchema,
  MemoryOriginSchema,
  MemoryProvenanceSchema,
  MemoryRecordSchema,
  MemoryScopeKindSchema,
  MemoryScopeSchema,
  MemoryStatusSchema,
  MemoryTagSchema,
  MemoryTagsSchema,
  SafeIdentifierSchema,
  SearchMemoriesQuerySchema,
  SourceReferenceKindSchema,
  SourceReferenceSchema,
  UpdateMemoryInputSchema,
  UserIdSchema,
  UserMemoryScopeSchema,
  UtcTimestampSchema,
  WorkspaceIdSchema,
  WorkspaceMemoryScopeSchema,
} from './contracts/schemas.ts'

export type {
  BotMemoryScope,
  Clock,
  ContextBuildOptions,
  CreateMemoryInput,
  IdGenerator,
  ListMemoriesQuery,
  MemoryAuthContext,
  MemoryCategory,
  MemoryOrigin,
  MemoryProvenance,
  MemoryRecord,
  MemoryScope,
  MemoryScopeKind,
  MemoryStatus,
  ParsedCreateMemoryInput,
  SearchMemoriesQuery,
  SourceReference,
  UpdateMemoryInput,
  UserMemoryScope,
  WorkspaceMemoryScope,
} from './contracts/types.ts'

export type {
  MemoryListResult,
  MemoryRepository,
  MemorySearchMatch,
  MemorySearchResult,
} from './repository/interface.ts'

export {
  InMemoryMemoryRepository,
  type InMemoryRepositoryOptions,
} from './repository/in-memory.ts'

export {
  computeContentHash,
  foldVietnameseAccents,
  normalizeForDeduplication,
  normalizeStoredContent,
  normalizeTags,
} from './repository/normalization.ts'

export {
  openMemoryDatabase,
  type MemoryDatabaseHandle,
  type OpenMemoryDatabaseOptions,
} from './storage/sqlite-client.ts'

export {
  SqliteMemoryRepository,
  type SqliteMemoryRepositoryOptions,
} from './storage/sqlite-repository.ts'

export {
  MEMORY_DB_SCHEMA_VERSION,
  initializeMemorySchema,
} from './storage/sqlite-schema.ts'

export {
  buildSafeFts5MatchQuery,
} from './search/fts5.ts'

export {
  parseSearchQuery,
  scoreRecordLexical,
  type ParsedSearchQuery,
} from './search/lexical.ts'

export {
  compareSearchMatches,
  rankAndDeduplicateMatches,
} from './search/ranker.ts'

export {
  buildMemoryContext,
  estimateTokensHeuristic,
  type MemoryContextBuildResult,
} from './context/builder.ts'

export {
  serializeMemoryEnvelope,
  toSerializedMemoryItem,
  type SerializedMemoryEnvelope,
  type SerializedMemoryItem,
} from './context/serializer.ts'

export {
  assertNoCredentialsInFields,
  containsCredentialPattern,
  redactSecrets,
  sanitizeErrorMessage,
} from './security/redaction.ts'

export {
  authorizeCreateScope,
  getScopeKey,
  isAuthorizedToReadRecord,
  isAuthorizedToReadScope,
  isAuthorizedToWriteRecord,
  resolveAuthorizedScopesForQuery,
  validateAuthContext,
} from './security/authorization.ts'
