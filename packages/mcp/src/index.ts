export {
  MCP_LIMITS,
  MCP_SCHEMA_VERSION,
  MCP_SDK_VERSION,
  MCP_SUPPORTED_SPEC_VERSION,
} from './contracts/limits.ts'

export {
  McpAuthorizationError,
  McpCancelledError,
  McpCredentialError,
  McpDuplicateError,
  McpError,
  McpNotFoundError,
  McpProtocolError,
  McpStorageCorruptionError,
  McpStorageError,
  McpTimeoutError,
  McpToolExecutionError,
  McpTransportError,
  McpTrustError,
  McpUnsafePathError,
  McpUnsupportedTransportError,
  McpValidationError,
  type McpErrorCode,
} from './contracts/errors.ts'

export {
  ListMcpServersQuerySchema,
  McpAuthContextSchema,
  McpBaseAuthContextSchema,
  McpCapabilitySnapshotSchema,
  McpConnectionStateSchema,
  McpEnvVarNameSchema,
  McpPermissionsSchema,
  McpPromptDescriptorSchema,
  McpResourceDescriptorSchema,
  McpResourceTemplateDescriptorSchema,
  McpScopeKindSchema,
  McpScopeSchema,
  McpSecretRefSchema,
  McpServerConfigSchema,
  McpServerIdSchema,
  McpStdioTransportSchema,
  McpToolDescriptorSchema,
  McpTrustStateSchema,
  RegisterMcpServerInputSchema,
  Sha256HexSchema,
  UpdateMcpServerInputSchema,
} from './contracts/schemas.ts'

export type {
  Clock,
  IdGenerator,
  ListMcpServersQuery,
  McpAuthContext,
  McpCapabilitySnapshot,
  McpConnectionState,
  McpPermissions,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceTemplateDescriptor,
  McpScope,
  McpScopeKind,
  McpSecretRef,
  McpServerConfig,
  McpStdioTransportConfig,
  McpToolDescriptor,
  McpTrustState,
  ParsedMcpAuthContext,
  RegisterMcpServerInput,
  UpdateMcpServerInput,
} from './contracts/types.ts'

export { computeServerConfigFingerprint } from './registry/fingerprint.ts'
export type { McpRegistryRepository, McpServerListResult } from './registry/interface.ts'

export {
  createBorrowedMcpDatabaseHandle,
  openMcpDatabase,
  type BorrowedMcpDatabaseOptions,
  type McpDatabaseHandle,
} from './storage/sqlite-client.ts'
export { initializeMcpSchema, MCP_DB_SCHEMA_VERSION } from './storage/sqlite-schema.ts'
export { SqliteMcpRegistry, type SqliteMcpRegistryOptions } from './storage/sqlite-registry.ts'

export { buildCapabilityKey } from './discovery/discoverer.ts'
export type { McpToolInvocationResult } from './invocation/invoker.ts'
export type { McpPromptGetResult, McpResourceReadResult } from './invocation/resources.ts'

export {
  McpConnectionManager,
  type McpConnectionInfo,
  type McpConnectionManagerOptions,
} from './lifecycle/connection-manager.ts'

export {
  DEFAULT_PERMISSIVE_HOST_POLICY,
  type HostMcpPolicyAdapter,
  type HostMcpPolicyDecision,
} from './policy/host-policy.ts'

export {
  authorizeMcpDiscovery,
  authorizeMcpLaunch,
  authorizeMcpPromptGet,
  authorizeMcpRegister,
  authorizeMcpResourceRead,
  authorizeMcpToolInvocation,
  canManageMcpServer,
  canReadMcpServer,
  getScopeKey,
  resolveAuthorizedMcpScopes,
  validateMcpAuthContext,
} from './security/authorization.ts'

export { validateStdioLaunchPaths } from './security/path-guard.ts'
export {
  assertNoCredentialsInServerInput,
  buildMinimalChildEnv,
  containsCredentialPattern,
  redactSecrets,
  sanitizeErrorMessage,
} from './security/redaction.ts'
export { assertServerTrustedForLaunch } from './security/trust.ts'
