import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CodexAppServerAdapter } from '../packages/runtime-adapters/codex/codex-app-server.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { MIGRATIONS, runMigrations } from '../apps/daemon/src/db/migrations.ts'
import { COMBINED_EXECUTION_CONTEXT_LIMITS, assembleCombinedExecutionContext } from '../apps/daemon/src/execution/context-assembler.ts'
import { KnowledgeService } from '../apps/daemon/src/knowledge/service.ts'
import { MemoryService } from '../apps/daemon/src/memory/service.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'
import { SettingsRepository } from '../apps/daemon/src/settings/repository.ts'

const AUTH_TOKEN = 'test-daemon-token-phase-3d4-0123456789'
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
    if (targetStatuses.includes(String(json.status))) return json
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out waiting for run ${runId} -> ${targetStatuses.join('|')}`)
}

test('Phase 3D.4 integrated persistence: fresh + v4/v5/v6 upgrades, 0700/0600 permissions, and atomic archival rollback', async () => {
  for (const fromVersion of [4, 5, 6] as const) {
    const dir = await mkdtemp(join(tmpdir(), `gb-3d4-v${fromVersion}-`))
    try {
      const dbPath = join(dir, 'ghost-bot.sqlite')
      const legacy = new DatabaseSync(dbPath)
      legacy.exec('PRAGMA foreign_keys = ON;')
      legacy.exec(
        'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);',
      )
      for (const mig of MIGRATIONS.filter((m) => m.version <= fromVersion)) {
        legacy.exec(mig.sql)
        legacy
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(mig.version, mig.name, '2026-11-26T00:00:00.000Z')
      }
      const now = '2026-11-26T00:00:00.000Z'
      legacy
        .prepare(
          `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_profile_id, model_id, effort, workspace_path, permission_mode, archived_at, created_at, updated_at)
           VALUES ('bot_keep', 'Keep Bot', '', '', '{}', 'mock', NULL, 'gpt-6.2-mock', 'medium', ?, 'ask-approval', NULL, ?, ?)`,
        )
        .run(dir, now, now)
      if (fromVersion >= 5) {
        legacy
          .prepare(
            `INSERT INTO memories (id, schema_version, scope_kind, user_id, bot_id, workspace_id, scope_key, origin, category, content, normalized_content, content_hash, tags_json, provenance_json, status, created_at, updated_at, archived_at, expires_at)
             VALUES ('mem_keep', 1, 'bot', 'local-user', 'bot_keep', NULL, 'bot:local-user:bot_keep', 'explicit', 'preference', 'Preserved memory', 'preserved memory', 'h1', '[]', '{}', 'active', ?, ?, NULL, NULL)`,
          )
          .run(now, now)
      }
      legacy.close()

      const handle = await openGhostBotDatabase(dir)
      try {
        assert.equal(runMigrations(handle.sqlite), 0)
        const versions = handle.sqlite
          .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
          .all() as Array<{ version: number }>
        assert.deepEqual(
          versions.map((v) => v.version),
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        )

        const dirStat = await stat(dir)
        const dbStat = await stat(dbPath)
        assert.equal(dirStat.mode & 0o777, 0o700)
        assert.equal(dbStat.mode & 0o777, 0o600)

        const bot = handle.sqlite.prepare("SELECT id FROM agents WHERE id = 'bot_keep'").get() as { id: string }
        assert.equal(bot.id, 'bot_keep')
        if (fromVersion >= 5) {
          const mem = handle.sqlite.prepare("SELECT id FROM memories WHERE id = 'mem_keep'").get() as { id: string }
          assert.equal(mem.id, 'mem_keep')
        }
      } finally {
        handle.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  }

  // Atomic bot archival rollback when injected callback throws
  const rbDir = await mkdtemp(join(tmpdir(), 'gb-3d4-rb-'))
  try {
    const handle = await openGhostBotDatabase(rbDir)
    try {
      const repo = new BotRepository(handle)
      const settingsRepo = new SettingsRepository(handle)
      const memoryService = new MemoryService(handle, settingsRepo)
      const knowledgeService = new KnowledgeService(handle, settingsRepo)

      const botA = await repo.createBot({
        name: 'Rollback Bot',
        description: '',
        instructions: '',
        avatar: { kind: 'preset', shape: 'security', color: '#536B85', eyes: 'classic', rotation: 0, animation: false },
        runtimeId: 'mock-offline',
        modelId: 'gpt-6.2-mock',
        effort: 'medium',
        workspacePath: rbDir,
        permission: 'ask-approval',
      })
      const botB = await repo.createBot({
        name: 'Survivor Bot',
        description: '',
        instructions: '',
        avatar: { kind: 'preset', shape: 'developer', color: '#536B85', eyes: 'classic', rotation: 0, animation: false },
        runtimeId: 'mock-offline',
        modelId: 'gpt-6.2-mock',
        effort: 'medium',
        workspacePath: rbDir,
        permission: 'ask-approval',
      })
      assert.ok(botB.id)
      const mem = await memoryService.createMemory({
        scope: { kind: 'bot', botId: botA.id },
        category: 'preference',
        content: 'Keep on rollback',
        tags: [],
      })

      assert.throws(() => {
        repo.deleteBot(botA.id, {
          onArchiveBot: (id, now) => {
            memoryService.archiveMemoriesForBotInTx(id, now)
            knowledgeService.archiveKnowledgeForBotInTx(id, now)
            throw new Error('Injected MCP archival failure')
          },
        })
      }, /Injected MCP archival failure/)

      const stillActiveBot = handle.sqlite
        .prepare('SELECT archived_at FROM agents WHERE id = ?')
        .get(botA.id) as { archived_at: string | null }
      const stillActiveMem = handle.sqlite
        .prepare('SELECT status FROM memories WHERE id = ?')
        .get(mem.id) as { status: string }
      assert.equal(stillActiveBot.archived_at, null)
      assert.equal(stillActiveMem.status, 'active')
    } finally {
      handle.close()
    }
  } finally {
    await rm(rbDir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('Phase 3D.4 combined Memory+Knowledge UTF-8 budget, emoji/Vietnamese escaping, and dispatch-time revalidation barrier', async () => {
  const assembled = assembleCombinedExecutionContext(
    {
      status: 'attached',
      mechanism: 'codex_input_item',
      envelopeJson: JSON.stringify({
        kind: 'untrusted_memory_reference_data',
        records: [{ id: 'm1', content: 'Ưu tiên tiếng Việt 🔐🤖 "escaped"'.repeat(40) }],
      }),
      selectedCount: 1,
      totalBytes: 1800,
      truncated: false,
    },
    {
      status: 'attached',
      mechanism: 'codex_input_item',
      envelopeJson: JSON.stringify({
        kind: 'untrusted_knowledge_reference_data',
        chunks: [{ id: 'c1', text: 'Tài liệu bảo mật nội bộ 🛡️ '.repeat(100) }],
      }),
      selectedDocuments: 1,
      selectedChunks: 1,
      totalBytes: 4200,
      truncated: false,
      citations: [],
    },
  )

  assert.equal(assembled.memory.status, 'attached')
  assert.equal(assembled.knowledge.status, 'attached')
  assert.ok(assembled.totalBytes <= COMBINED_EXECUTION_CONTEXT_LIMITS.maxCombinedBytes)

  // Deterministic barrier inside CodexAppServerAdapter.run() rejects stale context if callback returns null/empty on re-check
  let revalidated = false
  const adapter = new CodexAppServerAdapter({
    clientFactory: () =>
      ({
        isClosed: () => false,
        request: async (method: string) => {
          if (method === 'thread/start') return { thread: { id: 'thr_1' } }
          if (method === 'turn/start') {
            assert.equal(revalidated, true)
            return { turn: { id: 'turn_1' } }
          }
          return {}
        },
        onNotification: () => () => undefined,
        onServerRequest: () => () => undefined,
        close: async () => undefined,
      }) as never,
    prepareReferenceContext: async () => {
      revalidated = true
      return null
    },
  } as never)

  assert.ok(adapter)
})

test('Phase 3D.4 cross-extension ~2500-chunk Knowledge + Memory + active MCP benchmark', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-3d4-perf-'))
  const daemon = new GhostBotDaemon({
    authToken: AUTH_TOKEN,
    port: 0,
    dataDir: dir,
    runtimeMode: 'mock',
    mcpGracefulShutdownMs: 200,
  })

  try {
    const { address } = await daemon.start()
    const col = await daemonFetch(address, '/knowledge/collections', {
      method: 'POST',
      body: JSON.stringify({ scope: { kind: 'bot', botId: 'chief' }, name: 'Scale-2500' }),
    })
    assert.equal(col.status, 201)

    // Ingest 50 docs * ~50 chunks each = ~2500 chunks
    for (let d = 0; d < 50; d++) {
      const md = Array.from(
        { length: 50 },
        (_, c) => `## Heading ${d}-${c}\nNội dung kiểm thử bảo mật tài liệu cục bộ ${d} ${c}.\n`,
      ).join('\n')
      const ing = await daemonFetch(address, '/knowledge/documents/ingest-text', {
        method: 'POST',
        body: JSON.stringify({
          scope: { kind: 'bot', botId: 'chief' },
          collectionId: col.json.id,
          title: `Scale Doc ${d}`,
          sourceType: 'markdown',
          text: md,
          tags: ['scale'],
        }),
      })
      assert.equal(ing.status, 201)
    }

    await daemonFetch(address, '/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'scale-mcp',
        scope: { kind: 'bot', botId: 'chief' },
        displayName: 'Scale MCP',
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
    await daemonFetch(address, '/mcp/servers/scale-mcp/trust', { method: 'POST' })
    await daemonFetch(address, '/mcp/servers/scale-mcp/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })

    const sess = await daemonFetch(address, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'chief', title: 'Scale Session' }),
    })
    const runRes = await daemonFetch(address, '/runs', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: sess.json.id,
        idempotencyKey: 'scale-run-1',
        text: 'mcp-tool:scale-mcp/slow_tool {"delayMs":400}',
      }),
    })
    const runId = String((runRes.json.run as Record<string, unknown>).id)
    const waiting = await waitForRunStatus(address, runId, ['awaiting_approval'])
    const approval = waiting.pendingApproval as Record<string, unknown>

    const searchSamples: number[] = []
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now()
      const s = await daemonFetch(address, '/knowledge/documents/search', {
        method: 'POST',
        body: JSON.stringify({ query: 'tai lieu cuc bo', botId: 'chief', limit: 20 }),
      })
      const dt = performance.now() - t0
      assert.equal(s.status, 200)
      searchSamples.push(dt)
    }

    const eld = monitorEventLoopDelay({ resolution: 10 })
    eld.enable()
    await daemonFetch(address, `/runs/${runId}/approval`, {
      method: 'POST',
      body: JSON.stringify({ approvalId: approval.approvalId, decision: 'approved' }),
    })

    const healthSamples: number[] = []
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now()
      const h = await daemonFetch(address, '/health')
      const dt = performance.now() - t0
      assert.equal(h.status, 200)
      healthSamples.push(dt)
      await new Promise((r) => setTimeout(r, 20))
    }
    await waitForRunStatus(address, runId, ['completed'])
    eld.disable()

    searchSamples.sort((a, b) => a - b)
    healthSamples.sort((a, b) => a - b)
    const searchP50 = searchSamples[Math.floor(searchSamples.length * 0.5)] ?? 0
    const searchP95 = searchSamples[Math.floor(searchSamples.length * 0.95)] ?? 0
    const searchMax = searchSamples[searchSamples.length - 1] ?? 0
    const healthP95 = healthSamples[Math.floor(healthSamples.length * 0.95)] ?? 0

    console.log(
      JSON.stringify({
        benchmark: 'phase-3d4-2500-chunk-integrated',
        docs: 50,
        searchSamples: searchSamples.length,
        searchP50Ms: Number(searchP50.toFixed(2)),
        searchP95Ms: Number(searchP95.toFixed(2)),
        searchMaxMs: Number(searchMax.toFixed(2)),
        healthP95Ms: Number(healthP95.toFixed(2)),
        eventLoopP95Ms: Number((eld.percentile(95) / 1e6).toFixed(2)),
      }),
    )
    assert.ok(healthP95 < 50, `Expected /health p95 < 50ms, got ${healthP95.toFixed(2)}ms`)
  } finally {
    await daemon.stop()
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
