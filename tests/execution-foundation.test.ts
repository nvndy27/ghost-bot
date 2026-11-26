import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { MIGRATIONS } from '../apps/daemon/src/db/migrations.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { MAX_EVENT_PAYLOAD_BYTES, RunEventStore } from '../apps/daemon/src/execution/event-store.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import {
  assertLegalTransition,
  canTransition,
  isTerminalStatus,
  resolveTerminalRace,
} from '../apps/daemon/src/execution/state-machine.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'

async function daemonRequest(
  baseUrl: string,
  token: string,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const payload = options?.body !== undefined ? JSON.stringify(options.body) : undefined
    const req = httpRequest(
      url,
      {
        method: options?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload !== undefined
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode ?? 500,
            json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
          })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

async function waitForRunTerminal(orchestrator: RunOrchestrator, runId: string, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const run = orchestrator.getRun(runId)
    if (isTerminalStatus(run.status)) return run
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for run ${runId} to become terminal`)
}

test('RunStateMachine enforces legal transitions and terminal immutability', () => {
  assert.equal(canTransition('queued', 'starting'), true)
  assert.equal(canTransition('starting', 'running'), true)
  assert.equal(canTransition('running', 'awaiting_approval'), true)
  assert.equal(canTransition('awaiting_approval', 'running'), true)
  assert.equal(canTransition('running', 'completed'), true)
  assert.equal(canTransition('completed', 'running'), false)
  assert.equal(canTransition('cancelled', 'completed'), false)

  assert.throws(() => assertLegalTransition('completed', 'cancelled'), /Illegal run state transition/)
  assert.equal(resolveTerminalRace('completed', 'completed'), 'ignore_duplicate')
  assert.equal(resolveTerminalRace('completed', 'cancelled'), 'reject_conflict')
  assert.equal(resolveTerminalRace('running', 'completed'), 'proceed')
})

test('Migration 0003 upgrades Phase 1D database cleanly and preserves existing data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-mig-0003-'))
  try {
    const dbPath = join(dir, 'ghost-bot.sqlite')
    const rawDb = new DatabaseSync(dbPath)
    rawDb.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `)
    for (const m of MIGRATIONS.slice(0, 2)) {
      rawDb.exec(m.sql)
      rawDb
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString())
    }
    const now = new Date().toISOString()
    rawDb
      .prepare(
        `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at)
         VALUES ('chief', 'Chief', 'desc', 'inst', '{}', 'mock', 'mock-fast', 'medium', ?, 'ask-approval', ?, ?)`,
      )
      .run(dir, now, now)
    rawDb
      .prepare(
        `INSERT INTO sessions (id, agent_id, account_id, runtime_id, external_session_id, title, created_at)
         VALUES ('sess-legacy', 'chief', 'local', 'mock', NULL, 'Legacy Chat', ?)`,
      )
      .run(now)
    rawDb
      .prepare(
        `INSERT INTO messages (id, session_id, role, content_json, created_at, run_id)
         VALUES ('msg-legacy', 'sess-legacy', 'user', '{"text":"hello legacy"}', ?, NULL)`,
      )
      .run(now)
    rawDb.close()

    const dbHandle = await openGhostBotDatabase(dir)
    try {
      const versionRow = dbHandle.sqlite
        .prepare('SELECT MAX(version) AS v FROM schema_migrations')
        .get() as { v: number }
      assert.equal(Number(versionRow.v), 8)

      const sessionRepo = new SessionRepository(dbHandle)
      const list = sessionRepo.listSessions('chief')
      assert.equal(list.sessions.length, 1)
      assert.equal(list.sessions[0]?.title, 'Legacy Chat')
      const msgs = sessionRepo.getSessionMessages('sess-legacy')
      assert.equal(msgs.messages.length, 1)
      assert.equal(msgs.messages[0]?.text, 'hello legacy')
    } finally {
      dbHandle.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('RunEventStore handles monotonic seq, eventKey deduplication, cursor replay, and oversized rejection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-evt-store-'))
  try {
    const dbHandle = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(dbHandle)
    const sessionRepo = new SessionRepository(dbHandle)
    const session = sessionRepo.createSession({ agentId: 'chief', title: 'Events Test' })
    const now = new Date().toISOString()
    dbHandle.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at)
         VALUES ('run-evt-1', ?, 'chief', 'k1', 'mock', 'mock-fast', 'medium', 'ask-approval', '{}', 'running', NULL, ?, NULL, ?)`,
      )
      .run(session.id, now, now)

    const store = new RunEventStore(dbHandle)
    const first = store.appendEvent('run-evt-1', {
      eventKey: 'delta:1',
      type: 'message.delta',
      payload: { delta: 'Hello ', token: 'sk-1234567890abcdef123456' },
    })
    assert.equal(first.inserted, true)
    assert.equal(first.event.seq, 1)
    assert.equal(first.event.payload.token, '[REDACTED]')

    const dup = store.appendEvent('run-evt-1', {
      eventKey: 'delta:1',
      type: 'message.delta',
      payload: { delta: 'Hello ' },
    })
    assert.equal(dup.inserted, false)
    assert.equal(dup.event.seq, 1)

    const second = store.appendEvent('run-evt-1', {
      eventKey: 'delta:2',
      type: 'message.delta',
      payload: { delta: 'World' },
    })
    assert.equal(second.inserted, true)
    assert.equal(second.event.seq, 2)

    const replay = store.listEventsAfter('run-evt-1', 1, 10)
    assert.equal(replay.events.length, 1)
    assert.equal(replay.events[0]?.seq, 2)

    assert.throws(
      () =>
        store.appendEvent('run-evt-1', {
          eventKey: 'huge',
          type: 'message.delta',
          payload: { delta: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 100) },
        }),
      /exceeds maximum size/,
    )
    dbHandle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('RunOrchestrator enforces concurrency, idempotency, approval, cancel, failure, and startup crash recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-orch-'))
  try {
    const dbHandle = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(dbHandle)
    const sessionRepo = new SessionRepository(dbHandle)
    const orchestrator = new RunOrchestrator(dbHandle)

    // 1. Complete normal mock run + idempotency deduplication
    const s1 = sessionRepo.createSession({ agentId: 'chief', title: 'Normal' })
    const start1 = await orchestrator.startRun({
      sessionId: s1.id,
      idempotencyKey: 'idem-1',
      text: 'Hello mock runtime',
    })
    assert.equal(start1.deduplicated, false)
    const dup1 = await orchestrator.startRun({
      sessionId: s1.id,
      idempotencyKey: 'idem-1',
      text: 'Hello mock runtime',
    })
    assert.equal(dup1.deduplicated, true)
    assert.equal(dup1.run.id, start1.run.id)

    const done1 = await waitForRunTerminal(orchestrator, start1.run.id)
    assert.equal(done1.status, 'completed')
    const msgs1 = sessionRepo.getSessionMessages(s1.id)
    assert.equal(msgs1.messages.length, 2)
    assert.equal(msgs1.messages[1]?.status, 'complete')
    assert.match(msgs1.messages[1]?.text ?? '', /daemon-owned Mock Runtime/)

    // 2. Concurrent run on same session rejected; different session allowed
    const s2 = sessionRepo.createSession({ agentId: 'chief', title: 'Slow' })
    const slowStart = await orchestrator.startRun({
      sessionId: s2.id,
      idempotencyKey: 'idem-slow',
      text: 'Please run slow-cancel test',
    })
    await assert.rejects(
      () =>
        orchestrator.startRun({
          sessionId: s2.id,
          idempotencyKey: 'idem-concurrent',
          text: 'Second prompt',
        }),
      /already has active run/,
    )
    orchestrator.cancelRun(slowStart.run.id)
    const slowDone = await waitForRunTerminal(orchestrator, slowStart.run.id)
    assert.equal(slowDone.status, 'cancelled')

    // 3. Approval flow
    const s3 = sessionRepo.createSession({ agentId: 'chief', title: 'Approval' })
    const appStart = await orchestrator.startRun({
      sessionId: s3.id,
      idempotencyKey: 'idem-app',
      text: 'Test approval flow',
    })
    // Wait until awaiting_approval
    let awaiting = orchestrator.getRun(appStart.run.id)
    const deadline = Date.now() + 3000
    while (awaiting.status !== 'awaiting_approval' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
      awaiting = orchestrator.getRun(appStart.run.id)
    }
    assert.equal(awaiting.status, 'awaiting_approval')
    assert.ok(awaiting.pendingApproval)
    orchestrator.resolveApproval(appStart.run.id, awaiting.pendingApproval.approvalId, 'approved')
    const appDone = await waitForRunTerminal(orchestrator, appStart.run.id)
    assert.equal(appDone.status, 'completed')

    // 4. Failure flow
    const s4 = sessionRepo.createSession({ agentId: 'chief', title: 'Fail' })
    const failStart = await orchestrator.startRun({
      sessionId: s4.id,
      idempotencyKey: 'idem-fail',
      text: 'Trigger fail scenario',
    })
    const failDone = await waitForRunTerminal(orchestrator, failStart.run.id)
    assert.equal(failDone.status, 'failed')
    assert.equal(failDone.error?.code, 'MOCK_EXECUTION_FAILED')

    // 5. Codex runtime blocked when orchestrator has no live runtimeRegistry
    dbHandle.sqlite.prepare(`UPDATE agents SET runtime_id = 'codex' WHERE id = 'chief'`).run()
    await assert.rejects(
      () =>
        orchestrator.startRun({
          sessionId: s1.id,
          idempotencyKey: 'idem-codex-blocked',
          text: 'Should be blocked',
        }),
      /Live AI inference.*disabled/,
    )
    dbHandle.sqlite.prepare(`UPDATE agents SET runtime_id = 'mock' WHERE id = 'chief'`).run()

    // 6. Startup crash recovery marks stale active run & streaming message as interrupted
    const now = new Date().toISOString()
    dbHandle.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at)
         VALUES ('run-crash-1', ?, 'chief', 'idem-crash', 'mock', 'mock-fast', 'medium', 'ask-approval', '{}', 'running', NULL, ?, NULL, ?)`,
      )
      .run(s1.id, now, now)
    dbHandle.sqlite
      .prepare(
        `INSERT INTO messages (id, session_id, role, content_json, seq_order, status, created_at, updated_at, run_id)
         VALUES ('msg-crash-1', ?, 'assistant', '{"text":"partial"}', 99, 'streaming', ?, ?, 'run-crash-1')`,
      )
      .run(s1.id, now, now)

    const reconciled = orchestrator.reconcileOnStartup()
    assert.equal(reconciled, 1)
    const crashedRun = orchestrator.getRun('run-crash-1')
    assert.equal(crashedRun.status, 'interrupted')
    const crashEvents = orchestrator.getRunEvents('run-crash-1', 0, 10)
    assert.equal(crashEvents.events[0]?.type, 'run.interrupted')

    await orchestrator.stop()
    dbHandle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Daemon HTTP routes serve sessions, messages, runs, events, cancel, and approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-http-2a-'))
  const token = 'test-daemon-token-phase-2a-secure'
  const daemon = new GhostBotDaemon({
    authToken: token,
    port: 0,
    dataDir: dir,
    runtimeMode: 'mock',
  })
  try {
    const { address } = await daemon.start()
    const created = await daemonRequest(address, token, '/sessions', {
      method: 'POST',
      body: { agentId: 'chief', title: 'HTTP Session' },
    })
    assert.equal(created.status, 201)
    const sessionId = String(created.json.id)

    const started = await daemonRequest(address, token, '/runs', {
      method: 'POST',
      body: { sessionId, idempotencyKey: 'http-run-1', text: 'Hello over HTTP' },
    })
    assert.equal(started.status, 201)
    const runId = String((started.json.run as Record<string, unknown>).id)

    // Poll until completed
    let status = ''
    for (let i = 0; i < 40; i += 1) {
      const getRes = await daemonRequest(address, token, `/runs/${runId}`)
      status = String(getRes.json.status)
      if (isTerminalStatus(status as 'completed')) break
      await new Promise((r) => setTimeout(r, 30))
    }
    assert.equal(status, 'completed')

    const evts = await daemonRequest(address, token, `/runs/${runId}/events?afterSeq=0`)
    assert.equal(evts.status, 200)
    assert.ok(Array.isArray(evts.json.events) && evts.json.events.length >= 3)

    const msgs = await daemonRequest(address, token, `/sessions/${sessionId}/messages`)
    assert.equal(msgs.status, 200)
    assert.equal((msgs.json.messages as unknown[]).length, 2)
  } finally {
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Phase 2A hardening: idempotency conflict, active-run bot archival guard, single-daemon lock, and idempotent reconciliation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-hardening-2a-'))
  const token = 'test-daemon-token-hardening-2a'
  const daemon1 = new GhostBotDaemon({
    authToken: token,
    port: 0,
    dataDir: dir,
    runtimeMode: 'mock',
  })
  const daemon2 = new GhostBotDaemon({
    authToken: token,
    port: 0,
    dataDir: dir,
    runtimeMode: 'mock',
  })
  try {
    const { address } = await daemon1.start()

    // 1. Second daemon on same dataDir fails closed with DAEMON_ALREADY_RUNNING
    await assert.rejects(() => daemon2.start(), /already owns/)

    const created = await daemonRequest(address, token, '/sessions', {
      method: 'POST',
      body: { agentId: 'chief', title: 'Hardening Session' },
    })
    assert.equal(created.status, 201)
    const sessionId = String(created.json.id)

    // 2. Start a slow run, verify idempotency conflict on different text, and bot archival block
    const s1 = await daemonRequest(address, token, '/runs', {
      method: 'POST',
      body: { sessionId, idempotencyKey: 'hard-key-1', text: 'slow-cancel test prompt' },
    })
    assert.equal(s1.status, 201)
    const runId = String((s1.json.run as Record<string, unknown>).id)

    const conflict = await daemonRequest(address, token, '/runs', {
      method: 'POST',
      body: { sessionId, idempotencyKey: 'hard-key-1', text: 'different prompt payload' },
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT')

    const deleteDuringRun = await daemonRequest(address, token, '/bots/chief', {
      method: 'DELETE',
    })
    assert.equal(deleteDuringRun.status, 409)
    assert.equal(deleteDuringRun.json.code, 'ACTIVE_RUN_EXISTS')

    // Wrong-run approval resolution fails with 404
    const wrongApproval = await daemonRequest(address, token, `/runs/${runId}/approval`, {
      method: 'POST',
      body: { approvalId: 'nonexistent', decision: 'approved' },
    })
    assert.equal(wrongApproval.status, 404)

    const cancelled = await daemonRequest(address, token, `/runs/${runId}/cancel`, {
      method: 'POST',
    })
    assert.equal(cancelled.status, 200)

    for (let i = 0; i < 40; i += 1) {
      const r = await daemonRequest(address, token, `/runs/${runId}`)
      if (isTerminalStatus(String(r.json.status) as 'cancelled')) break
      await new Promise((res) => setTimeout(res, 25))
    }

    await daemon1.stop()

    // 3. After daemon1 stops, daemon2 can acquire lock and reconcileOnStartup is idempotent
    const { address: addr2 } = await daemon2.start()
    const runAfterRestart = await daemonRequest(addr2, token, `/runs/${runId}`)
    assert.equal(runAfterRestart.status, 200)
    assert.equal(runAfterRestart.json.status, 'cancelled')
    await daemon2.stop()

    // 4. Stale daemon.lock from a dead PID + uncommitted run_events reconstruction
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(dir, 'daemon.lock'),
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    )
    const dbCheck = await openGhostBotDatabase(dir)
    const nowIso = new Date().toISOString()
    dbCheck.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at)
         VALUES ('run-unflushed', ?, 'chief', 'idem-unflushed', 'mock', 'mock-fast', 'medium', 'ask-approval', '{}', 'running', NULL, ?, NULL, ?)`,
      )
      .run(sessionId, nowIso, nowIso)
    dbCheck.sqlite
      .prepare(
        `INSERT INTO messages (id, session_id, role, content_json, seq_order, status, created_at, updated_at, run_id)
         VALUES ('msg-unflushed', ?, 'assistant', '{"text":""}', 99, 'streaming', ?, ?, 'run-unflushed')`,
      )
      .run(sessionId, nowIso, nowIso)
    const evtStore = new RunEventStore(dbCheck)
    evtStore.appendEvent('run-unflushed', {
      eventKey: 'delta:1',
      type: 'message.delta',
      payload: { delta: 'Committed before crash' },
    })
    dbCheck.close()

    const daemon3 = new GhostBotDaemon({
      authToken: token,
      port: 0,
      dataDir: dir,
      runtimeMode: 'mock',
    })
    const { address: addr3 } = await daemon3.start()
    const msgsAfterCrash = await daemonRequest(addr3, token, `/sessions/${sessionId}/messages`)
    const reconstructed = (msgsAfterCrash.json.messages as Array<{ id: string; text: string; status: string }>).find(
      (m) => m.id === 'msg-unflushed',
    )
    assert.equal(reconstructed?.status, 'interrupted')
    assert.equal(reconstructed?.text, 'Committed before crash')
    await daemon3.stop()
  } finally {
    await daemon1.stop().catch(() => undefined)
    await daemon2.stop().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})
