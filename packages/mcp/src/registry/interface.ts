import type {
  ListMcpServersQuery,
  McpAuthContext,
  McpServerConfig,
  RegisterMcpServerInput,
  UpdateMcpServerInput,
} from '../contracts/types.ts'

export interface McpServerListResult {
  readonly items: readonly McpServerConfig[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

export type McpRegistryInvalidationListener = (serverId: string) => void

export interface McpRegistryRepository {
  register(auth: McpAuthContext, input: RegisterMcpServerInput): McpServerConfig
  getById(auth: McpAuthContext, serverId: string, options?: { includeUserWide?: boolean }): McpServerConfig | null
  list(auth: McpAuthContext, query?: ListMcpServersQuery): McpServerListResult
  update(auth: McpAuthContext, serverId: string, input: UpdateMcpServerInput): McpServerConfig
  enable(auth: McpAuthContext, serverId: string): McpServerConfig
  disable(auth: McpAuthContext, serverId: string): McpServerConfig
  approveTrust(auth: McpAuthContext, serverId: string): McpServerConfig
  revokeTrust(auth: McpAuthContext, serverId: string): McpServerConfig
  delete(auth: McpAuthContext, serverId: string): boolean
  subscribeInvalidation?(listener: McpRegistryInvalidationListener): () => void
  close(): void
}
