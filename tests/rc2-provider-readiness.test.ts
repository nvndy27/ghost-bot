import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentEvent, AgentRequest, AgentRuntime, Session, SessionConfig } from '@ghost-bot/shared-types/runtime'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { InMemoryTestSecretStore } from '../apps/daemon/src/secrets/store.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'

async function apiJson<T>(port: number, token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const raw = await response.text()
  return { status: response.status, data: (raw ? JSON.parse(raw) : {}) as T }
}

function modelFixtureAdapter(listModels: () => Promise<Awaited<ReturnType<AgentRuntime['listModels']>>>): AgentRuntime {
  return {
    id: 'claude-api',
    async authenticate() { return { status: 'connected' } },
    async getAuthStatus() { return { status: 'connected' } },
    async disconnect() {},
    async capabilities() {
      return { streaming: true, cancellation: true, resume: false, approvals: false, usage: false, sandbox: false, models: await this.listModels() }
    },
    listModels,
    async getUsage() { return null },
    async createSession(_config: SessionConfig): Promise<Session> {
      return { id: 'fixture-session', externalId: 'fixture-session', runtimeId: 'claude-api' }
    },
    async *run(_request: AgentRequest): AsyncIterable<AgentEvent> {},
    async resolveApproval() {},
    async cancel() {},
  }
}

test('production seed leaves new profiles empty and preserves the explicit mock-only demo seeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghost-rc2-seed-'))
  chmodSync(root, 0o700)
  const dataDir = join(root, 'data')
  const db = await openGhostBotDatabase(dataDir)
  try {
    assert.equal(seedInitialBotsIfNeeded(db, 'codex'), true)
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM agents').get()?.count, 0)
  } finally {
    db.close()
  }
  const demoDb = await openGhostBotDatabase(join(root, 'demo'))
  try {
    assert.equal(seedInitialBotsIfNeeded(demoDb, 'mock'), true)
    const seeded = demoDb.sqlite.prepare('SELECT runtime_id, model_id, effort FROM agents').all() as Array<{
      runtime_id: string; model_id: string; effort: string
    }>
    assert.equal(seeded.length, 5)
    assert.ok(seeded.every((bot) => bot.runtime_id === 'mock-offline' && bot.model_id === 'mock-model'))
    assert.ok(seeded.every((bot) => ['low', 'medium'].includes(bot.effort)))
  } finally {
    demoDb.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('daemon provider catalog is explicit, provider-bound, exact, and never substitutes mock models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghost-rc2-provider-'))
  chmodSync(root, 0o700)
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const token = `rc2-${randomUUID()}-auth-token`
  const secretStore = new InMemoryTestSecretStore()
  let discoveryCalls = 0
  let failDiscovery = false
  const adapter = modelFixtureAdapter(async () => {
    discoveryCalls += 1
    if (failDiscovery) throw new Error('Synthetic transport failure; no secret data')
    return [{
      id: 'claude-synthetic-v2',
      label: 'Synthetic Claude V2',
      efforts: ['low', 'xhigh', 'max'],
      permissionModes: ['read-only'],
      supportsTools: false,
      supportsAttachments: false,
    }]
  })
  const daemon = new GhostBotDaemon({
    authToken: token,
    port: 0,
    dataDir,
    runtimeMode: 'codex',
    codexVersion: null,
    secretStore,
    testProviderAdapters: { 'claude-api': adapter },
  })
  try {
    const info = await daemon.start()
    const port = Number(new URL(info.address).port)
    const initial = await apiJson<{
      runtimeMode: string
      providers: Array<{ id: string; catalogState: string; models: Array<{ id: string }>; executionReady: boolean }>
    }>(port, token, 'POST', '/runtime/provider-capabilities', {})
    assert.equal(initial.status, 200)
    assert.equal(initial.data.runtimeMode, 'codex')
    assert.deepEqual(initial.data.providers.find((provider) => provider.id === 'mock-offline')?.models, [])
    assert.equal(initial.data.providers.some((provider) => provider.models.some((model) => /mock/i.test(model.id))), false)
    assert.equal(discoveryCalls, 0)

    const credential = await apiJson(port, token, 'PUT', '/claude/credential', { apiKey: 'sk-ant-synthetic-test-key' })
    assert.equal(credential.status, 200)
    const notAuthorized = await apiJson<{
      providers: Array<{ id: string; catalogState: string; models: unknown[] }>
    }>(port, token, 'POST', '/runtime/provider-capabilities', { discoverProviderId: 'claude-api' })
    assert.equal(notAuthorized.status, 200)
    assert.equal(notAuthorized.data.providers.find((provider) => provider.id === 'claude-api')?.catalogState, 'not-authorized')
    assert.deepEqual(notAuthorized.data.providers.find((provider) => provider.id === 'claude-api')?.models, [])
    assert.equal(discoveryCalls, 0)

    const authorize = await apiJson(port, token, 'PUT', '/claude/authorization', { authorized: true })
    assert.equal(authorize.status, 200)
    const discovered = await apiJson<{
      providers: Array<{
        id: string
        catalogState: string
        catalogGeneration: string | null
        models: Array<{ id: string; efforts: string[]; permissionModes: string[] }>
      }>
    }>(port, token, 'POST', '/runtime/provider-capabilities', { discoverProviderId: 'claude-api', refresh: true })
    const claude = discovered.data.providers.find((provider) => provider.id === 'claude-api')!
    assert.equal(claude.catalogState, 'available')
    assert.ok(claude.catalogGeneration)
    assert.deepEqual(claude.models, [{
      id: 'claude-synthetic-v2',
      label: 'Synthetic Claude V2',
      efforts: ['low', 'xhigh', 'max'],
      permissionModes: ['read-only'],
      supportsTools: false,
      supportsAttachments: false,
    }])
    assert.equal(discoveryCalls, 1)
    const sameCatalog = await apiJson<{
      providers: Array<{ id: string; catalogGeneration: string | null }>
    }>(port, token, 'POST', '/runtime/provider-capabilities', {})
    assert.equal(
      sameCatalog.data.providers.find((provider) => provider.id === 'claude-api')?.catalogGeneration,
      claude.catalogGeneration,
      'Unchanged discovered models retain a stable catalog generation across status reads',
    )
    assert.equal(discoveryCalls, 1, 'Status reads do not repeat external model discovery')

    const createBody = {
      name: 'Synthetic provider bot',
      description: '',
      instructions: 'Keep the fixture answer short.',
      avatar: { kind: 'preset', shape: 'researcher', color: '#418D79', eyes: 'round', rotation: 0, animation: true },
      runtimeId: 'claude-api',
      modelId: 'claude-synthetic-v2',
      effort: 'xhigh',
      catalogGeneration: claude.catalogGeneration,
      workspacePath: workspace,
      permission: 'read-only',
    }
    const unsupportedEffort = await apiJson<{ code?: string }>(port, token, 'POST', '/bots', { ...createBody, effort: 'invented-effort' })
    assert.equal(unsupportedEffort.status, 400)
    assert.equal(unsupportedEffort.data.code, 'EFFORT_UNSUPPORTED')
    const unavailableModel = await apiJson<{ code?: string }>(port, token, 'POST', '/bots', { ...createBody, modelId: 'not-in-catalog' })
    assert.equal(unavailableModel.status, 400)
    assert.equal(unavailableModel.data.code, 'MODEL_UNAVAILABLE')
    const created = await apiJson<{ id: string; modelId: string; effort: string; avatar: { shape: string } }>(port, token, 'POST', '/bots', createBody)
    assert.equal(created.status, 201)
    assert.equal(created.data.modelId, 'claude-synthetic-v2')
    assert.equal(created.data.effort, 'xhigh')
    assert.equal(created.data.avatar.shape, 'researcher')
    const session = await apiJson<{ id: string }>(port, token, 'POST', '/sessions', { agentId: created.data.id, title: 'Preserved conversation' })
    assert.equal(session.status, 201)
    const renamed = await apiJson<{ id: string; avatar: { shape: string } }>(port, token, 'PATCH', `/bots/${created.data.id}`, { name: 'Renamed fixture bot' })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.data.id, created.data.id)
    assert.equal(renamed.data.avatar.shape, 'researcher')
    const preservedSessions = await apiJson<{ sessions: Array<{ id: string }> }>(port, token, 'GET', `/sessions?agentId=${created.data.id}`)
    assert.equal(preservedSessions.data.sessions[0]?.id, session.data.id)

    const revoke = await apiJson(port, token, 'PUT', '/claude/authorization', { authorized: false })
    assert.equal(revoke.status, 200)
    const gated = await apiJson<{
      selectedBot: { ready: boolean; status: string } | null
    }>(port, token, 'POST', '/runtime/provider-capabilities', { botId: created.data.id })
    assert.equal(gated.data.selectedBot?.ready, false)
    assert.equal(gated.data.selectedBot?.status, 'execution-gated')
    const reauthorize = await apiJson(port, token, 'PUT', '/claude/authorization', { authorized: true })
    assert.equal(reauthorize.status, 200)

    failDiscovery = true
    const stale = await apiJson<{
      providers: Array<{ id: string; catalogState: string; models: Array<{ id: string }> }>
    }>(port, token, 'POST', '/runtime/provider-capabilities', { discoverProviderId: 'claude-api', refresh: true })
    const staleClaude = stale.data.providers.find((provider) => provider.id === 'claude-api')!
    assert.equal(staleClaude.catalogState, 'stale')
    assert.deepEqual(staleClaude.models.map((model) => model.id), ['claude-synthetic-v2'])
    assert.equal(discoveryCalls, 2)
  } finally {
    await daemon.stop().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})
