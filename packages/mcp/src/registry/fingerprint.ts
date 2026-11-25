import { createHash } from 'node:crypto'
import type { McpScope, McpStdioTransportConfig } from '../contracts/types.ts'

export function computeServerConfigFingerprint(
  scope: McpScope,
  transport: McpStdioTransportConfig,
): string {
  const canonical = JSON.stringify({
    scope,
    transport: {
      type: transport.type,
      executablePath: transport.executablePath,
      args: transport.args,
      cwd: transport.cwd,
      envAllowlist: [...transport.envAllowlist].sort(),
      secretRefs: [...transport.secretRefs]
        .map((r) => ({ envVar: r.envVar, refId: r.refId }))
        .sort((a, b) => a.envVar.localeCompare(b.envVar)),
    },
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
