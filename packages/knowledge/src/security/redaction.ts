import { containsCredentialPattern, redactSecrets, sanitizeErrorMessage } from '@ghost-bot/memory'
import { KnowledgeCredentialError } from '../contracts/errors.ts'

export { containsCredentialPattern, redactSecrets, sanitizeErrorMessage }

export function assertNoCredentialsInKnowledgeFields(fields: {
  title?: string
  displayFilename?: string | null
  tags?: readonly string[]
  extractedText?: string
  collectionName?: string
  collectionDescription?: string
}): void {
  if (fields.title && containsCredentialPattern(fields.title)) {
    throw new KnowledgeCredentialError('Document title rejected because it matches a recognized credential pattern')
  }
  if (fields.displayFilename && containsCredentialPattern(fields.displayFilename)) {
    throw new KnowledgeCredentialError('Document filename rejected because it matches a recognized credential pattern')
  }
  if (fields.collectionName && containsCredentialPattern(fields.collectionName)) {
    throw new KnowledgeCredentialError('Collection name rejected because it matches a recognized credential pattern')
  }
  if (fields.collectionDescription && containsCredentialPattern(fields.collectionDescription)) {
    throw new KnowledgeCredentialError('Collection description rejected because it matches a recognized credential pattern')
  }
  if (fields.tags) {
    for (const tag of fields.tags) {
      if (containsCredentialPattern(tag)) {
        throw new KnowledgeCredentialError('Document tag rejected because it matches a recognized credential pattern')
      }
    }
  }
  if (fields.extractedText && containsCredentialPattern(fields.extractedText)) {
    throw new KnowledgeCredentialError('Document content rejected because it matches a recognized credential pattern')
  }
}
