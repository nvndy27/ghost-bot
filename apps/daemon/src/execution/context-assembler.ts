import type { KnowledgeCitationDto } from '@ghost-bot/shared-types/ipc'
import type { PreparedExecutionMemoryContext } from '../memory/service.ts'
import type { PreparedExecutionKnowledgeContext } from '../knowledge/service.ts'

export const COMBINED_EXECUTION_CONTEXT_LIMITS = {
  maxMemoryBytes: 4096,
  maxKnowledgeBytes: 8192,
  maxCombinedBytes: 12_288,
  envelopeOverheadBytes: 256,
} as const

export interface CombinedExecutionContext {
  envelopeJson: string | null
  totalBytes: number
  memory: PreparedExecutionMemoryContext
  knowledge: PreparedExecutionKnowledgeContext
  attachedSources: Array<{
    documentId: string
    revisionId: string
    chunkId: string
    title: string
  }>
}

export function assembleCombinedExecutionContext(
  memory: PreparedExecutionMemoryContext,
  knowledge: PreparedExecutionKnowledgeContext,
): CombinedExecutionContext {
  const memAttached = memory.status === 'attached' && memory.envelopeJson !== null
  const knowAttached = knowledge.status === 'attached' && knowledge.envelopeJson !== null

  if (!memAttached && !knowAttached) {
    return {
      envelopeJson: null,
      totalBytes: 0,
      memory,
      knowledge,
      attachedSources: [],
    }
  }

  const attachedSources = knowAttached
    ? knowledge.citations.map((c: KnowledgeCitationDto) => ({
        documentId: c.documentId,
        revisionId: c.revisionId,
        chunkId: c.chunkId,
        title: c.title,
      }))
    : []

  if (memAttached && !knowAttached) {
    const bytes = Buffer.byteLength(memory.envelopeJson!, 'utf8')
    return {
      envelopeJson: memory.envelopeJson,
      totalBytes: bytes,
      memory,
      knowledge,
      attachedSources: [],
    }
  }

  if (!memAttached && knowAttached) {
    const bytes = Buffer.byteLength(knowledge.envelopeJson!, 'utf8')
    return {
      envelopeJson: knowledge.envelopeJson,
      totalBytes: bytes,
      memory,
      knowledge,
      attachedSources,
    }
  }

  const combinedObj = {
    envelope: 'untrusted_execution_reference_data',
    authority: 'none',
    memory: JSON.parse(memory.envelopeJson!) as unknown,
    knowledge: JSON.parse(knowledge.envelopeJson!) as unknown,
  }
  const combinedJson = JSON.stringify(combinedObj)
  const combinedBytes = Buffer.byteLength(combinedJson, 'utf8')

  if (combinedBytes <= COMBINED_EXECUTION_CONTEXT_LIMITS.maxCombinedBytes) {
    return {
      envelopeJson: combinedJson,
      totalBytes: combinedBytes,
      memory,
      knowledge,
      attachedSources,
    }
  }

  // Fallback to whichever domain fits within combined budget if serialization overhead pushed over limit.
  const memBytes = Buffer.byteLength(memory.envelopeJson!, 'utf8')
  if (memBytes <= COMBINED_EXECUTION_CONTEXT_LIMITS.maxCombinedBytes) {
    return {
      envelopeJson: memory.envelopeJson,
      totalBytes: memBytes,
      memory,
      knowledge: {
        ...knowledge,
        status: 'empty',
        envelopeJson: null,
        selectedDocuments: 0,
        selectedChunks: 0,
        totalBytes: 0,
        truncated: true,
        citations: [],
      },
      attachedSources: [],
    }
  }

  return {
    envelopeJson: null,
    totalBytes: 0,
    memory,
    knowledge,
    attachedSources: [],
  }
}
