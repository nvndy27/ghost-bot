import type { McpServerConfig, ParsedMcpAuthContext } from '../contracts/types.ts'

export interface HostMcpPolicyDecision {
  readonly allowed: boolean
  readonly reason?: string
}

/**
 * Narrow trusted-host policy hook intended for future RuntimePolicyBroker integration.
 * The daemon/broker implements this interface to enforce workspace/permission-mode policies
 * without embedding a competing approval system inside @ghost-bot/mcp.
 */
export interface HostMcpPolicyAdapter {
  evaluateLaunch(auth: ParsedMcpAuthContext, server: McpServerConfig): HostMcpPolicyDecision
  evaluateToolInvocation(
    auth: ParsedMcpAuthContext,
    server: McpServerConfig,
    toolName: string,
  ): HostMcpPolicyDecision
}

export const DEFAULT_PERMISSIVE_HOST_POLICY: HostMcpPolicyAdapter = {
  evaluateLaunch: () => ({ allowed: true }),
  evaluateToolInvocation: () => ({ allowed: true }),
}
