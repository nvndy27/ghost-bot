import type { ProducedChunk } from '../chunking/chunker.ts'
import type {
  CreateCollectionInput,
  KnowledgeAuthContext,
  KnowledgeChunk,
  KnowledgeCitation,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeDocumentRevision,
  KnowledgeMediaType,
  KnowledgeScope,
  KnowledgeSourceType,
  ListDocumentsQuery,
  SearchKnowledgeQuery,
  UpdateDocumentMetadataInput,
} from '../contracts/types.ts'
import type { KnowledgeSearchMatch } from '../retrieval/lexical.ts'

export interface PersistPreparedDocumentInput {
  readonly documentId?: string
  readonly collectionId: string | null
  readonly scope: KnowledgeScope
  readonly title: string
  readonly sourceType: KnowledgeSourceType
  readonly mediaType: KnowledgeMediaType
  readonly displayFilename: string | null
  readonly tags: readonly string[]
  readonly rawFingerprint: string
  readonly extractedFingerprint: string
  readonly charCount: number
  readonly chunks: readonly ProducedChunk[]
}

export interface PersistedDocumentResult {
  readonly document: KnowledgeDocument
  readonly revision: KnowledgeDocumentRevision
  readonly chunks: readonly KnowledgeChunk[]
}

export interface KnowledgeListResult {
  readonly items: readonly KnowledgeDocument[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

export interface KnowledgeSearchResult {
  readonly items: readonly KnowledgeSearchMatch[]
  readonly citations: readonly KnowledgeCitation[]
  readonly engine: 'fts5' | 'lexical_fallback'
  readonly queryTokens: readonly string[]
}

export interface KnowledgeRepository {
  createCollection(auth: KnowledgeAuthContext, input: CreateCollectionInput): KnowledgeCollection
  listCollections(
    auth: KnowledgeAuthContext,
    options?: { includeUserWide?: boolean; includeArchived?: boolean },
  ): KnowledgeCollection[]
  persistDocument(auth: KnowledgeAuthContext, input: PersistPreparedDocumentInput): PersistedDocumentResult
  replaceDocument(auth: KnowledgeAuthContext, documentId: string, input: PersistPreparedDocumentInput): PersistedDocumentResult
  getDocumentById(
    auth: KnowledgeAuthContext,
    documentId: string,
    options?: { includeUserWide?: boolean; includeArchived?: boolean },
  ): KnowledgeDocument | null
  listDocuments(auth: KnowledgeAuthContext, query?: ListDocumentsQuery): KnowledgeListResult
  getDocumentChunks(
    auth: KnowledgeAuthContext,
    documentId: string,
    options?: { includeUserWide?: boolean; includeArchived?: boolean },
  ): KnowledgeChunk[]
  updateDocumentMetadata(
    auth: KnowledgeAuthContext,
    documentId: string,
    input: UpdateDocumentMetadataInput,
  ): KnowledgeDocument
  archiveDocument(auth: KnowledgeAuthContext, documentId: string): KnowledgeDocument
  deleteDocument(auth: KnowledgeAuthContext, documentId: string): boolean
  findDuplicateByFingerprint(
    auth: KnowledgeAuthContext,
    scope: KnowledgeScope,
    extractedFingerprint: string,
  ): KnowledgeDocument | null
  search(auth: KnowledgeAuthContext, query: SearchKnowledgeQuery): KnowledgeSearchResult
  resolveCitation(
    auth: KnowledgeAuthContext,
    ref: { documentId: string; revisionId: string; chunkId: string },
    options?: { includeUserWide?: boolean },
  ): KnowledgeCitation | null
  close(): void
}
