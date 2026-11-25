import { createHash } from 'node:crypto'
import { normalizeTags } from '@ghost-bot/memory'
import { chunkDocumentText } from '../chunking/chunker.ts'
import { KnowledgeDuplicateError, KnowledgeValidationError } from '../contracts/errors.ts'
import { KNOWLEDGE_LIMITS } from '../contracts/limits.ts'
import { IngestBytesInputSchema, IngestFileInputSchema } from '../contracts/schemas.ts'
import type { IngestBytesInput, IngestFileInput, KnowledgeAuthContext } from '../contracts/types.ts'
import { extractUtf8DocumentText } from '../extractors/text-extractor.ts'
import type { KnowledgeRepository, PersistedDocumentResult, PersistPreparedDocumentInput } from '../repository/interface.ts'
import { authorizeKnowledgeCreateScope, validateKnowledgeAuthContext } from '../security/authorization.ts'
import { readAuthorizedSourceFile } from '../security/path-guard.ts'
import { assertNoCredentialsInKnowledgeFields } from '../security/redaction.ts'

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function prepareDocumentFromBytes(
  auth: KnowledgeAuthContext,
  bytes: Uint8Array,
  rawMeta: IngestBytesInput,
): PersistPreparedDocumentInput {
  const parsed = IngestBytesInputSchema.safeParse(rawMeta)
  if (!parsed.success) {
    throw new KnowledgeValidationError(
      `Invalid document ingestion input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
    )
  }
  const meta = parsed.data
  authorizeKnowledgeCreateScope(auth, meta.scope)

  const extracted = extractUtf8DocumentText(bytes, meta.sourceType, meta.mediaType, meta.displayFilename)

  assertNoCredentialsInKnowledgeFields({
    title: meta.title,
    displayFilename: meta.displayFilename,
    tags: meta.tags,
    extractedText: extracted.normalizedText,
  })

  const rawFingerprint = sha256Hex(bytes)
  const extractedFingerprint = sha256Hex(extracted.normalizedText)
  const chunks = chunkDocumentText(extracted.normalizedText, extracted.sourceType, meta.chunking)

  return {
    documentId: meta.documentId,
    collectionId: meta.collectionId,
    scope: meta.scope,
    title: meta.title,
    sourceType: extracted.sourceType,
    mediaType: extracted.mediaType,
    displayFilename: meta.displayFilename,
    tags: normalizeTags(meta.tags),
    rawFingerprint,
    extractedFingerprint,
    charCount: extracted.normalizedText.length,
    chunks,
  }
}

export class KnowledgeIngestionPipeline {
  private readonly repository: KnowledgeRepository

  constructor(repository: KnowledgeRepository) {
    this.repository = repository
  }

  ingestText(
    rawAuth: KnowledgeAuthContext,
    input: Omit<IngestBytesInput, 'sourceType' | 'mediaType'> & { text: string; sourceType?: 'direct_text' | 'markdown' },
  ): PersistedDocumentResult {
    const auth = validateKnowledgeAuthContext(rawAuth)
    const sourceType = input.sourceType ?? 'direct_text'
    const mediaType = sourceType === 'markdown' ? 'text/markdown' : 'text/plain'
    const bytes = Buffer.from(input.text, 'utf8')
    const prepared = prepareDocumentFromBytes(auth, bytes, {
      documentId: input.documentId,
      collectionId: input.collectionId,
      scope: input.scope,
      title: input.title,
      sourceType,
      mediaType,
      displayFilename: input.displayFilename,
      tags: input.tags,
      chunking: input.chunking,
    })

    const existingDup = this.repository.findDuplicateByFingerprint(auth, prepared.scope, prepared.extractedFingerprint)
    if (existingDup) {
      throw new KnowledgeDuplicateError()
    }
    return this.repository.persistDocument(auth, prepared)
  }

  ingestBytes(
    rawAuth: KnowledgeAuthContext,
    bytes: Uint8Array,
    input: IngestBytesInput,
  ): PersistedDocumentResult {
    const auth = validateKnowledgeAuthContext(rawAuth)
    const prepared = prepareDocumentFromBytes(auth, bytes, input)
    const existingDup = this.repository.findDuplicateByFingerprint(auth, prepared.scope, prepared.extractedFingerprint)
    if (existingDup) {
      throw new KnowledgeDuplicateError()
    }
    return this.repository.persistDocument(auth, prepared)
  }

  async ingestFile(
    rawAuth: KnowledgeAuthContext,
    rawInput: IngestFileInput,
  ): Promise<PersistedDocumentResult> {
    const auth = validateKnowledgeAuthContext(rawAuth)
    const parsed = IngestFileInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new KnowledgeValidationError(
        `Invalid file ingestion input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      )
    }
    const input = parsed.data
    authorizeKnowledgeCreateScope(auth, input.scope)

    const { bytes, displayFilename } = await readAuthorizedSourceFile(
      input.filePath,
      input.allowedRootDir,
      KNOWLEDGE_LIMITS.maxDocumentBytes,
    )

    const isMarkdown =
      displayFilename.toLowerCase().endsWith('.md') ||
      displayFilename.toLowerCase().endsWith('.markdown') ||
      input.mediaType?.toLowerCase() === 'text/markdown'

    const prepared = prepareDocumentFromBytes(auth, bytes, {
      documentId: input.documentId,
      collectionId: input.collectionId,
      scope: input.scope,
      title: input.title ?? displayFilename,
      sourceType: isMarkdown ? 'markdown' : 'text_file',
      mediaType: input.mediaType ?? (isMarkdown ? 'text/markdown' : 'text/plain'),
      displayFilename,
      tags: input.tags,
      chunking: input.chunking,
    })

    const existingDup = this.repository.findDuplicateByFingerprint(auth, prepared.scope, prepared.extractedFingerprint)
    if (existingDup) {
      throw new KnowledgeDuplicateError()
    }
    return this.repository.persistDocument(auth, prepared)
  }

  replaceWithBytes(
    rawAuth: KnowledgeAuthContext,
    documentId: string,
    bytes: Uint8Array,
    input: IngestBytesInput,
  ): PersistedDocumentResult {
    const auth = validateKnowledgeAuthContext(rawAuth)
    const prepared = prepareDocumentFromBytes(auth, bytes, input)
    return this.repository.replaceDocument(auth, documentId, prepared)
  }
}
