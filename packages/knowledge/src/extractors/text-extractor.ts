import { KnowledgeUnsupportedFormatError, KnowledgeValidationError } from '../contracts/errors.ts'
import { KNOWLEDGE_LIMITS } from '../contracts/limits.ts'
import type { KnowledgeMediaType, KnowledgeSourceType } from '../contracts/types.ts'

export interface ExtractedDocumentText {
  readonly normalizedText: string
  readonly mediaType: KnowledgeMediaType
  readonly sourceType: KnowledgeSourceType
}

const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true })

export function resolveSupportedFormat(
  sourceType: KnowledgeSourceType,
  rawMediaType?: string,
  displayFilename?: string | null,
): { sourceType: KnowledgeSourceType; mediaType: KnowledgeMediaType } {
  const media = (rawMediaType ?? '').trim().toLowerCase()
  const lowerName = (displayFilename ?? '').trim().toLowerCase()

  if (
    media === 'application/pdf' ||
    media === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lowerName.endsWith('.pdf') ||
    lowerName.endsWith('.docx')
  ) {
    throw new KnowledgeUnsupportedFormatError(
      'PDF and DOCX extraction are not available in Phase 3B; only direct text, UTF-8 text, and Markdown are supported',
    )
  }

  if (sourceType === 'markdown' || media === 'text/markdown' || media === 'text/x-markdown') {
    return { sourceType: 'markdown', mediaType: 'text/markdown' }
  }
  if (sourceType === 'direct_text' || sourceType === 'text_file') {
    if (media && media !== 'text/plain' && media !== 'text/markdown') {
      throw new KnowledgeUnsupportedFormatError(`Unsupported media type: ${rawMediaType}`)
    }
    return {
      sourceType,
      mediaType: media === 'text/markdown' ? 'text/markdown' : 'text/plain',
    }
  }

  throw new KnowledgeUnsupportedFormatError(`Unsupported source type: ${String(sourceType)}`)
}

export function extractUtf8DocumentText(
  rawBytes: Uint8Array,
  sourceType: KnowledgeSourceType,
  rawMediaType?: string,
  displayFilename?: string | null,
): ExtractedDocumentText {
  if (rawBytes.byteLength === 0) {
    throw new KnowledgeValidationError('Document content must not be empty')
  }
  if (rawBytes.byteLength > KNOWLEDGE_LIMITS.maxDocumentBytes) {
    throw new KnowledgeValidationError(
      `Document exceeds maximum allowed byte size (${KNOWLEDGE_LIMITS.maxDocumentBytes} bytes)`,
    )
  }

  const format = resolveSupportedFormat(sourceType, rawMediaType, displayFilename)

  // Reject binary NUL bytes before decoding
  for (let i = 0; i < rawBytes.length; i++) {
    if (rawBytes[i] === 0) {
      throw new KnowledgeValidationError('Document contains NUL bytes and cannot be ingested as UTF-8 text')
    }
  }

  let decoded: string
  try {
    decoded = utf8FatalDecoder.decode(rawBytes)
  } catch {
    throw new KnowledgeValidationError('Document bytes are not valid UTF-8 text')
  }

  // Strip UTF-8 BOM if present, normalize CRLF -> LF, and NFC-normalize Unicode
  const withoutBom = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded
  const normalizedNewlines = withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const normalizedText = normalizedNewlines.normalize('NFC').trim()

  if (normalizedText.length === 0) {
    throw new KnowledgeValidationError('Document contains no extractable non-whitespace text')
  }
  if (normalizedText.length > KNOWLEDGE_LIMITS.maxExtractedChars) {
    throw new KnowledgeValidationError(
      `Extracted text exceeds maximum character limit (${KNOWLEDGE_LIMITS.maxExtractedChars})`,
    )
  }

  return {
    normalizedText,
    mediaType: format.mediaType,
    sourceType: format.sourceType,
  }
}
