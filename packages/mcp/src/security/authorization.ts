import {
  authorizeCreateScope,
  getScopeKey,
  isAuthorizedToReadScope,
  resolveAuthorizedScopesForQuery,
} from '@ghost-bot/memory'
import { McpAuthorizationError } from '../contracts/errors.ts'
import { McpAuthContextSchema } from '../contracts/schemas.ts'
import type { McpAuthContext, McpScope, McpScopeKind, ParsedMcpAuthContext } from '../contracts/types.ts'

export { getScopeKey }

export function validateMcpAuthContext(rawAuth: McpAuthContext): ParsedMcpAuthContext {
  const parsed = McpAuthContextSchema.safeParse(rawAuth)
  if (!parsed.success) {
    throw new McpAuthorizationError('Invalid or missing MCP authorization context')
  }
  return parsed.data
}

function isAuthorizedToWriteScope(auth: ParsedMcpAuthContext, scope: McpScope): boolean {
  if (scope.userId !== auth.host.userId) return false
  switch (scope.kind) {
    case 'user':
      return auth.host.allowUserWideWrite === true
    case 'bot':
      return Boolean(auth.host.botId && auth.host.botId === scope.botId)
    case 'workspace':
      return Boolean(auth.host.workspaceId && auth.host.workspaceId === scope.workspaceId)
  }
}

export function authorizeMcpRegister(auth: ParsedMcpAuthContext, scope: McpScope): void {
  if (!auth.permissions.canManageConfig) {
    throw new McpAuthorizationError('MCP configuration management permission is required')
  }
  try {
    authorizeCreateScope(auth.host, scope)
  } catch (err) {
    throw new McpAuthorizationError(err instanceof Error ? err.message : 'Unauthorized MCP scope')
  }
}

export function canReadMcpServer(
  auth: ParsedMcpAuthContext,
  scope: McpScope,
  options: { includeUserWide: boolean },
): boolean {
  if (!auth.permissions.canReadConfig) return false
  return isAuthorizedToReadScope(auth.host, scope, options)
}

export function canManageMcpServer(auth: ParsedMcpAuthContext, scope: McpScope): boolean {
  if (!auth.permissions.canManageConfig) return false
  return isAuthorizedToWriteScope(auth, scope)
}

export function authorizeMcpLaunch(auth: ParsedMcpAuthContext, scope: McpScope): void {
  if (!auth.permissions.canLaunch) {
    throw new McpAuthorizationError('MCP launch permission is required')
  }
  if (!isAuthorizedToReadScope(auth.host, scope, { includeUserWide: scope.kind === 'user' })) {
    throw new McpAuthorizationError('Authorization context does not grant access to this MCP server scope')
  }
}

export function authorizeMcpDiscovery(auth: ParsedMcpAuthContext, scope: McpScope): void {
  if (!auth.permissions.canDiscover) {
    throw new McpAuthorizationError('MCP capability discovery permission is required')
  }
  if (!isAuthorizedToReadScope(auth.host, scope, { includeUserWide: scope.kind === 'user' })) {
    throw new McpAuthorizationError('Authorization context does not grant discovery access to this MCP server scope')
  }
}

export function authorizeMcpToolInvocation(
  auth: ParsedMcpAuthContext,
  scope: McpScope,
  capabilityKey: string,
  toolName: string,
  definitionHash?: string,
): void {
  if (!isAuthorizedToReadScope(auth.host, scope, { includeUserWide: scope.kind === 'user' })) {
    throw new McpAuthorizationError('Authorization context does not match MCP server scope')
  }
  const grants = auth.permissions.allowedToolHashes
  if (grants && (definitionHash === undefined || !Object.hasOwn(grants, capabilityKey) ||
      grants[capabilityKey] !== definitionHash)) {
    throw new McpAuthorizationError('Tool definition does not match the authorized MCP grant')
  }
  const allowed = auth.permissions.allowedTools
  if (!allowed.includes(capabilityKey) && !allowed.includes(toolName)) {
    throw new McpAuthorizationError(`Tool invocation is not authorized for "${toolName}"`)
  }
}

export function authorizeMcpResourceRead(
  auth: ParsedMcpAuthContext,
  scope: McpScope,
  uri: string,
): void {
  if (!isAuthorizedToReadScope(auth.host, scope, { includeUserWide: scope.kind === 'user' })) {
    throw new McpAuthorizationError('Authorization context does not match MCP server scope')
  }
  if (!auth.permissions.allowedResources.includes(uri)) {
    throw new McpAuthorizationError('Resource read is not authorized for the requested URI')
  }
}

export function authorizeMcpPromptGet(
  auth: ParsedMcpAuthContext,
  scope: McpScope,
  capabilityKey: string,
  promptName: string,
): void {
  if (!isAuthorizedToReadScope(auth.host, scope, { includeUserWide: scope.kind === 'user' })) {
    throw new McpAuthorizationError('Authorization context does not match MCP server scope')
  }
  const allowed = auth.permissions.allowedPrompts
  if (!allowed.includes(capabilityKey) && !allowed.includes(promptName)) {
    throw new McpAuthorizationError(`Prompt retrieval is not authorized for "${promptName}"`)
  }
}

export function resolveAuthorizedMcpScopes(
  auth: ParsedMcpAuthContext,
  requestedKinds: readonly McpScopeKind[] | undefined,
  includeUserWide: boolean,
): McpScope[] {
  if (!auth.permissions.canReadConfig) {
    return []
  }
  try {
    return resolveAuthorizedScopesForQuery(auth.host, requestedKinds, includeUserWide)
  } catch (err) {
    throw new McpAuthorizationError(err instanceof Error ? err.message : 'Unauthorized MCP query scope')
  }
}
