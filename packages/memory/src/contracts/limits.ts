export const MEMORY_SCHEMA_VERSION = 1 as const

export const MEMORY_LIMITS = {
  maxIdLength: 128,
  maxActorIdLength: 128,
  maxContentLength: 8192,
  maxTagLength: 64,
  maxTagsCount: 20,
  maxSourceRefsCount: 10,
  maxSourceRefIdLength: 128,
  maxSourceLabelLength: 160,
  maxSourceUriLength: 512,
  maxProvenanceNoteLength: 512,
  maxQueryLength: 512,
  maxQueryTokens: 16,
  maxListLimit: 100,
  defaultListLimit: 25,
  maxSearchLimit: 50,
  defaultSearchLimit: 10,
  maxCandidateRecords: 200,
  maxContextRecords: 50,
  maxContextChars: 32_768,
  maxContextBytes: 65_536,
} as const
