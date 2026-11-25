import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  McpConnectionManager,
  McpProtocolError,
  McpValidationError,
  openMcpDatabase,
  SqliteMcpRegistry,
  type McpAuthContext,
} from '../../src/index.ts'
import { assertSafeSupportedJsonSchema } from '../../src/discovery/discoverer.ts'
import { assertBoundedInputShape } from '../../src/security/input-bounds.ts'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const VALID_SERVER = join(FIXTURES_DIR, 'valid-mcp-server.mjs')

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
    allowedTools: ['echo_literal'],
  },
}

test('conservative JSON Schema subset rejects ReDoS patterns, cyclic $ref, patternProperties, format, and excessive combinators', () => {
  const unsafeSchemas: Array<Record<string, unknown>> = [
    { type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } },
    { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
    { type: 'object', $defs: { A: { $ref: '#/$defs/A' } }, $ref: '#/$defs/A' },
    { type: 'object', properties: { email: { type: 'string', format: 'email' } } },
    {
      type: 'object',
      allOf: Array.from({ length: 12 }, () => ({ type: 'object' })),
    },
    {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 260 }, (_, i) => [`k${i}`, { type: 'string' }])),
    },
  ]

  const start = Date.now()
  for (const schema of unsafeSchemas) {
    assert.throws(() => assertSafeSupportedJsonSchema(schema), McpProtocolError)
  }
  const elapsedMs = Date.now() - start
  assert.ok(elapsedMs < 200, `Schema rejection took ${elapsedMs}ms`)
})

test('pre-validation input bounds reject oversized arrays and deep nesting before Zod parsing', async () => {
  const oversizedArray = Array.from({ length: 600 }, () => 'item')
  assert.throws(() => assertBoundedInputShape(oversizedArray), McpValidationError)

  let nested: Record<string, unknown> = { leaf: true }
  for (let i = 0; i < 25; i++) {
    nested = { child: nested }
  }
  assert.throws(() => assertBoundedInputShape(nested), McpValidationError)

  const handle = await openMcpDatabase(':memory:')
  const registry = new SqliteMcpRegistry(handle)
  try {
    assert.throws(
      () =>
        registry.register(AUTH, {
          scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
          displayName: 'Oversized Args',
          transport: {
            type: 'stdio',
            executablePath: process.execPath,
            args: oversizedArray as unknown as string[],
            cwd: FIXTURES_DIR,
          },
        }),
      McpValidationError,
    )
  } finally {
    registry.close()
  }
})

test('active trust revocation, disable, and delete immediately terminate same-host connected subprocess', async () => {
  const handle = await openMcpDatabase(':memory:')
  const registry = new SqliteMcpRegistry(handle, {
    clock: () => new Date('2026-11-26T06:00:00.000Z'),
  })
  const manager = new McpConnectionManager({ registry, gracefulShutdownMs: 200 })

  try {
    const srv = registry.register(AUTH, {
      id: 'srv-revoke-live',
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Live Revoke Target',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: [VALID_SERVER],
        cwd: FIXTURES_DIR,
      },
    })
    registry.approveTrust(AUTH, srv.id)
    registry.enable(AUTH, srv.id)

    const conn1 = await manager.connect(AUTH, srv.id)
    assert.equal(conn1.state, 'ready')
    assert.ok(conn1.pid !== null)

    // Revoking trust on same-host registry triggers immediate disconnect
    registry.revokeTrust(AUTH, srv.id)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(manager.getConnectionInfo(srv.id), null)

    // Re-trust, re-enable, reconnect, then test immediate disable
    registry.approveTrust(AUTH, srv.id)
    registry.enable(AUTH, srv.id)
    await manager.connect(AUTH, srv.id)
    registry.disable(AUTH, srv.id)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(manager.getConnectionInfo(srv.id), null)
  } finally {
    await manager.close()
    registry.close()
  }
})
