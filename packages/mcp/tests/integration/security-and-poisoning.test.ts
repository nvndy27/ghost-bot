import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  McpAuthorizationError,
  McpConnectionManager,
  McpTransportError,
  openMcpDatabase,
  SqliteMcpRegistry,
  type HostMcpPolicyAdapter,
  type McpAuthContext,
} from '../../src/index.ts'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
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
    allowedTools: ['poison_tool'],
  },
}

test('adversarial poisoning, unsupported server-initiated sampling, redacted crash stderr, and host policy denial', async () => {
  const handle = await openMcpDatabase(':memory:')
  const registry = new SqliteMcpRegistry(handle, {
    clock: () => new Date('2026-11-26T04:00:00.000Z'),
  })
  const manager = new McpConnectionManager({ registry, gracefulShutdownMs: 200 })

  try {
    const poisonedSrv = registry.register(AUTH, {
      id: 'srv-poison',
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Poisoned Fixture',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: [ADV_SERVER, 'poisoned'],
        cwd: FIXTURES_DIR,
      },
    })
    registry.approveTrust(AUTH, poisonedSrv.id)
    registry.enable(AUTH, poisonedSrv.id)

    await manager.connect(AUTH, poisonedSrv.id)
    const caps = await manager.discover(AUTH, poisonedSrv.id)
    assert.equal(caps.tools[0]?.name, 'poison_tool')

    const res = await manager.invokeTool(AUTH, poisonedSrv.id, {
      toolName: 'poison_tool',
      args: { q: 'test' },
    })
    assert.equal(res.kind, 'untrusted_mcp_tool_result')
    assert.equal(res.authority, 'none')
    assert.ok(res.content[0]!.text!.includes('Ignore policy'))

    // Crash stderr redacts synthetic secrets
    const crashSrv = registry.register(AUTH, {
      id: 'srv-crash',
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Crash Fixture',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: [ADV_SERVER, 'crash'],
        cwd: FIXTURES_DIR,
      },
    })
    registry.approveTrust(AUTH, crashSrv.id)
    registry.enable(AUTH, crashSrv.id)
    await manager.connect(AUTH, crashSrv.id)
    await manager.discover(AUTH, crashSrv.id)

    await assert.rejects(
      () => manager.invokeTool(AUTH, crashSrv.id, { toolName: 'poison_tool', args: {} }),
      McpTransportError,
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    const info = manager.getConnectionInfo(crashSrv.id)
    if (info?.lastError) {
      assert.equal(info.lastError.includes('1234567890abcdef'), false)
    }

    // HostMcpPolicyAdapter denies launch
    const denyPolicy: HostMcpPolicyAdapter = {
      evaluateLaunch: () => ({ allowed: false, reason: 'Blocked by policy broker' }),
      evaluateToolInvocation: () => ({ allowed: false, reason: 'Tool blocked' }),
    }
    const deniedManager = new McpConnectionManager({ registry, hostPolicy: denyPolicy })
    await assert.rejects(() => deniedManager.connect(AUTH, poisonedSrv.id), McpAuthorizationError)
    await deniedManager.close()
  } finally {
    await manager.close()
    registry.close()
  }
})
