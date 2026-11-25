import {
  authorizeCreateScope as authorizeMemoryCreateScope,
  getScopeKey,
  isAuthorizedToReadScope,
  resolveAuthorizedScopesForQuery,
} from '@ghost-bot/memory'
import { KnowledgeAuthorizationError } from '../contracts/errors.ts'
import { KnowledgeAuthContextSchema } from '../contracts/schemas.ts'
import type { KnowledgeAuthContext, KnowledgeScope, KnowledgeScopeKind } from '../contracts/types.ts'

export { getScopeKey }

export function validateKnowledgeAuthContext(rawAuth: KnowledgeAuthContext): KnowledgeAuthContext {
  const parsed = KnowledgeAuthContextSchema.safeParse(rawAuth)
  if (!parsed.success) {
    throw new KnowledgeAuthorizationError('Invalid or missing knowledge authorization context')
  }
  return parsed.data
}

export function authorizeKnowledgeCreateScope(auth: KnowledgeAuthContext, scope: KnowledgeScope): void {
  try {
    authorizeMemoryCreateScope(auth, scope)
  } catch (err) {
    throw new KnowledgeAuthorizationError(err instanceof Error ? err.message : 'Unauthorized knowledge scope')
  }
}

export function isAuthorizedToReadKnowledgeScope(
  auth: KnowledgeAuthContext,
  scope: KnowledgeScope,
  options: { includeUserWide: boolean },
): boolean {
  return isAuthorizedToReadScope(auth, scope, options)
}

export function isAuthorizedToWriteKnowledgeScope(auth: KnowledgeAuthContext, scope: KnowledgeScope): boolean {
  if (scope.userId !== auth.userId) return false
  switch (scope.kind) {
    case 'user':
      return auth.allowUserWideWrite === true
    case 'bot':
      return Boolean(auth.botId && auth.botId === scope.botId)
    case 'workspace':
      return Boolean(auth.workspaceId && auth.workspaceId === scope.workspaceId)
  }
}

export function resolveAuthorizedKnowledgeScopes(
  auth: KnowledgeAuthContext,
  requestedKinds: readonly KnowledgeScopeKind[] | undefined,
  includeUserWide: boolean,
): KnowledgeScope[] {
  try {
    return resolveAuthorizedScopesForQuery(auth, requestedKinds, includeUserWide)
  } catch (err) {
    throw new KnowledgeAuthorizationError(err instanceof Error ? err.message : 'Unauthorized knowledge query scope')
  }
}
