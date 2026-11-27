import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
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
  const dir = mkdtempSync(join(tmpdir(), 'ghost-cu4-hardening-'))
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
  const chatSess = sessionRepo.createSession({ agentId: bot.id, title: 'CU4-RUN-01' })

  const insertRun = (id: string, status: string) => {
    const nowIso = new Date().toISOString()
    db.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, status, permission_mode, runtime_id, model_id, effort, config_snapshot_json, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'ask-approval', 'mock', 'gpt-5.4-mini', 'medium', '{}', ?, ?)`,
      )
      .run(id, chatSess.id, bot.id, `idem_${id}`, status, nowIso, nowIso)
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

async function socketRequest(
  socketPath: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolveReq, rejectReq) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
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
          const text = Buffer.concat(chunks).toString('utf8')
          resolveReq({
            status: res.statusCode ?? 0,
            json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
          })
        })
      },
    )
    req.on('error', rejectReq)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('CU4-RUN-01 & CU4-PKG-03: Hardening Acceptance Regression', () => {
  it('rejects session creation for non-active daemon run states (completed, failed, cancelled, interrupted, cancelling)', async () => {
    const env = await setupEnv()
    try {
      for (const badStatus of ['completed', 'failed', 'cancelled', 'interrupted', 'cancelling']) {
        const runId = `run_bad_${badStatus}`
        env.insertRun(runId, badStatus)
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

  it('revokes authority and blocks approved action execution when parent run is cancelled or bot/session is revoked', async () => {
    const env = await setupEnv()
    try {
      const runId = 'run_cancel_mid'
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
      const obs = await env.cuService.observeTab(sess.id, sess.activeTabId ?? undefined)
      const action = {
        actionId: 'act_after_run_cancel',
        kind: 'wait' as const,
        durationMs: 10,
      }
      const app = env.cuService.requestActionApproval({
        sessionId: sess.id,
        tabId: sess.activeTabId!,
        observationId: obs.observationId,
        navigationGeneration: obs.navigationGeneration,
        action,
      })
      env.cuService.resolveActionApproval(sess.id, app.id, 'approved')

      // Parent daemon run is cancelled before action execution
      env.db.sqlite.prepare(`UPDATE runs SET status = 'cancelled' WHERE id = ?`).run(runId)

      await assert.rejects(
        () =>
          env.cuService.executeAction({
            sessionId: sess.id,
            approvalId: app.id,
            observationId: obs.observationId,
            navigationGeneration: obs.navigationGeneration,
            action,
          }),
        { code: 'CU_RUN_NOT_ACTIVE' },
      )

      // Session and approval must now be revoked / stopped
      const updatedSess = env.cuService.getSession(sess.id)
      assert.equal(updatedSess.state, 'emergency_stopped')
      const updatedApp = env.cuService.listApprovals(sess.id).find((a) => a.id === app.id)
      assert.equal(updatedApp?.status, 'revoked')
    } finally {
      await env.cleanup()
    }
  })

  it('starts packaged dist-daemon/daemon.mjs without createRequire SyntaxError and runs authenticated CU flow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-cu4-pkg-daemon-'))
    chmodSync(dir, 0o700)
    const socketPath = join(dir, 'daemon.sock')
    const token = 'test-packaged-daemon-token'
    const daemonScript = resolve(process.cwd(), 'apps/desktop/dist-daemon/daemon.mjs')

    const child = spawn(process.execPath, [daemonScript], {
      env: {
        ...process.env,
        GHOST_BOT_DAEMON_TOKEN: token,
        GHOST_BOT_DAEMON_SOCKET: socketPath,
        GHOST_BOT_DATA_DIR: dir,
        GHOST_BOT_RUNTIME_MODE: 'mock',
        GHOST_CU_ENABLE_TEST_FIXTURE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => {
          rejectReady(new Error(`Packaged daemon startup timeout. stderr=${stderr}`))
        }, 15_000)
        let stdoutBuf = ''
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf8')
          for (const line of stdoutBuf.split('\n')) {
            if (line.includes('"daemon.ready"')) {
              clearTimeout(timer)
              resolveReady()
              return
            }
          }
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          rejectReady(new Error(`Packaged daemon exited early (${code}). stderr=${stderr}`))
        })
      })

      const caps = await socketRequest(socketPath, token, 'GET', '/computer-use/capabilities')
      assert.equal(caps.status, 200)
      const browserCaps = caps.json.browser as { sandboxed: boolean; executablePath: string | null }
      assert.equal(browserCaps.sandboxed, true)
      assert.ok(browserCaps.executablePath)

      const botsRes = await socketRequest(socketPath, token, 'GET', '/bots')
      assert.equal(botsRes.status, 200)
      const bots = botsRes.json.bots as Array<{ id: string }>
      const botId = bots[0]!.id

      const fixturePort = 46311
      const origin = `http://127.0.0.1:${fixturePort}`
      const createRes = await socketRequest(socketPath, token, 'POST', '/computer-use/sessions', {
        botId,
        explicitConsent: true,
        inheritedFromTeamOrRoutine: false,
        allowObservation: true,
        allowNavigation: true,
        allowInteraction: true,
        allowedOrigins: [origin],
      })
      assert.equal(createRes.status, 201)
      const sessionId = String(createRes.json.id)
      const activeTabId = String(createRes.json.activeTabId)

      const fixRes = await socketRequest(
        socketPath,
        token,
        'POST',
        `/computer-use/sessions/${sessionId}/test-fixture`,
        {
          port: fixturePort,
          routes: {
            '/': '<html><body><h1>Packaged Daemon CU</h1></body></html>',
          },
        },
      )
      assert.equal(fixRes.status, 200)
      const baseUrl = String(fixRes.json.baseUrl)

      const obs0 = await socketRequest(
        socketPath,
        token,
        'POST',
        `/computer-use/sessions/${sessionId}/observe`,
        { tabId: activeTabId },
      )
      assert.equal(obs0.status, 200)

      const navAction = {
        actionId: 'act_pkg_nav_1',
        kind: 'navigate',
        tabId: activeTabId,
        url: `${baseUrl}/`,
      }
      const reqApp = await socketRequest(
        socketPath,
        token,
        'POST',
        `/computer-use/sessions/${sessionId}/approvals`,
        {
          tabId: activeTabId,
          observationId: obs0.json.observationId,
          navigationGeneration: obs0.json.navigationGeneration,
          action: navAction,
        },
      )
      assert.equal(reqApp.status, 201)

      const resApp = await socketRequest(
        socketPath,
        token,
        'POST',
        `/computer-use/sessions/${sessionId}/approvals/${String(reqApp.json.id)}/resolve`,
        { decision: 'approved' },
      )
      assert.equal(resApp.status, 200)

      const execNav = await socketRequest(
        socketPath,
        token,
        'POST',
        `/computer-use/sessions/${sessionId}/actions`,
        {
          approvalId: reqApp.json.id,
          observationId: obs0.json.observationId,
          navigationGeneration: obs0.json.navigationGeneration,
          action: navAction,
        },
      )
      assert.equal(execNav.status, 200)
      assert.equal(execNav.json.outcomeStatus, 'completed')

      const obs1 = await socketRequest(
        socketPath,
        token,
        'POST',
        `/computer-use/sessions/${sessionId}/observe`,
        { tabId: activeTabId },
      )
      assert.equal(obs1.status, 200)
      assert.equal(obs1.json.mimeType, 'image/png')
      assert.ok(Number(obs1.json.byteLength) > 0)

      const stopRes = await socketRequest(
        socketPath,
        token,
        'POST',
        `/computer-use/sessions/${sessionId}/emergency-stop`,
        { reason: 'Packaged daemon test stop' },
      )
      assert.equal(stopRes.status, 200)
      assert.equal(stopRes.json.confirmed, true)
    } finally {
      try {
        // The process may already have exited during startup (e.g. missing bundle).
        // Register before signalling and bound cleanup even if termination stalls.
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolveStop, rejectStop) => {
            const onExit = () => {
              clearTimeout(forceTimer)
              clearTimeout(deadline)
              resolveStop()
            }
            const forceTimer = setTimeout(() => child.kill('SIGKILL'), 3_000)
            const deadline = setTimeout(() => {
              child.removeListener('exit', onExit)
              clearTimeout(forceTimer)
              rejectStop(new Error('Packaged daemon did not exit during test cleanup'))
            }, 6_000)
            child.once('exit', onExit)
            child.kill('SIGTERM')
          })
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})
