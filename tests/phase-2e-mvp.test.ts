import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OllamaLocalAdapter } from '../packages/runtime-adapters/ollama/ollama-adapter.ts'
import { OpenClawGatewayAdapter } from '../packages/runtime-adapters/openclaw/openclaw-gateway.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'

test('Phase 2E: reconcileOnStartup reconstructs durable quarantine for interrupted cancelling runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-bot-2e-quarantine-'))
  try {
    const dbHandle = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(dbHandle)
    const sessionRepo = new SessionRepository(dbHandle)
    const sess = sessionRepo.createSession({ agentId: 'chief', title: 'Abrupt Cancel' })
    const now = new Date().toISOString()

    dbHandle.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, started_at, created_at)
         VALUES ('run-cancelling-crash', ?, 'chief', 'k-cancel-crash', 'codex', 'gpt-5.4', 'medium', 'read-only', '{}', 'cancelling', ?, ?)`,
      )
      .run(sess.id, now, now)

    const orchestrator = new RunOrchestrator(dbHandle)
    const reconciled = orchestrator.reconcileOnStartup()
    assert.equal(reconciled, 1)
    assert.equal(orchestrator.getRun('run-cancelling-crash').status, 'interrupted')
    assert.equal((await orchestrator.inspectSession(sess.id)).quarantined, true)

    // Survives another daemon/orchestrator restart
    await orchestrator.stop()
    const orchestrator2 = new RunOrchestrator(dbHandle)
    assert.equal((await orchestrator2.inspectSession(sess.id)).quarantined, true)
    await orchestrator2.stop()
    dbHandle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Phase 2E: RuntimeRegistry isolates Codex, OpenClaw, and unavailable Ollama providers', async () => {
  const registry = new RuntimeRegistry({
    runtimeMode: 'codex',
    codexVersionOverride: '0.172.0',
    codexClientFactory: () => ({
      async getAccountSummary() {
        return {
          accountPresent: true,
          accountType: 'chatgpt',
          email: 'user@example.com',
          planType: 'plus',
          workspaceName: 'Personal',
          requiresOpenaiAuth: false,
        }
      },
      async listModels() {
        return []
      },
      async getUsage() {
        return null
      },
      async close() {},
    }),
    openclawAdapter: new OpenClawGatewayAdapter({
      transport: {
        async callRpc<T>(method: string): Promise<T> {
          if (method === 'health') return { ok: true } as T
          if (method === 'status') return { runtimeVersion: '2026.11.8' } as T
          return { models: [] } as T
        },
      },
    }),
    ollamaAdapter: new OllamaLocalAdapter({
      baseUrl: 'http://127.0.0.1:59999',
      timeoutMs: 300,
    }),
  })

  const providers = await registry.listProviders()
  assert.equal(providers.length, 3)

  const codex = providers.find((p) => p.id === 'codex-app-server')
  const openclaw = providers.find((p) => p.id === 'openclaw')
  const ollama = providers.find((p) => p.id === 'ollama')

  assert.equal(codex?.status, 'connected')
  assert.equal(openclaw?.status, 'connected')
  assert.match(openclaw?.detail ?? '', /live execution gated/i)
  assert.equal(ollama?.status, 'unavailable')

  await registry.stop()
})
