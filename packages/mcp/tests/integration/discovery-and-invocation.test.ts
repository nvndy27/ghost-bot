import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  McpAuthorizationError,
  McpConnectionManager,
  McpNotFoundError,
  McpProtocolError,
  McpTrustError,
  McpValidationError,
  openMcpDatabase,
  SqliteMcpRegistry,
  type McpAuthContext,
} from '../../src/index.ts'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const VALID_SERVER = join(FIXTURES_DIR, 'valid-mcp-server.mjs')
const ADV_SERVER = join(FIXTURES_DIR, 'adversarial-mcp-server.mjs')

const AUTH: McpAuthContext = {
  host: {
    actorId: 'user-1',
    userId: 'user-1',
    botId: 'bot-1',
    workspaceId: 'ws-1',
    allowUserWideRead: true,
    allowUserWideWrite: true,
  },
  permissions: {
    canReadConfig: true,
    canManageConfig: true,
    canLaunch: true,
    canDiscover: true,
    allowedTools: ['echo_literal', 'fail_tool'],
    allowedResources: ['synthetic://docs/readme', 'synthetic://docs/binary'],
    allowedPrompts: ['review_note'],
  },
}

test('capability discovery, repeated cursor detection, schema validation, tool errors, resources, and prompts', async () => {
  const handle = await openMcpDatabase(':memory:')
  const registry = new SqliteMcpRegistry(handle, {
    clock: () => new Date('2026-11-26T03:00:00.000Z'),
  })
  const manager = new McpConnectionManager({ registry, gracefulShutdownMs: 200 })

  try {
    const srv = registry.register(AUTH, {
      id: 'srv-main',
      scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
      displayName: 'Main Fixture',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: [VALID_SERVER],
        cwd: FIXTURES_DIR,
      },
    })
    registry.approveTrust(AUTH, srv.id)
    registry.enable(AUTH, srv.id)

    await manager.connect(AUTH, srv.id)
    const snapshot = await manager.discover(AUTH, srv.id)

    assert.equal(snapshot.tools[0]?.capabilityKey, `${srv.id}::${snapshot.tools[0]?.name}`)
    assert.ok(snapshot.resources.some((r) => r.uri === 'synthetic://docs/readme'))
    assert.ok(snapshot.prompts.some((p) => p.name === 'review_note'))

    // Invalid tool arguments rejected by @cfworker/json-schema before dispatch
    await assert.rejects(
      () => manager.invokeTool(AUTH, srv.id, { toolName: 'echo_literal', args: { text: '' } }),
      McpValidationError,
    )

    // Unknown tool rejected
    await assert.rejects(
      () => manager.invokeTool(AUTH, srv.id, { toolName: 'missing_tool', args: {} }),
      McpAuthorizationError,
    )

    // Tool-level error preserves isToolError = true
    const failRes = await manager.invokeTool(AUTH, srv.id, {
      toolName: 'fail_tool',
      args: { reason: 'bad input' },
    })
    assert.equal(failRes.isToolError, true)
    assert.equal(failRes.authority, 'none')

    // Resource reading & binary rejection
    const resRead = await manager.readResource(AUTH, srv.id, { uri: 'synthetic://docs/readme' })
    assert.equal(resRead.kind, 'untrusted_mcp_resource_data')
    assert.equal(resRead.authority, 'none')
    assert.ok(resRead.contents[0]!.text.includes('Synthetic MCP resource content'))

    await assert.rejects(
      () => manager.readResource(AUTH, srv.id, { uri: 'synthetic://docs/binary' }),
      McpValidationError,
    )

    // Prompt retrieval returns untrusted reference data
    const promptRes = await manager.getPrompt(AUTH, srv.id, {
      name: 'review_note',
      arguments: { topic: 'auth' },
    })
    assert.equal(promptRes.kind, 'untrusted_mcp_prompt_data')
    assert.equal(promptRes.authority, 'none')
    assert.equal(promptRes.messages[0]?.reportedRole, 'assistant')

    // Trust revocation immediately blocks invocation on existing connection
    registry.revokeTrust(AUTH, srv.id)
    await assert.rejects(
      () => manager.invokeTool(AUTH, srv.id, { toolName: 'echo_literal', args: { text: 'after revoke' } }),
      McpTrustError,
    )

    // Repeated cursor detection
    const loopSrv = registry.register(AUTH, {
      id: 'srv-loop',
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Loop Cursor',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: [ADV_SERVER, 'repeated_cursor'],
        cwd: FIXTURES_DIR,
      },
    })
    registry.approveTrust(AUTH, loopSrv.id)
    registry.enable(AUTH, loopSrv.id)
    await manager.connect(AUTH, loopSrv.id)
    await assert.rejects(() => manager.discover(AUTH, loopSrv.id), McpProtocolError)

    // Unknown server lookup
    await assert.rejects(() => manager.connect(AUTH, 'non-existent'), McpNotFoundError)
  } finally {
    await manager.close()
    registry.close()
  }
})
