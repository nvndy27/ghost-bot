import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizeMcpDiscovery,
  authorizeMcpLaunch,
  authorizeMcpPromptGet,
  authorizeMcpResourceRead,
  authorizeMcpToolInvocation,
  McpAuthorizationError,
  McpNotFoundError,
  openMcpDatabase,
  SqliteMcpRegistry,
  validateMcpAuthContext,
  type McpAuthContext,
} from '../../src/index.ts'

test('enforces deny-by-default permissions and cross-user/cross-bot/cross-workspace isolation', async () => {
  const handle = await openMcpDatabase(':memory:')
  const registry = new SqliteMcpRegistry(handle, {
    clock: () => new Date('2026-11-26T00:00:00.000Z'),
  })

  const ownerAuth: McpAuthContext = {
    host: {
      actorId: 'user-1',
      userId: 'user-1',
      botId: 'bot-1',
      workspaceId: 'ws-1',
      allowUserWideRead: true,
      allowUserWideWrite: false,
    },
    permissions: {
      canReadConfig: true,
      canManageConfig: true,
      canLaunch: true,
      canDiscover: true,
      allowedTools: ['srv-1::echo_literal'],
      allowedResources: ['synthetic://docs/readme'],
      allowedPrompts: ['srv-1::review_note'],
    },
  }

  const discoveryOnlyAuth: McpAuthContext = {
    host: ownerAuth.host,
    permissions: {
      canReadConfig: true,
      canManageConfig: false,
      canLaunch: true,
      canDiscover: true,
      allowedTools: [],
      allowedResources: [],
      allowedPrompts: [],
    },
  }

  const otherUserAuth: McpAuthContext = {
    host: {
      actorId: 'user-2',
      userId: 'user-2',
      botId: 'bot-1',
      workspaceId: 'ws-1',
      allowUserWideRead: true,
      allowUserWideWrite: true,
    },
    permissions: ownerAuth.permissions,
  }

  const otherBotAuth: McpAuthContext = {
    host: {
      actorId: 'user-1',
      userId: 'user-1',
      botId: 'bot-2',
      workspaceId: 'ws-2',
      allowUserWideRead: false,
      allowUserWideWrite: false,
    },
    permissions: ownerAuth.permissions,
  }

  try {
    const server = registry.register(ownerAuth, {
      id: 'srv-1',
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Bot 1 MCP',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: ['/tmp/fixture.mjs'],
        cwd: '/tmp',
      },
    })

    // User-wide read does not grant user-wide write
    assert.throws(
      () =>
        registry.register(ownerAuth, {
          scope: { kind: 'user', userId: 'user-1' },
          displayName: 'User Wide MCP',
          transport: { type: 'stdio', executablePath: process.execPath, cwd: '/tmp' },
        }),
      McpAuthorizationError,
    )

    // Cross-user and cross-bot isolation
    for (const unauth of [otherUserAuth, otherBotAuth]) {
      assert.equal(registry.getById(unauth, server.id), null)
      assert.equal(registry.list(unauth).total, 0)
      assert.throws(() => registry.update(unauth, server.id, { displayName: 'Hijack' }), McpNotFoundError)
      assert.throws(() => registry.enable(unauth, server.id), McpNotFoundError)
      assert.throws(() => registry.approveTrust(unauth, server.id), McpNotFoundError)
      assert.throws(() => registry.delete(unauth, server.id), McpNotFoundError)
    }

    // Discovery permission does not grant tool/resource/prompt execution
    const parsedDiscOnly = validateMcpAuthContext(discoveryOnlyAuth)
    authorizeMcpLaunch(parsedDiscOnly, server.scope)
    authorizeMcpDiscovery(parsedDiscOnly, server.scope)
    assert.throws(
      () => authorizeMcpToolInvocation(parsedDiscOnly, server.scope, 'srv-1::echo_literal', 'echo_literal'),
      McpAuthorizationError,
    )
    assert.throws(
      () => authorizeMcpResourceRead(parsedDiscOnly, server.scope, 'synthetic://docs/readme'),
      McpAuthorizationError,
    )
    assert.throws(
      () => authorizeMcpPromptGet(parsedDiscOnly, server.scope, 'srv-1::review_note', 'review_note'),
      McpAuthorizationError,
    )
  } finally {
    registry.close()
  }
})
