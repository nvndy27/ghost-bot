import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  McpAuthorizationError,
  McpConnectionManager,
  McpCredentialError,
  McpNotFoundError,
  McpStorageCorruptionError,
  McpTrustError,
  openMcpDatabase,
  SqliteMcpRegistry,
  type McpAuthContext,
} from '../../src/index.ts'
import { BoundedStdioClientTransport } from '../../src/transport/bounded-stdio.ts'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const VALID_SERVER = join(FIXTURES_DIR, 'valid-mcp-server.mjs')

const BASE_HOST = {
  actorId: 'user-1',
  userId: 'user-1',
  botId: 'bot-1',
  workspaceId: 'ws-1',
  allowUserWideRead: true,
  allowUserWideWrite: true,
}

const ADMIN_AUTH: McpAuthContext = {
  host: BASE_HOST,
  permissions: {
    canReadConfig: true,
    canManageConfig: true,
    canLaunch: true,
    canDiscover: true,
    allowedTools: ['echo_literal'],
  },
}

test('blocks loader/interpreter injection env vars and detects script replacement at same path', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ghost-bot-mcp-hard-'))
  const scriptPath = join(rootDir, 'local-server.mjs')
  writeFileSync(
    scriptPath,
    [
      "import { createInterface } from 'node:readline';",
      'const rl = createInterface({ input: process.stdin });',
      "rl.on('line', (line) => {",
      '  const msg = JSON.parse(line);',
      "  if (msg.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'pin', version: '1.0.0' } } }) + '\\n');",
      '  }',
      '});',
    ].join('\n'),
  )

  const handle = await openMcpDatabase(':memory:')
  const registry = new SqliteMcpRegistry(handle, {
    clock: () => new Date('2026-11-26T05:00:00.000Z'),
  })
  const manager = new McpConnectionManager({ registry, gracefulShutdownMs: 200 })

  try {
    for (const dangerousVar of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'PYTHONPATH',
      'PYTHONHOME',
      'BASH_ENV',
      'ENV',
      'PATH',
      'HOME',
    ]) {
      assert.throws(
        () =>
          registry.register(ADMIN_AUTH, {
            scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
            displayName: `Bad Env ${dangerousVar}`,
            transport: {
              type: 'stdio',
              executablePath: process.execPath,
              args: [scriptPath],
              cwd: rootDir,
              envAllowlist: [dangerousVar],
            },
          }),
        McpCredentialError,
      )
    }

    const srv = registry.register(ADMIN_AUTH, {
      id: 'srv-pin',
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Pinned Script Server',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: [scriptPath],
        cwd: rootDir,
      },
    })
    const trusted = registry.approveTrust(ADMIN_AUTH, srv.id)
    assert.ok(trusted.trustedBinaryDigest)
    registry.enable(ADMIN_AUTH, srv.id)

    await manager.connect(ADMIN_AUTH, srv.id)
    await manager.disconnect(srv.id)

    // Replace script contents at the exact same path without changing config
    writeFileSync(scriptPath, '// tampered script\nprocess.exit(0);\n')
    await assert.rejects(() => manager.connect(ADMIN_AUTH, srv.id), McpTrustError)
  } finally {
    await manager.close()
    registry.close()
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('capability definitionHash binding, trust revocation while connected, and SQLite tamper detection', async () => {
  const handle = await openMcpDatabase(':memory:')
  const registry = new SqliteMcpRegistry(handle, {
    clock: () => new Date('2026-11-26T05:10:00.000Z'),
  })
  const manager = new McpConnectionManager({ registry, gracefulShutdownMs: 200 })

  try {
    const srv = registry.register(ADMIN_AUTH, {
      id: 'srv-cap',
      scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
      displayName: 'Cap Hash Server',
      transport: {
        type: 'stdio',
        executablePath: process.execPath,
        args: [VALID_SERVER],
        cwd: FIXTURES_DIR,
      },
    })
    registry.approveTrust(ADMIN_AUTH, srv.id)
    registry.enable(ADMIN_AUTH, srv.id)

    await manager.connect(ADMIN_AUTH, srv.id)
    const caps = await manager.discover(ADMIN_AUTH, srv.id)
    const echoTool = caps.tools.find((t) => t.name === 'echo_literal')!
    assert.ok(echoTool.definitionHash)

    // Matching definitionHash succeeds
    const pinnedAuth: McpAuthContext = {
      host: BASE_HOST,
      permissions: {
        ...ADMIN_AUTH.permissions,
        allowedToolHashes: { [echoTool.capabilityKey]: echoTool.definitionHash },
      },
    }
    const okRes = await manager.invokeTool(pinnedAuth, srv.id, {
      toolName: 'echo_literal',
      args: { text: 'pinned ok' },
    })
    assert.equal(okRes.isToolError, false)

    // Mismatched definitionHash fails closed
    const staleHashAuth: McpAuthContext = {
      host: BASE_HOST,
      permissions: {
        ...ADMIN_AUTH.permissions,
        allowedToolHashes: { [echoTool.capabilityKey]: '0'.repeat(64) },
      },
    }
    await assert.rejects(
      () => manager.invokeTool(staleHashAuth, srv.id, { toolName: 'echo_literal', args: { text: 'stale' } }),
      McpAuthorizationError,
    )

    // Deleting server while connected blocks subsequent invocation
    registry.delete(ADMIN_AUTH, srv.id)
    await assert.rejects(
      () => manager.invokeTool(ADMIN_AUTH, srv.id, { toolName: 'echo_literal', args: { text: 'deleted' } }),
      McpNotFoundError,
    )

    // Tampered SQLite row (config_fingerprint mismatch) throws McpStorageCorruptionError
    const srv2 = registry.register(ADMIN_AUTH, {
      id: 'srv-tamper',
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      displayName: 'Tamper Target',
      transport: { type: 'stdio', executablePath: process.execPath, cwd: FIXTURES_DIR },
    })
    handle.sqlite.prepare('UPDATE mcp_servers SET enabled = 1 WHERE id = ?').run(srv2.id)
    assert.throws(() => registry.getById(ADMIN_AUTH, srv2.id), McpStorageCorruptionError)
  } finally {
    await manager.close()
    registry.close()
  }
})

test('BoundedStdioClientTransport handles split UTF-8 chunks and multiple messages per chunk', async () => {
  const transport = new BoundedStdioClientTransport({
    executablePath: process.execPath,
    args: [
      '-e',
      [
        "const m1 = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { msg: 'Tiếng Việt 🚀' } }) + '\\n');",
        "const m2 = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } }) + '\\n');",
        'process.stdout.write(m1.subarray(0, 20));',
        'setTimeout(() => { process.stdout.write(Buffer.concat([m1.subarray(20), m2])); }, 20);',
      ].join(' '),
    ],
    cwd: FIXTURES_DIR,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  })

  const received: unknown[] = []
  transport.onmessage = (msg) => received.push(msg)

  await transport.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(received.length, 2)
    assert.equal((received[0] as { result: { msg: string } }).result.msg, 'Tiếng Việt 🚀')
    assert.equal((received[1] as { result: { ok: boolean } }).result.ok, true)
  } finally {
    await transport.close()
  }
})
