import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { BwrapIsolatedBrowserWorker } from '../packages/computer-use/src/browser/bwrap-browser-worker.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { ComputerUseService } from '../apps/daemon/src/computer-use/service.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'

async function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-cu6-accept-'))
  chmodSync(dir, 0o700)
  const db = await openGhostBotDatabase(dir)
  seedInitialBotsIfNeeded(db)
  const botRepo = new BotRepository(db)
  const sessionRepo = new SessionRepository(db)
  const policyBroker = new RuntimePolicyBroker()
  const workerScriptPath = resolve(
    process.cwd(),
    'apps/desktop/dist-daemon/computer-use-worker.mjs',
  )
  const cuService = new ComputerUseService(db, botRepo, policyBroker, {
    createWorker: () => new BwrapIsolatedBrowserWorker({ workerScriptPath }),
  })
  const bot = botRepo.listBots().bots[0]!
  const chatSess = sessionRepo.createSession({ agentId: bot.id, title: 'CU6-ACCEPT' })

  const insertRun = (id: string, status: string, agentId = bot.id, sessionId = chatSess.id) => {
    const nowIso = new Date().toISOString()
    db.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, status, permission_mode, runtime_id, model_id, effort, config_snapshot_json, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'ask-approval', 'mock', 'gpt-5.4-mini', 'medium', '{}', ?, ?)`,
      )
      .run(id, sessionId, agentId, `idem_${id}`, status, nowIso, nowIso)
  }

  return {
    dir,
    db,
    botRepo,
    sessionRepo,
    cuService,
    bot,
    chatSess,
    insertRun,
    async cleanup() {
      await cuService.shutdownAll()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('CU.6 Production Acceptance: Run Lifecycle, Authority Revocation, Bounds & Unconfirmed Termination', () => {
  it('rejects queued and awaiting_approval parent runs so they cannot bypass execution or approval boundaries', async () => {
    const env = await setupEnv()
    try {
      for (const nonRunningStatus of ['queued', 'awaiting_approval']) {
        const runId = `run_${nonRunningStatus}`
        env.insertRun(runId, nonRunningStatus)
        await assert.rejects(
          () =>
            env.cuService.createSession({
              botId: env.bot.id,
              runId,
              explicitConsent: true,
              allowObservation: true,
              allowNavigation: false,
              allowInteraction: true,
              allowedOrigins: ['http://127.0.0.1'],
            }),
          { code: 'CU_RUN_NOT_ACTIVE' },
        )
      }
    } finally {
      await env.cleanup()
    }
  })

  it('revokes active session authority on permission downgrade to read-only or parent session archival', async () => {
    const env = await setupEnv()
    try {
      const runId = 'run_perm_downgrade'
      env.insertRun(runId, 'running')
      const sess = await env.cuService.createSession({
        botId: env.bot.id,
        runId,
        explicitConsent: true,
        allowObservation: true,
        allowNavigation: false,
        allowInteraction: true,
        allowedOrigins: ['http://127.0.0.1'],
      })
      const obs = await env.cuService.observeTab(sess.id, sess.activeTabId!)
      const action = { actionId: 'act_perm_check', kind: 'wait' as const, durationMs: 10 }
      const app = env.cuService.requestActionApproval({
        sessionId: sess.id,
        tabId: sess.activeTabId!,
        observationId: obs.observationId,
        navigationGeneration: obs.navigationGeneration,
        action,
      })
      env.cuService.resolveActionApproval(sess.id, app.id, 'approved')

      // Downgrade bot permission to read-only while CU session is active
      env.db.sqlite.prepare(`UPDATE agents SET permission_mode = 'read-only' WHERE id = ?`).run(env.bot.id)

      await assert.rejects(
        () =>
          env.cuService.executeAction({
            sessionId: sess.id,
            approvalId: app.id,
            observationId: obs.observationId,
            navigationGeneration: obs.navigationGeneration,
            action,
          }),
        { code: 'CU_READ_ONLY_BLOCKS_MUTATION' },
      )
      assert.equal(env.cuService.getSession(sess.id).state, 'emergency_stopped')

      // Also verify parent session archival blocks creation/execution
      env.db.sqlite.prepare(`UPDATE agents SET permission_mode = 'ask-approval' WHERE id = ?`).run(env.bot.id)
      env.db.sqlite.prepare(`UPDATE sessions SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(env.chatSess.id)
      env.insertRun('run_arch_sess', 'running')
      await assert.rejects(
        () =>
          env.cuService.createSession({
            botId: env.bot.id,
            runId: 'run_arch_sess',
            explicitConsent: true,
            allowObservation: true,
            allowNavigation: false,
            allowInteraction: false,
            allowedOrigins: ['http://127.0.0.1'],
          }),
        { code: 'CU_RUN_SESSION_ARCHIVED' },
      )
    } finally {
      await env.cleanup()
    }
  })

  it('preserves uncertain outcome and interrupted state when emergencyStop termination cannot be confirmed, and blocks late callbacks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-cu6-unconf-'))
    chmodSync(dir, 0o700)
    const db = await openGhostBotDatabase(dir)
    const realStops: Array<() => Promise<unknown>> = []
    try {
      seedInitialBotsIfNeeded(db)
      const botRepo = new BotRepository(db)
      const policyBroker = new RuntimePolicyBroker()
      const workerScriptPath = resolve(
        process.cwd(),
        'apps/desktop/dist-daemon/computer-use-worker.mjs',
      )

      let releaseBatch!: () => void
      const batchGate = new Promise<void>((r) => (releaseBatch = r))

      const svc = new ComputerUseService(db, botRepo, policyBroker, {
        createWorker: () => {
          const w = new BwrapIsolatedBrowserWorker({ workerScriptPath })
          const origExec = w.executeBatch.bind(w)
          const origStop = w.emergencyStop.bind(w)
          realStops.push(origStop)
          w.executeBatch = async (batch) => {
            await batchGate
            return origExec(batch).catch(() => ({
              batchId: batch.batchId,
              entries: [{ actionId: batch.actions[0]!.actionId, status: 'completed', navigationGeneration: 99 }],
            }))
          }
          w.emergencyStop = async () => ({ confirmed: false })
          return w
        },
      })

      const bot = botRepo.listBots().bots[0]!
      const sess = await svc.createSession({
        botId: bot.id,
        explicitConsent: true,
        allowObservation: true,
        allowNavigation: false,
        allowInteraction: true,
        allowedOrigins: ['http://127.0.0.1'],
      })
      const obs = await svc.observeTab(sess.id, sess.activeTabId!)
      const action = { actionId: 'act_inflight_unconf', kind: 'wait' as const, durationMs: 10 }
      const app = svc.requestActionApproval({
        sessionId: sess.id,
        tabId: sess.activeTabId!,
        observationId: obs.observationId,
        navigationGeneration: obs.navigationGeneration,
        action,
      })
      svc.resolveActionApproval(sess.id, app.id, 'approved')

      const execPromise = svc.executeAction({
        sessionId: sess.id,
        approvalId: app.id,
        observationId: obs.observationId,
        navigationGeneration: obs.navigationGeneration,
        action,
      })

      await new Promise((r) => setTimeout(r, 30))
      const stopRes = await svc.emergencyStop(sess.id, 'Unconfirmed stop test')
      assert.equal(stopRes.confirmed, false)
      assert.equal(stopRes.session.state, 'interrupted')

      releaseBatch()
      const lateResult = await execPromise
      assert.equal(lateResult.outcomeStatus, 'uncertain')
      assert.equal(lateResult.errorCode, 'CU_EMERGENCY_STOPPED')

      const ledger = svc.listLedger(sess.id)
      assert.ok(ledger.some((l) => l.actionKind === 'action.emergency_interrupted' && l.outcomeStatus === 'uncertain' && l.replayAllowed === false))
      assert.ok(!ledger.some((l) => l.actionId === 'act_inflight_unconf' && l.outcomeStatus === 'completed'))
    } finally {
      for (const stop of realStops) {
        await stop().catch(() => {})
      }
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces bounded active sessions (MAX_ACTIVE_CU_SESSIONS=4) and blocks inherited/unconsented creation', async () => {
    const env = await setupEnv()
    try {
      await assert.rejects(
        () =>
          env.cuService.createSession({
            botId: env.bot.id,
            explicitConsent: true,
            inheritedFromTeamOrRoutine: true,
            allowObservation: true,
            allowNavigation: false,
            allowInteraction: false,
            allowedOrigins: ['http://127.0.0.1'],
          }),
        { code: 'CU_INHERITED_CONSENT_FORBIDDEN' },
      )

      for (let i = 0; i < 4; i++) {
        await env.cuService.createSession({
          botId: env.bot.id,
          explicitConsent: true,
          allowObservation: true,
          allowNavigation: false,
          allowInteraction: false,
          allowedOrigins: ['http://127.0.0.1'],
        })
      }

      await assert.rejects(
        () =>
          env.cuService.createSession({
            botId: env.bot.id,
            explicitConsent: true,
            allowObservation: true,
            allowNavigation: false,
            allowInteraction: false,
            allowedOrigins: ['http://127.0.0.1'],
          }),
        { code: 'CU_SESSION_LIMIT_REACHED' },
      )
    } finally {
      await env.cleanup()
    }
  })
})
