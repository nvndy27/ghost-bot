import { MemoryAuthorizationError } from '../contracts/errors.ts'
import { MemoryAuthContextSchema } from '../contracts/schemas.ts'
import type {
  MemoryAuthContext,
  MemoryRecord,
  MemoryScope,
  MemoryScopeKind,
} from '../contracts/types.ts'

export function validateAuthContext(rawAuth: MemoryAuthContext): MemoryAuthContext {
  const parsed = MemoryAuthContextSchema.safeParse(rawAuth)
  if (!parsed.success) {
    throw new MemoryAuthorizationError('Invalid or missing memory authorization context')
  }
  return parsed.data
}

export function getScopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case 'user':
      return `user:${scope.userId}`
    case 'bot':
      return `bot:${scope.userId}:${scope.botId}`
    case 'workspace':
      return `workspace:${scope.userId}:${scope.workspaceId}`
  }
}

export function authorizeCreateScope(auth: MemoryAuthContext, scope: MemoryScope): void {
  if (scope.userId !== auth.userId) {
    throw new MemoryAuthorizationError('Cannot create memory for a different user')
  }
  if (scope.kind === 'user') {
    if (auth.allowUserWideWrite !== true) {
      throw new MemoryAuthorizationError('User-wide memory write is not enabled in authorization context')
    }
    return
  }
  if (scope.kind === 'bot') {
    if (!auth.botId || auth.botId !== scope.botId) {
      throw new MemoryAuthorizationError('Authorization context does not match target bot scope')
    }
    return
  }
  if (scope.kind === 'workspace') {
    if (!auth.workspaceId || auth.workspaceId !== scope.workspaceId) {
      throw new MemoryAuthorizationError('Authorization context does not match target workspace scope')
    }
  }
}

export function isAuthorizedToReadScope(
  auth: MemoryAuthContext,
  scope: MemoryScope,
  options: { includeUserWide: boolean },
): boolean {
  if (scope.userId !== auth.userId) {
    return false
  }
  switch (scope.kind) {
    case 'user':
      return auth.allowUserWideRead === true && options.includeUserWide === true
    case 'bot':
      return Boolean(auth.botId && auth.botId === scope.botId)
    case 'workspace':
      return Boolean(auth.workspaceId && auth.workspaceId === scope.workspaceId)
  }
}

export function isAuthorizedToReadRecord(
  auth: MemoryAuthContext,
  record: MemoryRecord,
  options: { includeUserWide: boolean; includeArchived?: boolean },
): boolean {
  if (!isAuthorizedToReadScope(auth, record.scope, { includeUserWide: options.includeUserWide })) {
    return false
  }
  if (record.status === 'archived' && !(options.includeArchived && auth.allowArchivedRead === true)) {
    return false
  }
  return true
}

export function isAuthorizedToWriteRecord(auth: MemoryAuthContext, record: MemoryRecord): boolean {
  if (record.scope.userId !== auth.userId) {
    return false
  }
  switch (record.scope.kind) {
    case 'user':
      return auth.allowUserWideWrite === true
    case 'bot':
      return Boolean(auth.botId && auth.botId === record.scope.botId)
    case 'workspace':
      return Boolean(auth.workspaceId && auth.workspaceId === record.scope.workspaceId)
  }
}

export function resolveAuthorizedScopesForQuery(
  auth: MemoryAuthContext,
  requestedKinds: readonly MemoryScopeKind[] | undefined,
  includeUserWide: boolean,
): MemoryScope[] {
  const kinds: readonly MemoryScopeKind[] = requestedKinds ?? ['workspace', 'bot', 'user']
  const scopes: MemoryScope[] = []

  for (const kind of kinds) {
    if (kind === 'user') {
      if (includeUserWide && auth.allowUserWideRead) {
        scopes.push({ kind: 'user', userId: auth.userId })
      } else if (requestedKinds?.includes('user')) {
        throw new MemoryAuthorizationError('User-wide memory read requested without explicit authorization')
      }
      continue
    }
    if (kind === 'bot') {
      if (auth.botId) {
        scopes.push({ kind: 'bot', userId: auth.userId, botId: auth.botId })
      } else if (requestedKinds?.includes('bot')) {
        throw new MemoryAuthorizationError('Bot-scoped query requires botId in authorization context')
      }
      continue
    }
    if (kind === 'workspace') {
      if (auth.workspaceId) {
        scopes.push({ kind: 'workspace', userId: auth.userId, workspaceId: auth.workspaceId })
      } else if (requestedKinds?.includes('workspace')) {
        throw new MemoryAuthorizationError('Workspace-scoped query requires workspaceId in authorization context')
      }
    }
  }

  return scopes
}
