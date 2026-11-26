import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { MIGRATIONS, runMigrations } from '../apps/daemon/src/db/migrations.ts'

const AUTH_TOKEN = 'test-daemon-token-phase-3d3-0123456789'
const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE_SERVER_PATH = resolve(TEST_DIR, 'fixtures/mcp-test-server.mjs')

async function daemonFetch(baseUrl: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  return { status: res.status, json }
}

async function waitForRunStatus(
  baseUrl: string,
  runId: string,
  targetStatuses: string[],
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let lastRun: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    const { status, json } = await daemonFetch(baseUrl, `/runs/${encodeURIComponent(runId)}`)
    assert.equal(status, 200)
    lastRun = json
    if (targetStatuses.includes(String(json.status))) {
      return json
    }
    if (!targetStatuses.includes('failed') && json.status === 'failed') {
      throw new Error(`Run ${runId} failed unexpectedly: ${JSON.stringify(json.error)}`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for run ${runId} to reach ${targetStatuses.join('|')} (last: ${JSON.stringify(lastRun)})`)
}

test('Phase 3D.3 migration 0007 upgrades populated v6 DB, preserves Memory/Knowledge/Core rows, and enforces foreign keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-3d3-mig-'))
  try {
    const dbPath = join(dir, 'ghost-bot.sqlite')
    const v6Sqlite = new DatabaseSync(dbPath)
    v6Sqlite.exec('PRAGMA foreign_keys = ON;')
    v6Sqlite.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);',
    )
    for (const mig of MIGRATIONS.filter((m) => m.version <= 6)) {
      v6Sqlite.exec(mig.sql)
      v6Sqlite
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(mig.version, mig.name, '2026-11-26T00:00:00.000Z')
    }
    v6Sqlite
      .prepare(
        `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_profile_id, model_id, effort, workspace_path, permission_mode, archived_at, created_at, updated_at)
         VALUES ('bot1', 'Test Bot', '', '', '{}', 'mock', NULL, 'gpt-6.2-mock', 'medium', ?, 'ask-approval', NULL, '2026-11-26T00:00:00.000Z', '2026-11-26T00:00:00.000Z')`,
      )
      .run(dir)
    v6Sqlite.close()

    const handle = await openGhostBotDatabase(dir)
    try {
      const applied = runMigrations(handle.sqlite)
      assert.equal(applied, 0)
      const versions = handle.sqlite
        .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
        .all() as Array<{ version: number }>
      assert.deepEqual(
        versions.map((v) => v.version),
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
      )

      const botRow = handle.sqlite.prepare("SELECT id FROM agents WHERE id = 'bot1'").get() as { id: string }
      assert.equal(botRow.id, 'bot1')

      // Foreign key RESTRICT on approvals(id) / mcp_servers(id) -> mcp_approval_bindings
      assert.throws(() => {
        handle.sqlite
          .prepare(
            `INSERT INTO mcp_approval_bindings (
               approval_id, server_id, config_fingerprint, trusted_binary_digest,
               connection_generation, capability_key, definition_hash, tool_name,
               args_hash, dispatch_state, created_at, updated_at
             ) VALUES ('missing_app', 'srv1', 'cf', NULL, 1, 'srv1::t1', 'h', 't1', 'ah', 'pending', '2026-11-26T00:00:00.000Z', '2026-11-26T00:00:00.000Z')`,
          )
          .run()
      })
    } finally {
      handle.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('Phase 3D.3 MCP trust, digest pinning, secret fail-closed, discovery, resource/prompt access, and settings disablement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-3d3-srv-'))
  const copiedServer = join(dir, 'fixture-mcp.mjs')
  await copyFile(FIXTURE_SERVER_PATH, copiedServer)

  const daemon = new GhostBotDaemon({
    authToken: AUTH_TOKEN,
    port: 0,
    dataDir: dir,
    runtimeMode: 'mock',
    mcpGracefulShutdownMs: 200,
  })

  try {
    const { address } = await daemon.start()

    // Register fixture server scoped to chief
    const reg = await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'fixture-srv',
        scope: { kind: 'bot', botId: 'chief' },
        displayName: 'Fixture STDIO Server',
        transport: {
          type: 'stdio',
          executablePath: process.execPath,
          args: [copiedServer],
          cwd: dir,
          envAllowlist: [],
          secretRefs: [],
        },
      }),
    })
    assert.equal(reg.status, 201)
    assert.equal(reg.json.trustState, 'untrusted')
    assert.equal(reg.json.enabled, false)

    // Untrusted connect fails closed
    const untrustedConn = await daemonFetch(address, '/mcp/servers/fixture-srv/connect', { method: 'POST' })
    assert.equal(untrustedConn.status, 403)

    // Approve trust -> pins binary digest
    const trusted = await daemonFetch(address, '/mcp/servers/fixture-srv/trust', { method: 'POST' })
    assert.equal(trusted.status, 200)
    assert.equal(trusted.json.trustState, 'trusted')
    assert.ok(typeof trusted.json.trustedBinaryDigest === 'string' && trusted.json.trustedBinaryDigest.length === 64)

    // Enable & Connect -> discovers tools, resources, prompts
    const enabled = await daemonFetch(address, '/mcp/servers/fixture-srv/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.json.enabled, true)

    const conn = await daemonFetch(address, '/mcp/servers/fixture-srv/connect', { method: 'POST' })
    assert.equal(conn.status, 200)
    assert.equal(conn.json.state, 'ready')
    assert.equal(conn.json.hasCapabilities, true)

    const caps = await daemonFetch(address, '/mcp/servers/fixture-srv/capabilities')
    assert.equal(caps.status, 200)
    assert.equal((caps.json.tools as unknown[]).length, 3)
    assert.equal((caps.json.resources as unknown[]).length, 1)
    assert.equal((caps.json.prompts as unknown[]).length, 1)

    // Read resource & get prompt
    const resRead = await daemonFetch(address, '/mcp/resources/read', {
      method: 'POST',
      body: JSON.stringify({ serverId: 'fixture-srv', uri: 'ghost://fixture/info' }),
    })
    assert.equal(resRead.status, 200)
    assert.equal((resRead.json.contents as Array<{ text: string }>)[0]?.text, 'fixture-resource-content-v1')

    const promptGet = await daemonFetch(address, '/mcp/prompts/get', {
      method: 'POST',
      body: JSON.stringify({ serverId: 'fixture-srv', name: 'greeting', args: { target: 'Ghost' } }),
    })
    assert.equal(promptGet.status, 200)
    assert.equal(
      (promptGet.json.messages as Array<{ content: { text: string } }>)[0]?.content.text,
      'Hello, Ghost!',
    )

    // Disable MCP globally -> blocks connect/read/prompt
    await daemonFetch(address, '/settings', {
      method: 'PATCH',
      body: JSON.stringify({ mcp: { enabled: false } }),
    })
    const blockedRead = await daemonFetch(address, '/mcp/resources/read', {
      method: 'POST',
      body: JSON.stringify({ serverId: 'fixture-srv', uri: 'ghost://fixture/info' }),
    })
    assert.equal(blockedRead.status, 403)
    await daemonFetch(address, '/settings', {
      method: 'PATCH',
      body: JSON.stringify({ mcp: { enabled: true } }),
    })

    // Disconnect, mutate script on disk -> digest mismatch blocks connect
    await daemonFetch(address, '/mcp/servers/fixture-srv/disconnect', { method: 'POST' })
    await writeFile(copiedServer, '// tampered script\nprocess.exit(1)\n', 'utf8')
    const tamperedConn = await daemonFetch(address, '/mcp/servers/fixture-srv/connect', { method: 'POST' })
    assert.equal(tamperedConn.status, 403)

    // Secret refs fail closed without OS secret store
    const secretSrv = await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'secret-srv',
        scope: { kind: 'user' },
        displayName: 'Secret Ref Server',
        transport: {
          type: 'stdio',
          executablePath: process.execPath,
          args: [FIXTURE_SERVER_PATH],
          cwd: dirname(FIXTURE_SERVER_PATH),
          envAllowlist: [],
          secretRefs: [{ envVar: 'TEST_SECRET', refId: 'secret-1' }],
        },
      }),
    })
    assert.equal(secretSrv.status, 201)
    await daemonFetch(address, '/mcp/servers/secret-srv/trust', { method: 'POST' })
    await daemonFetch(address, '/mcp/servers/secret-srv/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
    const secretConn = await daemonFetch(address, '/mcp/servers/secret-srv/connect', { method: 'POST' })
    assert.equal(secretConn.status, 400, `Expected 400 MCP_SECRET_UNAVAILABLE, got ${secretConn.status}: ${JSON.stringify(secretConn.json)}`)
  } finally {
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Phase 3D.3 RunOrchestrator durable MCP tool approval, single-use, deny, policy modes, timeout uncertain, and bot deletion teardown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-3d3-run-'))
  const daemon = new GhostBotDaemon({
    authToken: AUTH_TOKEN,
    port: 0,
    dataDir: dir,
    runtimeMode: 'mock',
    mcpGracefulShutdownMs: 200,
    mcpSecretResolver: () => ({ TEST_SECRET: 'injected-secret-ok' }),
  })

  try {
    const { address } = await daemon.start()

    // Register & trust fixture server for chief (ask-approval)
    await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'run-srv',
        scope: { kind: 'bot', botId: 'chief' },
        displayName: 'Run Fixture Server',
        transport: {
          type: 'stdio',
          executablePath: process.execPath,
          args: [FIXTURE_SERVER_PATH],
          cwd: dirname(FIXTURE_SERVER_PATH),
          envAllowlist: [],
          secretRefs: [{ envVar: 'TEST_SECRET', refId: 's1' }],
        },
        requestTimeoutMs: 600,
      }),
    })
    await daemonFetch(address, '/mcp/servers/run-srv/trust', { method: 'POST' })
    await daemonFetch(address, '/mcp/servers/run-srv/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })

    // Create session for chief
    const sessRes = await daemonFetch(address, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'chief', title: 'MCP Run Session' }),
    })
    assert.equal(sessRes.status, 201)
    const sessionId = String(sessRes.json.id)

    // 1. Approve flow executes real STDIO MCP tool and completes
    const start1 = await daemonFetch(address, '/runs', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        idempotencyKey: 'mcp-run-1',
        text: 'mcp-tool:run-srv/echo_tool {"text":"hello_mcp"}',
      }),
    })
    assert.equal(start1.status, 201)
    const run1Id = String((start1.json.run as Record<string, unknown>).id)
    const awaiting1 = await waitForRunStatus(address, run1Id, ['awaiting_approval'])
    const approval1 = awaiting1.pendingApproval as Record<string, unknown>
    assert.equal(approval1.actionType, 'mcp.toolCall')

    // Wrong argsHash is rejected
    const badHash = await daemonFetch(address, `/runs/${run1Id}/approval`, {
      method: 'POST',
      body: JSON.stringify({
        approvalId: approval1.approvalId,
        decision: 'approved',
        argsHash: '0'.repeat(64),
      }),
    })
    assert.equal(badHash.status, 409)

    // Valid approval executes tool
    const okApprove = await daemonFetch(address, `/runs/${run1Id}/approval`, {
      method: 'POST',
      body: JSON.stringify({
        approvalId: approval1.approvalId,
        decision: 'approved',
        argsHash: approval1.argsHash,
      }),
    })
    assert.equal(okApprove.status, 200)
    const done1 = await waitForRunStatus(address, run1Id, ['completed'])
    assert.equal(done1.status, 'completed')

    // Reusing the same approval fails closed
    const replay = await daemonFetch(address, `/runs/${run1Id}/approval`, {
      method: 'POST',
      body: JSON.stringify({
        approvalId: approval1.approvalId,
        decision: 'approved',
      }),
    })
    assert.equal(replay.status, 409)

    // Verify assistant message contains real MCP tool output & injected secret worked
    const msgs1 = await daemonFetch(address, `/sessions/${sessionId}/messages`)
    const lastMsg = (msgs1.json.messages as Array<Record<string, unknown>>).at(-1)
    assert.ok(JSON.stringify(lastMsg).includes('echo:hello_mcp [secret:injected-secret-ok]'))

    // 2. Deny flow cancels run without executing tool
    const start2 = await daemonFetch(address, '/runs', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        idempotencyKey: 'mcp-run-2',
        text: 'mcp-tool:run-srv/echo_tool {"text":"should_not_run"}',
      }),
    })
    const run2Id = String((start2.json.run as Record<string, unknown>).id)
    const awaiting2 = await waitForRunStatus(address, run2Id, ['awaiting_approval'])
    const approval2 = awaiting2.pendingApproval as Record<string, unknown>

    const denyRes = await daemonFetch(address, `/runs/${run2Id}/approval`, {
      method: 'POST',
      body: JSON.stringify({ approvalId: approval2.approvalId, decision: 'denied' }),
    })
    assert.equal(denyRes.status, 200)
    const done2 = await waitForRunStatus(address, run2Id, ['cancelled'])
    assert.equal(done2.status, 'cancelled')

    // 3. Timeout during slow_tool marks dispatch_state = 'uncertain' and fails run
    const start3 = await daemonFetch(address, '/runs', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        idempotencyKey: 'mcp-run-3',
        text: 'mcp-tool:run-srv/slow_tool {"delayMs":1200}',
      }),
    })
    const run3Id = String((start3.json.run as Record<string, unknown>).id)
    const awaiting3 = await waitForRunStatus(address, run3Id, ['awaiting_approval'])
    const approval3 = awaiting3.pendingApproval as Record<string, unknown>

    const timeoutApprove = await daemonFetch(address, `/runs/${run3Id}/approval`, {
      method: 'POST',
      body: JSON.stringify({ approvalId: approval3.approvalId, decision: 'approved' }),
    })
    assert.equal(timeoutApprove.status, 200)
    const done3 = await waitForRunStatus(address, run3Id, ['failed'])
    assert.equal(done3.status, 'failed')

    // 4. Read-only and full-access bots are blocked from MCP tool execution
    const roBot = await daemonFetch(address, '/bots', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Read Only MCP Bot',
        description: '',
        instructions: '',
        avatar: {
          kind: 'preset',
          shape: 'security',
          color: '#536B85',
          eyes: 'classic',
          rotation: 0,
          animation: false,
        },
        runtimeId: 'mock-offline',
        modelId: 'gpt-6.2-mock',
        effort: 'medium',
        workspacePath: dir,
        permission: 'read-only',
      }),
    })
    assert.equal(roBot.status, 201)
    const roBotId = String(roBot.json.id)
    await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'ro-srv',
        scope: { kind: 'bot', botId: roBotId },
        displayName: 'RO Bot Server',
        transport: {
          type: 'stdio',
          executablePath: process.execPath,
          args: [FIXTURE_SERVER_PATH],
          cwd: dirname(FIXTURE_SERVER_PATH),
          envAllowlist: [],
          secretRefs: [],
        },
      }),
    })
    await daemonFetch(address, '/mcp/servers/ro-srv/trust', { method: 'POST' })
    await daemonFetch(address, '/mcp/servers/ro-srv/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
    const roSess = await daemonFetch(address, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ agentId: roBotId, title: 'RO Session' }),
    })
    const roRun = await daemonFetch(address, '/runs', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: roSess.json.id,
        idempotencyKey: 'ro-mcp-run',
        text: 'mcp-tool:ro-srv/echo_tool {"text":"blocked"}',
      }),
    })
    const roFailed = await waitForRunStatus(address, String((roRun.json.run as Record<string, unknown>).id), ['failed'])
    assert.equal(roFailed.status, 'failed')

    // 5. Bot deletion removes bot-scoped MCP server & tears down connections
    const delBot = await daemonFetch(address, `/bots/${roBotId}`, { method: 'DELETE' })
    assert.equal(delBot.status, 200)
    const listAfter = await daemonFetch(address, '/mcp/servers')
    assert.equal(
      (listAfter.json.servers as Array<{ id: string }>).some((s) => s.id === 'ro-srv'),
      false,
    )
  } finally {
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Phase 3D.3 daemon /health responsiveness p95 stays under 50ms during active MCP tool execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-3d3-perf-'))
  const daemon = new GhostBotDaemon({
    authToken: AUTH_TOKEN,
    port: 0,
    dataDir: dir,
    runtimeMode: 'mock',
    mcpGracefulShutdownMs: 200,
  })

  try {
    const { address } = await daemon.start()
    await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'perf-srv',
        scope: { kind: 'bot', botId: 'chief' },
        displayName: 'Perf Fixture Server',
        transport: {
          type: 'stdio',
          executablePath: process.execPath,
          args: [FIXTURE_SERVER_PATH],
          cwd: dirname(FIXTURE_SERVER_PATH),
          envAllowlist: [],
          secretRefs: [],
        },
        requestTimeoutMs: 5000,
      }),
    })
    await daemonFetch(address, '/mcp/servers/perf-srv/trust', { method: 'POST' })
    await daemonFetch(address, '/mcp/servers/perf-srv/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })

    const sessRes = await daemonFetch(address, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'chief', title: 'Perf Session' }),
    })
    const runRes = await daemonFetch(address, '/runs', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: sessRes.json.id,
        idempotencyKey: 'perf-mcp-run',
        text: 'mcp-tool:perf-srv/slow_tool {"delayMs":400}',
      }),
    })
    const runId = String((runRes.json.run as Record<string, unknown>).id)
    const awaiting = await waitForRunStatus(address, runId, ['awaiting_approval'])
    const approval = awaiting.pendingApproval as Record<string, unknown>

    const perfApprove = await daemonFetch(address, `/runs/${runId}/approval`, {
      method: 'POST',
      body: JSON.stringify({ approvalId: approval.approvalId, decision: 'approved' }),
    })
    assert.equal(perfApprove.status, 200)

    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      const h = await daemonFetch(address, '/health')
      const dt = performance.now() - t0
      assert.equal(h.status, 200)
      samples.push(dt)
      await new Promise((r) => setTimeout(r, 15))
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0
    assert.ok(p95 < 50, `Expected /health p95 < 50ms during MCP execution, got ${p95.toFixed(2)}ms`)
    await waitForRunStatus(address, runId, ['completed'])
  } finally {
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
