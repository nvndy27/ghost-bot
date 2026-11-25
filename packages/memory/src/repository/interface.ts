import type {
  CreateMemoryInput,
  ListMemoriesQuery,
  MemoryAuthContext,
  MemoryRecord,
  MemoryScope,
  SearchMemoriesQuery,
  UpdateMemoryInput,
} from '../contracts/types.ts'

export interface MemoryListResult {
  readonly items: readonly MemoryRecord[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

export interface MemorySearchMatch {
  readonly record: MemoryRecord
  readonly score: number
  readonly matchType: 'exact_phrase' | 'exact_tokens' | 'accent_folded' | 'tag'
}

export interface MemorySearchResult {
  readonly items: readonly MemorySearchMatch[]
  readonly engine: 'fts5' | 'lexical_fallback'
  readonly queryTokens: readonly string[]
}

export interface MemoryRepository {
  create(auth: MemoryAuthContext, input: CreateMemoryInput): MemoryRecord
  getById(
    auth: MemoryAuthContext,
    id: string,
    options?: { includeUserWide?: boolean; includeArchived?: boolean; includeExpired?: boolean },
  ): MemoryRecord | null
  list(auth: MemoryAuthContext, query?: ListMemoriesQuery): MemoryListResult
  search(auth: MemoryAuthContext, query: SearchMemoriesQuery): MemorySearchResult
  update(auth: MemoryAuthContext, id: string, input: UpdateMemoryInput): MemoryRecord
  archive(auth: MemoryAuthContext, id: string): MemoryRecord
  delete(auth: MemoryAuthContext, id: string): boolean
  findDuplicate(auth: MemoryAuthContext, scope: MemoryScope, content: string): MemoryRecord | null
  close(): void
}
