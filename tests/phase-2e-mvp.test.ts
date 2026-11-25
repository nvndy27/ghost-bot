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

test('Phase 2E: reconcileOnStartup reconstructs quarantine for live starting/running/awaiting_approval/cancelling but not queued or mock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-bot-2e-quarantine-'))
  try {
    const dbHandle = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(dbHandle)
    const sessionRepo = new SessionRepository(dbHandle)
    const now = new Date().toISOString()

    const sQueued = sessionRepo.createSession({ agentId: 'chief', title: 'Queued Codex' })
    const sStarting = sessionRepo.createSession({ agentId: 'chief', title: 'Starting Codex' })
    const sRunning = sessionRepo.createSession({ agentId: 'chief', title: 'Running Codex' })
    const sAwaiting = sessionRepo.createSession({ agentId: 'chief', title: 'Awaiting Codex' })
    const sCancelling = sessionRepo.createSession({ agentId: 'chief', title: 'Cancelling Codex' })
    const sMock = sessionRepo.createSession({ agentId: 'chief', title: 'Running Mock' })

    const insertRun = dbHandle.sqlite.prepare(
      `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, started_at, created_at)
       VALUES (?, ?, 'chief', ?, ?, 'gpt-5.4', 'medium', 'read-only', '{}', ?, ?, ?)`,
    )
    insertRun.run('r-q', sQueued.id, 'k-q', 'codex', 'queued', now, now)
    insertRun.run('r-s', sStarting.id, 'k-s', 'codex', 'starting', now, now)
    insertRun.run('r-r', sRunning.id, 'k-r', 'codex', 'running', now, now)
    insertRun.run('r-a', sAwaiting.id, 'k-a', 'codex', 'awaiting_approval', now, now)
    insertRun.run('r-c', sCancelling.id, 'k-c', 'codex', 'cancelling', now, now)
    insertRun.run('r-m', sMock.id, 'k-m', 'mock', 'running', now, now)

    const orchestrator = new RunOrchestrator(dbHandle)
    const reconciled = orchestrator.reconcileOnStartup()
    assert.equal(reconciled, 6)

    assert.equal((await orchestrator.inspectSession(sQueued.id)).quarantined, false)
    assert.equal((await orchestrator.inspectSession(sMock.id)).quarantined, false)
    assert.equal((await orchestrator.inspectSession(sStarting.id)).quarantined, true)
    assert.equal((await orchestrator.inspectSession(sRunning.id)).quarantined, true)
    assert.equal((await orchestrator.inspectSession(sAwaiting.id)).quarantined, true)
    assert.equal((await orchestrator.inspectSession(sCancelling.id)).quarantined, true)

    // Durable quarantine survives daemon/orchestrator restart
    await orchestrator.stop()
    const orchestrator2 = new RunOrchestrator(dbHandle)
    assert.equal((await orchestrator2.inspectSession(sQueued.id)).quarantined, false)
    assert.equal((await orchestrator2.inspectSession(sRunning.id)).quarantined, true)
    assert.equal((await orchestrator2.inspectSession(sAwaiting.id)).quarantined, true)
    assert.equal((await orchestrator2.inspectSession(sCancelling.id)).quarantined, true)
    await orchestrator2.stop()
    dbHandle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Phase 2E: OpenClawGatewayAdapter redacts credentials in error details', async () => {
  const oc = new OpenClawGatewayAdapter({
    transport: {
      async callRpc() {
        throw new Error('401 Unauthorized Bearer secret-jwt-token-123 password=my-pass')
      },
    },
  })
  const info = await oc.inspectGateway()
  assert.equal(info.available, false)
  assert.doesNotMatch(info.authState.detail ?? '', /secret-jwt-token-123/)
  assert.doesNotMatch(info.authState.detail ?? '', /my-pass/)
  assert.match(info.authState.detail ?? '', /\[REDACTED\]/)
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
