import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeServerConfigFingerprint,
  McpCredentialError,
  McpStdioTransportSchema,
  McpTrustError,
  openMcpDatabase,
  RegisterMcpServerInputSchema,
  SqliteMcpRegistry,
  type McpAuthContext,
} from '../../src/index.ts'
import { assertServerTrustedForLaunch } from '../../src/security/trust.ts'

const ADMIN_AUTH: McpAuthContext = {
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
  },
}

test('contracts reject unexpected fields, remote transports, bad env names, and credentials', async () => {
  const extra = RegisterMcpServerInputSchema.safeParse({
    scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
    displayName: 'Test Server',
    transport: {
      type: 'stdio',
      executablePath: '/usr/bin/node',
      cwd: '/tmp',
    },
    unexpectedField: true,
  })
  assert.equal(extra.success, false)

  const remote = McpStdioTransportSchema.safeParse({
    type: 'streamable_http',
    url: 'https://example.com/mcp',
  })
  assert.equal(remote.success, false)

  const badEnv = McpStdioTransportSchema.safeParse({
    type: 'stdio',
    executablePath: '/usr/bin/node',
    cwd: '/tmp',
    envAllowlist: ['bad-lower-case'],
  })
  assert.equal(badEnv.success, false)

  const handle = await openMcpDatabase(':memory:')
  const registry = new SqliteMcpRegistry(handle)
  try {
    assert.throws(
      () =>
        registry.register(ADMIN_AUTH, {
          scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
          displayName: 'Secret Arg Server',
          transport: {
            type: 'stdio',
            executablePath: '/usr/bin/node',
            args: ['--token=sk-proj-1234567890abcdef1234'],
            cwd: '/tmp',
          },
        }),
      McpCredentialError,
    )
    assert.throws(
      () =>
        registry.register(ADMIN_AUTH, {
          scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
          displayName: 'Protected Env Server',
          transport: {
            type: 'stdio',
            executablePath: '/usr/bin/node',
            cwd: '/tmp',
            envAllowlist: ['OPENAI_API_KEY'],
          },
        }),
      McpCredentialError,
    )
  } finally {
    registry.close()
  }
})

test('trust invalidation clears trust and disables server when security-relevant config changes', async () => {
  const handle = await openMcpDatabase(':memory:')
  const registry = new SqliteMcpRegistry(handle, {
    clock: () => new Date('2026-11-26T00:00:00.000Z'),
  })

  try {
    const server = registry.register(ADMIN_AUTH, {
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Fixture Server',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: ['/tmp/fixture-a.mjs'],
        cwd: '/tmp',
      },
    })
    assert.equal(server.enabled, false)
    assert.equal(server.trustState, 'untrusted')
    assert.throws(() => assertServerTrustedForLaunch(server), McpTrustError)

    const trusted = registry.approveTrust(ADMIN_AUTH, server.id)
    const enabled = registry.enable(ADMIN_AUTH, trusted.id)
    assertServerTrustedForLaunch(enabled)

    // Changing args invalidates trust and disables server
    const modified = registry.update(ADMIN_AUTH, enabled.id, {
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: ['/tmp/fixture-b.mjs'],
        cwd: '/tmp',
      },
    })
    assert.equal(modified.enabled, false)
    assert.equal(modified.trustState, 'untrusted')
    assert.equal(modified.trustedFingerprint, null)
    assert.notEqual(
      modified.configFingerprint,
      computeServerConfigFingerprint(server.scope, server.transport),
    )
    assert.throws(() => assertServerTrustedForLaunch(modified), McpTrustError)
  } finally {
    registry.close()
  }
})
