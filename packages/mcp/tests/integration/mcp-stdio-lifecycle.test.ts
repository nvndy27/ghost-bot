import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  McpCancelledError,
  McpConnectionManager,
  McpTimeoutError,
  McpTransportError,
  McpTrustError,
  McpUnsafePathError,
  openMcpDatabase,
  SqliteMcpRegistry,
  validateStdioLaunchPaths,
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
    allowedTools: ['echo_literal', 'slow_tool', 'poison_tool'],
  },
}

test('real STDIO lifecycle: connect, ping, minimal env, shell metacharacters, concurrent connect, timeout, cancel, and SIGKILL cleanup', async () => {
  const handle = await openMcpDatabase(':memory:')
  const registry = new SqliteMcpRegistry(handle, {
    clock: () => new Date('2026-11-26T02:00:00.000Z'),
  })
  const manager = new McpConnectionManager({
    registry,
    hostEnv: {
      OPENAI_API_KEY: 'sk-should-never-leak-1234567890',
      GHOST_MCP_SAFE_VAR: 'allowed-value',
    },
    gracefulShutdownMs: 200,
  })

  try {
    // Disallowed package runners & shells rejected
    await assert.rejects(() => validateStdioLaunchPaths('/usr/bin/npx', FIXTURES_DIR), McpUnsafePathError)
    await assert.rejects(() => validateStdioLaunchPaths('/bin/sh', FIXTURES_DIR), McpUnsafePathError)

    const validSrv = registry.register(AUTH, {
      id: 'srv-valid',
      scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
      displayName: 'Valid Fixture',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: [VALID_SERVER, '; echo shell-injection-test', '$(whoami)'],
        cwd: FIXTURES_DIR,
        envAllowlist: ['GHOST_MCP_SAFE_VAR'],
      },
      connectTimeoutMs: 3000,
      requestTimeoutMs: 500,
    })

    // Disabled / untrusted server cannot connect
    await assert.rejects(() => manager.connect(AUTH, validSrv.id), McpTrustError)

    registry.approveTrust(AUTH, validSrv.id)
    registry.enable(AUTH, validSrv.id)

    const conn = await manager.connect(AUTH, validSrv.id)
    assert.equal(conn.state, 'ready')
    assert.equal(conn.generation, 1)
    assert.ok(conn.pid !== null)

    await manager.ping(AUTH, validSrv.id)
    const caps = await manager.discover(AUTH, validSrv.id)
    assert.ok(caps.tools.some((t) => t.name === 'echo_literal'))

    // Verify shell metacharacters passed literally and OPENAI_API_KEY was NOT inherited
    const echoRes = await manager.invokeTool(AUTH, validSrv.id, {
      toolName: 'echo_literal',
      args: { text: 'hello && rm -rf /' },
    })
    const parsedEcho = JSON.parse(echoRes.content[0]!.text!)
    assert.equal(parsedEcho.echoed, 'hello && rm -rf /')
    assert.deepEqual(parsedEcho.argv, ['; echo shell-injection-test', '$(whoami)'])
    assert.equal(parsedEcho.safeCustom, 'allowed-value')
    assert.equal(parsedEcho.secretVarPresent, false)

    // Timeout marks uncertainOutcome = true
    await assert.rejects(
      () => manager.invokeTool(AUTH, validSrv.id, { toolName: 'slow_tool', args: { delayMs: 1500 } }),
      (err: unknown) => err instanceof McpTimeoutError && err.uncertainOutcome === true,
    )

    // Cancellation via AbortController marks uncertainOutcome = true
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    await assert.rejects(
      () =>
        manager.invokeTool(AUTH, validSrv.id, {
          toolName: 'slow_tool',
          args: { delayMs: 1500 },
          signal: ac.signal,
        }),
      (err: unknown) => err instanceof McpCancelledError && err.uncertainOutcome === true,
    )

    await manager.disconnect(validSrv.id)
    assert.equal(manager.getConnectionInfo(validSrv.id), null)

    // Init failure transitions to failed
    const initFailSrv = registry.register(AUTH, {
      id: 'srv-init-fail',
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Init Fail',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: [ADV_SERVER, 'init_fail'],
        cwd: FIXTURES_DIR,
      },
    })
    registry.approveTrust(AUTH, initFailSrv.id)
    registry.enable(AUTH, initFailSrv.id)
    await assert.rejects(() => manager.connect(AUTH, initFailSrv.id), McpTransportError)
    assert.equal(manager.getConnectionInfo(initFailSrv.id)?.state, 'failed')

    // Unresponsive SIGTERM escalates cleanly to SIGKILL
    const hangSrv = registry.register(AUTH, {
      id: 'srv-hang',
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Hang SIGTERM',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: [ADV_SERVER, 'hang_sigterm'],
        cwd: FIXTURES_DIR,
      },
    })
    registry.approveTrust(AUTH, hangSrv.id)
    registry.enable(AUTH, hangSrv.id)
    await manager.connect(AUTH, hangSrv.id)
    await manager.disconnect(hangSrv.id)
    assert.equal(manager.getConnectionInfo(hangSrv.id), null)
  } finally {
    await manager.close()
    registry.close()
  }
})
