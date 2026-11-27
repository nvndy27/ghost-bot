import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { McpService } from '../apps/daemon/src/mcp/service.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import {
  InMemoryTestSecretStore,
  LinuxSecretServiceStore,
  UnavailableSecretStore,
} from '../apps/daemon/src/secrets/store.ts'
import { SettingsRepository } from '../apps/daemon/src/settings/repository.ts'

function createMcpEnvEchoFixture(dir: string): string {
  const scriptPath = join(dir, 'mcp-secret-fixture.mjs')
  writeFileSync(
    scriptPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'secret-fixture', version: '1.0.0' }
      }
    }) + '\\n');
    return;
  }
  if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [{
          name: 'check_secret_len',
          description: 'Returns length of TEST_API_KEY in subprocess env without echoing value',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }]
      }
    }) + '\\n');
    return;
  }
  if (msg.method === 'tools/call') {
    const val = process.env.TEST_API_KEY ?? '';
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ hasKey: val.length > 0, len: val.length, prefix: val.slice(0, 3) }) }]
      }
    }) + '\\n');
    return;
  }
  if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
`,
    'utf8',
  )
  chmodSync(scriptPath, 0o700)
  return scriptPath
}

describe('Core.1: SecretStore & MCP secretRefs Integration', () => {
  it('enforces SecretStore isolation, replacement, deletion, locked/unavailable fail-closed, and input validation', () => {
    const unavailable = new UnavailableSecretStore('No keyring')
    assert.equal(unavailable.getStatus().available, false)
    assert.throws(() => unavailable.store({ ownerId: 'u1', serverId: 's1', refId: 'r1' }, 'l', 'sec'))
    assert.throws(() => unavailable.resolve({ ownerId: 'u1', serverId: 's1', refId: 'r1' }))

    const store = new InMemoryTestSecretStore()
    assert.equal(store.getStatus().available, true)
    store.store({ ownerId: 'owner-1', serverId: 'srv-a', refId: 'ref-1' }, 'Token A', 'synthetic-secret-alpha')
    assert.equal(store.resolve({ ownerId: 'owner-1', serverId: 'srv-a', refId: 'ref-1' }), 'synthetic-secret-alpha')

    // Cross-owner and cross-server isolation
    assert.throws(() => store.resolve({ ownerId: 'owner-2', serverId: 'srv-a', refId: 'ref-1' }))
    assert.throws(() => store.resolve({ ownerId: 'owner-1', serverId: 'srv-b', refId: 'ref-1' }))

    // Replacement & deletion
    store.replace({ ownerId: 'owner-1', serverId: 'srv-a', refId: 'ref-1' }, 'Token A', 'synthetic-secret-beta-2')
    assert.equal(store.resolve({ ownerId: 'owner-1', serverId: 'srv-a', refId: 'ref-1' }), 'synthetic-secret-beta-2')

    // Locked state fails closed
    store.setLocked(true)
    assert.equal(store.getStatus().locked, true)
    assert.equal(store.getStatus().available, false)
    assert.throws(() => store.resolve({ ownerId: 'owner-1', serverId: 'srv-a', refId: 'ref-1' }))
    assert.throws(() => store.store({ ownerId: 'owner-1', serverId: 'srv-a', refId: 'ref-2' }, 'x', 'y'))

    store.setLocked(false)
    assert.equal(store.delete({ ownerId: 'owner-1', serverId: 'srv-a', refId: 'ref-1' }), true)
    assert.equal(store.exists({ ownerId: 'owner-1', serverId: 'srv-a', refId: 'ref-1' }), false)
  })

  it('integrates SecretStore with McpService: metadata-only SQLite, subprocess injection, trust revocation, missing/locked failure, and deletion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-core1-mcp-'))
    chmodSync(dir, 0o700)
    const db = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(db)
    const settingsRepo = new SettingsRepository(db)
    settingsRepo.updateSettings({ mcp: { enabled: true } })
    const botRepo = new BotRepository(db)
    const bot = botRepo.listBots().bots[0]!
    const policyBroker = new RuntimePolicyBroker()
    const secretStore = new InMemoryTestSecretStore()
    const fixtureScript = createMcpEnvEchoFixture(dir)

    const mcpService = new McpService({
      db,
      settingsRepo,
      policyBroker,
      secretStore,
      hostEnv: {},
    })

    let serverId: string | null = null
    try {
      const srv = mcpService.registerServer({
        scope: { kind: 'bot', botId: bot.id },
        displayName: 'Secret Echo Server',
        description: '',
        transport: {
          type: 'stdio',
          executablePath: process.execPath,
          args: [fixtureScript],
          cwd: dir,
          envAllowlist: [],
          secretRefs: [],
        },
      })
      serverId = srv.id

      const secretVal1 = 'syn_pat_111111111111111111'
      const updated = mcpService.setServerSecretRef({
        serverId: srv.id,
        envVar: 'TEST_API_KEY',
        refId: 'api-key-1',
        label: 'Synthetic API Key',
        secretValue: secretVal1,
      })
      assert.equal(updated.trustState, 'untrusted')
      assert.equal(updated.transport.secretRefs.length, 1)

      // Verify SQLite never stores the secret value
      const dbRow = db.sqlite
        .prepare('SELECT transport_json FROM mcp_servers WHERE id = ?')
        .get(srv.id) as { transport_json: string }
      assert.ok(!dbRow.transport_json.includes(secretVal1))

      // Verify listServerSecretRefs returns metadata only
      const listRes = mcpService.listServerSecretRefs(srv.id)
      assert.equal(listRes.refs.length, 1)
      assert.equal(listRes.refs[0]!.hasStoredSecret, true)
      assert.ok(!JSON.stringify(listRes).includes(secretVal1))

      // Approve trust, enable, connect -> subprocess receives TEST_API_KEY
      mcpService.approveTrust(srv.id)
      await mcpService.setEnabled({ id: srv.id, enabled: true })
      const conn = await mcpService.connectServer(srv.id)
      assert.equal(conn.state, 'ready')

      // Missing secret or locked keyring prevents connect
      await mcpService.disconnectServer(srv.id)
      secretStore.setLocked(true)
      await assert.rejects(() => mcpService.connectServer(srv.id), { code: 'MCP_SECRET_UNAVAILABLE' })
      secretStore.setLocked(false)

      // Replace secret value cleanly
      const secretVal2 = 'syn_pat_222222222222222222_longer'
      mcpService.setServerSecretRef({
        serverId: srv.id,
        envVar: 'TEST_API_KEY',
        refId: 'api-key-1',
        label: 'Synthetic API Key',
        secretValue: secretVal2,
      })
      assert.equal(
        secretStore.resolve({ ownerId: 'local-user', serverId: srv.id, refId: 'api-key-1' }),
        secretVal2,
      )

      // Revoking trust prevents secret resolution
      await mcpService.revokeTrust(srv.id)
      await assert.rejects(() => mcpService.connectServer(srv.id), { code: 'MCP_UNTRUSTED' })

      // Delete secret reference cleans keyring + SQLite
      await mcpService.deleteServerSecretRef({ serverId: srv.id, refId: 'api-key-1' })
      assert.equal(secretStore.exists({ ownerId: 'local-user', serverId: srv.id, refId: 'api-key-1' }), false)
      assert.equal(mcpService.listServerSecretRefs(srv.id).refs.length, 0)
    } finally {
      if (serverId) {
        await mcpService.disconnectServer(serverId).catch(() => {})
      }
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('verifies real Linux Secret Service store, resolve, replace, and delete under isolated test namespace', () => {
    const ns = `core1-test-${randomUUID().slice(0, 8)}`
    const store = new LinuxSecretServiceStore({ namespace: ns })
    const status = store.getStatus()
    if (!status.available) {
      // Fail-closed verification when keyring is locked/unavailable on host
      assert.throws(() => store.store({ ownerId: 'test', serverId: 'test', refId: 'r1' }, 'l', 'v'))
      return
    }

    const coord = { ownerId: 'core1-test-owner', serverId: 'core1-test-srv', refId: 'core1-test-ref' }
    try {
      store.store(coord, 'Ghost Bot Core1 Test', 'real-keyring-synthetic-1')
      assert.equal(store.exists(coord), true)
      assert.equal(store.resolve(coord), 'real-keyring-synthetic-1')

      store.replace(coord, 'Ghost Bot Core1 Test', 'real-keyring-synthetic-2')
      assert.equal(store.resolve(coord), 'real-keyring-synthetic-2')

      assert.equal(store.delete(coord), true)
      assert.equal(store.exists(coord), false)
    } finally {
      try {
        store.delete(coord)
      } catch {
        // Already deleted
      }
    }
  })
})
