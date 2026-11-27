import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createHostMcpPolicyAdapter } from '../apps/daemon/src/runtime/policy-broker.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'

const AUTH_TOKEN = 'test-daemon-token-phase-3d3-hardening-0123'
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
  while (Date.now() < deadline) {
    const { status, json } = await daemonFetch(baseUrl, `/runs/${encodeURIComponent(runId)}`)
    assert.equal(status, 200)
    if (targetStatuses.includes(String(json.status))) {
      return json
    }
    if (!targetStatuses.includes('failed') && json.status === 'failed') {
      throw new Error(`Run ${runId} failed: ${JSON.stringify(json.error)}`)
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out waiting for run ${runId} -> ${targetStatuses.join('|')}`)
}

async function readInvocationCount(counterFile: string): Promise<number> {
  try {
    const raw = await readFile(counterFile, 'utf8')
    return raw.split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

test('Phase 3D.3 hardening: permission-mode policy adapter blocks read-only, workspace, and full-access; allows ask-approval only', () => {
  const dummyAuth = {
    host: { userId: 'local-user', actorId: 'daemon_mcp', allowUserWideRead: true, allowUserWideWrite: true },
    permissions: {
      canReadConfig: true,
      canManageConfig: true,
      canLaunch: true,
      canDiscover: true,
      allowedTools: [],
      allowedResources: [],
      allowedPrompts: [],
    },
  }
  const dummyServer = {
    schemaVersion: 1 as const,
    id: 'srv-1',
    scope: { kind: 'user' as const, userId: 'local-user' },
    displayName: 'Test',
    description: '',
    transport: {
      type: 'stdio' as const,
      executablePath: process.execPath,
      args: [FIXTURE_SERVER_PATH],
      cwd: dirname(FIXTURE_SERVER_PATH),
      envAllowlist: [],
      secretRefs: [],
    },
    enabled: true,
    trustState: 'trusted' as const,
    configFingerprint: 'a'.repeat(64),
    trustedFingerprint: 'a'.repeat(64),
    trustedBinaryDigest: 'b'.repeat(64),
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
  }

  for (const mode of ['read-only', 'workspace', 'full-access'] as const) {
    const adapter = createHostMcpPolicyAdapter(mode)
    assert.equal(adapter.evaluateLaunch(dummyAuth, dummyServer).allowed, false, `${mode} launch must be blocked`)
    assert.equal(
      adapter.evaluateToolInvocation(dummyAuth, dummyServer, 'echo_tool').allowed,
      false,
      `${mode} tool must be blocked`,
    )
  }

  const askAdapter = createHostMcpPolicyAdapter('ask-approval')
  assert.equal(askAdapter.evaluateLaunch(dummyAuth, dummyServer).allowed, true)
  assert.equal(askAdapter.evaluateToolInvocation(dummyAuth, dummyServer, 'echo_tool').allowed, true)
})

test('Phase 3D.3 hardening: adversarial auth, workspace-mode block, mid-approval revocation/disable/delete, and zero-invocation guarantees', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-3d3-hard-'))
  const counterFile = join(dir, 'invocations.log')
  const syntheticSecret = 'SYNTHETIC_SECRET_DO_NOT_LEAK_987'

  const daemon = new GhostBotDaemon({
    authToken: AUTH_TOKEN,
    port: 0,
    dataDir: dir,
    runtimeMode: 'mock',
    mcpGracefulShutdownMs: 200,
    mcpSecretResolver: () => ({ TEST_SECRET: syntheticSecret }),
  })

  try {
    const { address } = await daemon.start()

    // 1. Unknown properties rejected
    const badExtra = await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        scope: { kind: 'user' },
        displayName: 'Extra',
        transport: {
          type: 'stdio',
          executablePath: process.execPath,
          args: [FIXTURE_SERVER_PATH],
          cwd: dirname(FIXTURE_SERVER_PATH),
          envAllowlist: [],
          secretRefs: [],
        },
        unexpectedField: true,
      }),
    })
    assert.equal(badExtra.status, 400)

    // 2. Workspace-mode bot cannot connect or invoke local STDIO MCP
    const wsBot = await daemonFetch(address, '/bots', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Workspace Bot',
        description: '',
        instructions: '',
        avatar: { kind: 'preset', shape: 'security', color: '#536B85', eyes: 'classic', rotation: 0, animation: false },
        runtimeId: 'mock-offline',
        modelId: 'gpt-6.2-mock',
        effort: 'medium',
        workspacePath: dir,
        permission: 'workspace',
      }),
    })
    assert.equal(wsBot.status, 201)
    const wsBotId = String(wsBot.json.id)

    await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'ws-srv',
        scope: { kind: 'bot', botId: wsBotId },
        displayName: 'WS Blocked Server',
        transport: {
          type: 'stdio',
          executablePath: process.execPath,
          args: [FIXTURE_SERVER_PATH, '--counter', counterFile],
          cwd: dirname(FIXTURE_SERVER_PATH),
          envAllowlist: [],
          secretRefs: [],
        },
      }),
    })
    await daemonFetch(address, '/mcp/servers/ws-srv/trust', { method: 'POST' })
    await daemonFetch(address, '/mcp/servers/ws-srv/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
    const wsConnect = await daemonFetch(address, '/mcp/servers/ws-srv/connect', { method: 'POST' })
    assert.equal(wsConnect.status, 403)
    const wsRead = await daemonFetch(address, '/mcp/resources/read', {
      method: 'POST',
      body: JSON.stringify({ serverId: 'ws-srv', uri: 'ghost://fixture/info', botId: wsBotId }),
    })
    assert.equal(wsRead.status, 403)

    // Delete wsBot -> cannot register new server on archived bot
    await daemonFetch(address, `/bots/${wsBotId}`, { method: 'DELETE' })
    const archivedReg = await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'archived-bot-srv',
        scope: { kind: 'bot', botId: wsBotId },
        displayName: 'Archived Bot Server',
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
    assert.equal(archivedReg.status, 404)

    // 3. Register counted fixture server on chief (ask-approval)
    await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'counted-srv',
        scope: { kind: 'bot', botId: 'chief' },
        displayName: 'Counted Server',
        transport: {
          type: 'stdio',
          executablePath: process.execPath,
          args: [FIXTURE_SERVER_PATH, '--counter', counterFile],
          cwd: dirname(FIXTURE_SERVER_PATH),
          envAllowlist: [],
          secretRefs: [{ envVar: 'TEST_SECRET', refId: 'sec-1' }],
        },
      }),
    })
    await daemonFetch(address, '/mcp/servers/counted-srv/trust', { method: 'POST' })
    await daemonFetch(address, '/mcp/servers/counted-srv/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })

    // Cross-bot resource read rejected
    const crossRead = await daemonFetch(address, '/mcp/resources/read', {
      method: 'POST',
      body: JSON.stringify({ serverId: 'counted-srv', uri: 'ghost://fixture/info', botId: 'developer' }),
    })
    assert.equal(crossRead.status, 403)

    const sessRes = await daemonFetch(address, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'chief', title: 'Hardening Session' }),
    })
    const sessionId = String(sessRes.json.id)

    // 4. Revoke trust while awaiting_approval -> resolveApproval revokes and 0 invocations occur
    const r1 = await daemonFetch(address, '/runs', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        idempotencyKey: 'hard-revoke-1',
        text: 'mcp-tool:counted-srv/echo_tool {"text":"revoked_mid_flight"}',
      }),
    })
    const run1Id = String((r1.json.run as Record<string, unknown>).id)
    const wait1 = await waitForRunStatus(address, run1Id, ['awaiting_approval'])
    const app1 = wait1.pendingApproval as Record<string, unknown>

    await daemonFetch(address, '/mcp/servers/counted-srv/revoke-trust', { method: 'POST' })
    const approveAfterRevoke = await daemonFetch(address, `/runs/${run1Id}/approval`, {
      method: 'POST',
      body: JSON.stringify({ approvalId: app1.approvalId, decision: 'approved' }),
    })
    assert.equal(approveAfterRevoke.status, 409)
    await daemonFetch(address, `/runs/${run1Id}/cancel`, { method: 'POST' })
    await waitForRunStatus(address, run1Id, ['cancelled'])
    assert.equal(await readInvocationCount(counterFile), 0)

    // 5. Re-trust, approve once -> exactly 1 invocation, secret never leaked in DB/events
    await daemonFetch(address, '/mcp/servers/counted-srv/trust', { method: 'POST' })
    await daemonFetch(address, '/mcp/servers/counted-srv/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
    const r2 = await daemonFetch(address, '/runs', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        idempotencyKey: 'hard-ok-2',
        text: 'mcp-tool:counted-srv/echo_tool {"text":"ok_once"}',
      }),
    })
    const run2Id = String((r2.json.run as Record<string, unknown>).id)
    const wait2 = await waitForRunStatus(address, run2Id, ['awaiting_approval'])
    const app2 = wait2.pendingApproval as Record<string, unknown>
    const approve2 = await daemonFetch(address, `/runs/${run2Id}/approval`, {
      method: 'POST',
      body: JSON.stringify({ approvalId: app2.approvalId, decision: 'approved', argsHash: app2.argsHash }),
    })
    assert.equal(approve2.status, 200)
    await waitForRunStatus(address, run2Id, ['completed'])
    assert.equal(await readInvocationCount(counterFile), 1)

    // Verify synthetic secret never leaked into mcp_servers, approvals, or mcp_approval_bindings
    const dbCheck = await openGhostBotDatabase(dir)
    try {
      const srvRows = JSON.stringify(dbCheck.sqlite.prepare('SELECT * FROM mcp_servers').all())
      const appRows = JSON.stringify(dbCheck.sqlite.prepare('SELECT * FROM approvals').all())
      const bindRows = JSON.stringify(dbCheck.sqlite.prepare('SELECT * FROM mcp_approval_bindings').all())
      assert.equal(srvRows.includes(syntheticSecret), false)
      assert.equal(appRows.includes(syntheticSecret), false)
      assert.equal(bindRows.includes(syntheticSecret), false)
    } finally {
      dbCheck.close()
    }
  } finally {
    await daemon.stop()
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('Phase 3D.3 hardening: cross-extension responsiveness (Knowledge search + Memory list during MCP approval & execution)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-3d3-xext-'))
  const daemon = new GhostBotDaemon({
    authToken: AUTH_TOKEN,
    port: 0,
    dataDir: dir,
    runtimeMode: 'mock',
    mcpGracefulShutdownMs: 200,
  })

  try {
    const { address } = await daemon.start()

    // Seed Knowledge document (>50 chunks) & Memory
    const col = await daemonFetch(address, '/knowledge/collections', {
      method: 'POST',
      body: JSON.stringify({ scope: { kind: 'bot', botId: 'chief' }, name: 'Perf' }),
    })
    assert.equal(col.status, 201)
    const bigText = Array.from({ length: 80 }, (_, i) => `## Section ${i}\nLocal security verification chunk ${i}.\n`).join('\n')
    const doc = await daemonFetch(address, '/knowledge/documents/ingest-text', {
      method: 'POST',
      body: JSON.stringify({
        scope: { kind: 'bot', botId: 'chief' },
        collectionId: col.json.id,
        title: 'Large Verification Doc',
        sourceType: 'markdown',
        text: bigText,
        tags: ['perf'],
      }),
    })
    assert.equal(doc.status, 201)

    await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'xext-srv',
        scope: { kind: 'bot', botId: 'chief' },
        displayName: 'Cross-Ext Server',
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
    await daemonFetch(address, '/mcp/servers/xext-srv/trust', { method: 'POST' })
    await daemonFetch(address, '/mcp/servers/xext-srv/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })

    const sess = await daemonFetch(address, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'chief', title: 'Cross-Ext Session' }),
    })
    const runRes = await daemonFetch(address, '/runs', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: sess.json.id,
        idempotencyKey: 'xext-run-1',
        text: 'mcp-tool:xext-srv/slow_tool {"delayMs":350}',
      }),
    })
    const runId = String((runRes.json.run as Record<string, unknown>).id)
    const waiting = await waitForRunStatus(address, runId, ['awaiting_approval'])
    const approval = waiting.pendingApproval as Record<string, unknown>

    // Measure Knowledge search while MCP approval is pending
    const searchSamples: number[] = []
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now()
      const s = await daemonFetch(address, '/knowledge/documents/search', {
        method: 'POST',
        body: JSON.stringify({ query: 'security verification', botId: 'chief', limit: 10 }),
      })
      const dt = performance.now() - t0
      assert.equal(s.status, 200)
      searchSamples.push(dt)
    }

    const eld = monitorEventLoopDelay({ resolution: 10 })
    eld.enable()

    // Approve & measure /health + /memories while slow_tool is executing
    await daemonFetch(address, `/runs/${runId}/approval`, {
      method: 'POST',
      body: JSON.stringify({ approvalId: approval.approvalId, decision: 'approved' }),
    })
    const healthSamples: number[] = []
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now()
      const h = await daemonFetch(address, '/health')
      const m = await daemonFetch(address, '/memories?botId=chief')
      const dt = performance.now() - t0
      assert.equal(h.status, 200)
      assert.equal(m.status, 200)
      healthSamples.push(dt)
      await new Promise((r) => setTimeout(r, 15))
    }

    await waitForRunStatus(address, runId, ['completed'])
    eld.disable()

    searchSamples.sort((a, b) => a - b)
    healthSamples.sort((a, b) => a - b)
    const searchP95 = searchSamples[Math.floor(searchSamples.length * 0.95)] ?? 0
    const healthP95 = healthSamples[Math.floor(healthSamples.length * 0.95)] ?? 0
    const eventLoopP95Ms = eld.percentile(95) / 1e6

    console.log(
      JSON.stringify({
        benchmark: 'phase-3d3-cross-extension',
        searchSamples: searchSamples.length,
        searchP95Ms: Number(searchP95.toFixed(2)),
        healthMemorySamples: healthSamples.length,
        healthMemoryP95Ms: Number(healthP95.toFixed(2)),
        eventLoopP95Ms: Number(eventLoopP95Ms.toFixed(2)),
      }),
    )
    assert.ok(searchP95 < 100, `Expected Knowledge search p95 < 100ms, got ${searchP95.toFixed(2)}ms`)
    assert.ok(healthP95 < 50, `Expected health+memory p95 < 50ms, got ${healthP95.toFixed(2)}ms`)
  } finally {
    await daemon.stop()
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
