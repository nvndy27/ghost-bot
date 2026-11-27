import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { BwrapIsolatedBrowserWorker } from '../packages/computer-use/src/browser/bwrap-browser-worker.ts'
import {
  ComputerUseCapabilitiesDtoSchema,
  ComputerUseSessionDtoSchema,
  CreateComputerUseSessionInputSchema,
  ExecuteComputerUseActionInputSchema,
} from '../packages/shared-types/ipc.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { ComputerUseService } from '../apps/daemon/src/computer-use/service.ts'

async function setupCuEnv(options: { workerScriptPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-cu4-'))
  chmodSync(dir, 0o700)
  const db = await openGhostBotDatabase(dir)
  seedInitialBotsIfNeeded(db)
  const botRepo = new BotRepository(db)
  const sessionRepo = new SessionRepository(db)
  const policyBroker = new RuntimePolicyBroker()
  const cuService = new ComputerUseService(db, botRepo, policyBroker, {
    createWorker: () => new BwrapIsolatedBrowserWorker({ workerScriptPath: options.workerScriptPath }),
  })
  const bots = botRepo.listBots().bots
  const bot = bots[0]!
  const otherBot = bots[1]!
  const chatSess = sessionRepo.createSession({ agentId: bot.id, title: 'CU.4 Test Session' })
  const nowIso = new Date().toISOString()
  const runId = `run_cu4_${Date.now()}`
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, session_id, agent_id, idempotency_key, status, permission_mode, runtime_id, model_id, effort, config_snapshot_json, started_at, created_at)
       VALUES (?, ?, ?, ?, 'running', 'ask-approval', 'mock', 'gpt-5.4-mini', 'medium', '{}', ?, ?)`,
    )
    .run(runId, chatSess.id, bot.id, `idem_${runId}`, nowIso, nowIso)
  return { dir, db, botRepo, sessionRepo, policyBroker, cuService, bot, otherBot, runId }
}

test('CU.4 capabilities, policy authorization boundaries, and disabled virtual desktop capabilities', async () => {
  const env = await setupCuEnv()
  try {
    const caps = await env.cuService.getCapabilities()
    ComputerUseCapabilitiesDtoSchema.parse(caps)
    assert.equal(caps.liveModelDrivenEnabled, false)
    assert.equal(caps.hostDesktopControlSupported, false)
    assert.equal(caps.virtualDesktop.frameCaptureSupported, false)
    assert.equal(caps.virtualDesktop.inputInjectionSupported, false)
    assert.equal(caps.virtualDesktop.hostDesktopIsolated, true)
    assert.equal(caps.browser.sandboxed, true)

    // Inherited consent from Teams/Scheduler must be rejected
    await assert.rejects(
      () =>
        env.cuService.createSession({
          botId: env.bot.id,
          runId: env.runId,
          explicitConsent: true,
          inheritedFromTeamOrRoutine: true,
          allowObservation: true,
          allowNavigation: false,
          allowInteraction: false,
          allowedOrigins: ['http://127.0.0.1'],
        }),
      { code: 'CU_INHERITED_CONSENT_FORBIDDEN' },
    )

    // Missing explicit consent must be rejected
    await assert.rejects(
      () =>
        env.cuService.createSession({
          botId: env.bot.id,
          runId: env.runId,
          explicitConsent: false,
          allowObservation: true,
          allowNavigation: false,
          allowInteraction: false,
          allowedOrigins: ['http://127.0.0.1'],
        }),
      { code: 'CU_CONSENT_REQUIRED' },
    )

    // Live model-driven Computer Use must be rejected
    await assert.rejects(
      () =>
        env.cuService.createSession({
          botId: env.bot.id,
          runId: env.runId,
          explicitConsent: true,
          allowObservation: true,
          allowNavigation: false,
          allowInteraction: false,
          allowedOrigins: ['http://127.0.0.1'],
          liveModelDriven: true,
        }),
      { code: 'LIVE_MODEL_DRIVEN_CU_DISABLED' },
    )

    // Mismatched bot/run must be rejected
    await assert.rejects(
      () =>
        env.cuService.createSession({
          botId: env.otherBot.id,
          runId: env.runId,
          explicitConsent: true,
          allowObservation: true,
          allowNavigation: false,
          allowInteraction: false,
          allowedOrigins: ['http://127.0.0.1'],
        }),
      { code: 'CU_RUN_MISMATCH' },
    )

    // Strict IPC schemas reject unknown fields
    assert.throws(() =>
      CreateComputerUseSessionInputSchema.parse({
        botId: env.bot.id,
        runId: env.runId,
        explicitConsent: true,
        allowObservation: true,
        allowNavigation: false,
        allowInteraction: false,
        allowedOrigins: [],
        bypassSandbox: true,
      }),
    )
    assert.throws(() =>
      ExecuteComputerUseActionInputSchema.parse({
        sessionId: 'cus_1',
        approvalId: 'cuapp_1',
        observationId: 'obs_1',
        navigationGeneration: 0,
        action: { actionId: 'a1', kind: 'navigate', tabId: 'tab_1', url: 'http://127.0.0.1', extra: 1 },
      }),
    )
  } finally {
    await env.cuService.shutdownAll()
    env.db.close()
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('CU.4 bundled worker E2E: isolated browser observation, single-use approval, stale/expiry/duplicate rejection, and emergency stop', async () => {
  const bundledWorker = resolve('apps/desktop/dist-daemon/computer-use-worker.mjs')
  const env = await setupCuEnv({ workerScriptPath: bundledWorker })
  try {
    const session = await env.cuService.createSession({
      botId: env.bot.id,
      runId: env.runId,
      explicitConsent: true,
      allowObservation: true,
      allowNavigation: true,
      allowInteraction: true,
      allowedOrigins: ['http://127.0.0.1'],
    })
    ComputerUseSessionDtoSchema.parse(session)
    assert.equal(session.state, 'active')
    assert.ok(session.workerPid && session.workerPid > 0)
    assert.ok(session.activeTabId)

    // Observe initial about:blank tab (returns bounded PNG; raw PNG is NOT stored in SQLite)
    const obs1 = await env.cuService.observeTab(session.id, session.activeTabId!)
    assert.equal(obs1.mimeType, 'image/png')
    assert.ok(obs1.byteLength > 0)
    assert.equal(obs1.viewerFrame.frameSeq, 1)
    assert.equal(obs1.viewerFrame.stale, false)

    // Request approval for action with stale observation -> rejected
    assert.throws(
      () =>
        env.cuService.requestActionApproval({
          sessionId: session.id,
          tabId: session.activeTabId!,
          observationId: 'obs_stale_999',
          navigationGeneration: obs1.navigationGeneration,
          action: {
            actionId: 'act_stale',
            kind: 'click_point',
            tabId: session.activeTabId!,
            x: 10,
            y: 10,
          },
        }),
      { code: 'CU_STALE_OBSERVATION' },
    )

    // Request & approve type_text action (verifying secret redaction in ledger)
    const typeAction = {
      actionId: 'act_type_1',
      kind: 'type_text' as const,
      tabId: session.activeTabId!,
      selector: '#secret-input',
      text: 'super-secret-password-123',
      observationId: obs1.observationId,
      navigationGeneration: obs1.navigationGeneration,
    }
    const app1 = env.cuService.requestActionApproval({
      sessionId: session.id,
      tabId: session.activeTabId!,
      observationId: obs1.observationId,
      navigationGeneration: obs1.navigationGeneration,
      action: typeAction,
    })
    // Duplicate actionId must be rejected
    assert.throws(
      () =>
        env.cuService.requestActionApproval({
          sessionId: session.id,
          tabId: session.activeTabId!,
          observationId: obs1.observationId,
          navigationGeneration: obs1.navigationGeneration,
          action: typeAction,
        }),
      { code: 'CU_DUPLICATE_ACTION_ID' },
    )

    const resolved1 = env.cuService.resolveActionApproval(session.id, app1.id, 'approved')
    assert.equal(resolved1.status, 'approved')

    // Executing with mismatched navigationGeneration must reject
    await assert.rejects(
      () =>
        env.cuService.executeAction({
          sessionId: session.id,
          approvalId: app1.id,
          observationId: obs1.observationId,
          navigationGeneration: obs1.navigationGeneration + 99,
          action: typeAction,
        }),
      { code: 'CU_APPROVAL_BINDING_MISMATCH' },
    )

    // Execute approved action (fails selector lookup on about:blank or completes; either way consumes single-use approval and redacts text)
    await env.cuService.executeAction({
      sessionId: session.id,
      approvalId: app1.id,
      observationId: obs1.observationId,
      navigationGeneration: obs1.navigationGeneration,
      action: typeAction,
    })

    // Reusing single-use approval must be rejected
    await assert.rejects(
      () =>
        env.cuService.executeAction({
          sessionId: session.id,
          approvalId: app1.id,
          observationId: obs1.observationId,
          navigationGeneration: obs1.navigationGeneration,
          action: typeAction,
        }),
      { code: 'CU_APPROVAL_INVALID' },
    )

    // Ledger must NEVER contain raw typed text or base64 PNGs
    const ledger = env.cuService.listLedger(session.id)
    assert.ok(ledger.length >= 2)
    for (const entry of ledger) {
      assert.equal(entry.replayAllowed, false)
      assert.ok(!entry.sanitizedSummary.includes('super-secret-password-123'))
      assert.ok(!entry.sanitizedSummary.includes(obs1.imageBase64.slice(0, 32)))
    }

    // Emergency stop confirms process termination and revokes pending approvals
    const stopRes = await env.cuService.emergencyStop(session.id, 'CU.4 E2E emergency stop')
    assert.equal(stopRes.confirmed, true)
    assert.equal(stopRes.session.state, 'emergency_stopped')
  } finally {
    await env.cuService.shutdownAll()
    env.db.close()
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('CU.4 worker startup failure, restart reconciliation without replay, and bounded audit retention', async () => {
  const env = await setupCuEnv({ workerScriptPath: '/nonexistent/cu-worker.mjs' })
  try {
    // Missing worker must fail closed (never silently fall back to unisolated browser)
    await assert.rejects(
      () =>
        env.cuService.createSession({
          botId: env.bot.id,
          runId: env.runId,
          explicitConsent: true,
          allowObservation: true,
          allowNavigation: false,
          allowInteraction: false,
          allowedOrigins: [],
        }),
      { code: 'CU_WORKER_START_FAILED' },
    )

    // Simulate active session + pending approval left behind on daemon restart
    const nowIso = '2026-11-26T00:00:00.000Z'
    env.db.sqlite
      .prepare(
        `INSERT INTO cu_sessions (
          id, owner_id, bot_id, run_id, session_kind, state,
          allow_observation, allow_navigation, allow_interaction,
          allowed_origins_json, inherited_from_team_or_routine, created_at, updated_at
        ) VALUES ('cus_restart_1', 'local-user', ?, ?, 'isolated-browser', 'active', 1, 1, 1, '[]', 0, ?, ?)`,
      )
      .run(env.bot.id, env.runId, nowIso, nowIso)
    env.db.sqlite
      .prepare(
        `INSERT INTO cu_action_approvals (
          id, cu_session_id, owner_id, bot_id, run_id, tab_id, observation_id,
          navigation_generation, action_id, action_kind, action_hash, status, expires_at, created_at
        ) VALUES ('cuapp_restart_1', 'cus_restart_1', 'local-user', ?, ?, 'tab_1', 'obs_1', 0, 'act_r1', 'click_point', 'h1', 'approved', '2026-11-27T00:00:00.000Z', ?)`,
      )
      .run(env.bot.id, env.runId, nowIso)

    const rec = env.cuService.reconcileOnStartup()
    assert.equal(rec.interruptedSessions, 1)
    assert.equal(rec.revokedApprovals, 1)
    assert.equal(env.cuService.getSession('cus_restart_1').state, 'interrupted')

    // Bounded audit retention preserves uncertain records and prunes old completed records
    env.db.sqlite
      .prepare(
        `INSERT INTO cu_action_ledger (
          id, cu_session_id, owner_id, bot_id, run_id, action_kind, outcome_status,
          sanitized_summary, replay_allowed, created_at
        ) VALUES ('cul_old_ok', 'cus_restart_1', 'local-user', ?, ?, 'observe_tab', 'completed', 'old ok', 0, '2025-01-01T00:00:00.000Z')`,
      )
      .run(env.bot.id, env.runId)
    const pruned = env.cuService.pruneAuditRetention('2026-01-01T00:00:00.000Z')
    assert.equal(pruned, 1)
    const remaining = env.cuService.listLedger('cus_restart_1')
    assert.ok(remaining.some((e) => e.outcomeStatus === 'uncertain' && e.replayAllowed === false))
  } finally {
    await env.cuService.shutdownAll()
    env.db.close()
    rmSync(env.dir, { recursive: true, force: true })
  }
})
