import { McpTrustError } from '../contracts/errors.ts'
import type { McpServerConfig } from '../contracts/types.ts'

export function assertServerTrustedForLaunch(server: McpServerConfig): void {
  if (!server.enabled) {
    throw new McpTrustError('MCP server is disabled')
  }
  if (server.trustState !== 'trusted') {
    throw new McpTrustError(`MCP server trustState is "${server.trustState}", expected "trusted"`)
  }
  if (!server.trustedFingerprint || server.trustedFingerprint !== server.configFingerprint) {
    throw new McpTrustError(
      'MCP server configuration changed since last trust approval; explicit reauthorization is required',
    )
  }
}
