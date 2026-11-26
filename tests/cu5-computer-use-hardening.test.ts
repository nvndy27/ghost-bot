import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { BwrapIsolatedBrowserWorker } from '../packages/computer-use/src/browser/bwrap-browser-worker.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { ComputerUseService } from '../apps/daemon/src/computer-use/service.ts'

test('CU.5 hardening: emergency stop during worker startup and 2 FPS bounded backpressure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-cu5-h-'))
  chmodSync(dir, 0o700)
  const db = await openGhostBotDatabase(dir)
  try {
    seedInitialBotsIfNeeded(db)
    const botRepo = new BotRepository(db)
    const policyBroker = new RuntimePolicyBroker()
    const bundledWorker = resolve('apps/desktop/dist-daemon/computer-use-worker.mjs')

    let releaseStart!: () => void
    const startGate = new Promise<void>((r) => (releaseStart = r))

    const slowService = new ComputerUseService(db, botRepo, policyBroker, {
      createWorker: () => {
        const w = new BwrapIsolatedBrowserWorker({ workerScriptPath: bundledWorker })
        const origStart = w.start.bind(w)
        w.start = async () => {
          await startGate
          return origStart()
        }
        return w
      },
    })

    const bot = botRepo.listBots().bots[0]!
    const createPromise = slowService.createSession({
      botId: bot.id,
      explicitConsent: true,
      allowObservation: true,
      allowNavigation: true,
      allowInteraction: true,
      allowedOrigins: ['http://127.0.0.1'],
    })

    await new Promise((r) => setTimeout(r, 30))
    const sessRow = db.sqlite
      .prepare(`SELECT id FROM cu_sessions ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string }
    const stopRes = await slowService.emergencyStop(sessRow.id, 'Stop during startup')
    assert.equal(stopRes.confirmed, true)
    releaseStart()
    await assert.rejects(() => createPromise, { code: 'CU_EMERGENCY_STOPPED' })
    assert.equal(slowService.getSession(sessRow.id).state, 'emergency_stopped')

    // Verify 2 FPS rate limiting / backpressure on an active session
    const normalService = new ComputerUseService(db, botRepo, policyBroker, {
      createWorker: () => new BwrapIsolatedBrowserWorker({ workerScriptPath: bundledWorker }),
    })
    const activeSess = await normalService.createSession({
      botId: bot.id,
      explicitConsent: true,
      allowObservation: true,
      allowNavigation: false,
      allowInteraction: false,
      allowedOrigins: ['http://127.0.0.1'],
    })
    const obs1 = await normalService.observeTab(activeSess.id, activeSess.activeTabId!)
    const obs2 = await normalService.observeTab(activeSess.id, activeSess.activeTabId!)
    assert.equal(obs1.viewerFrame.frameSeq, 1)
    assert.equal(obs2.viewerFrame.frameSeq, 1)
    assert.ok(obs2.viewerFrame.backpressureDropCount >= 1)
    await normalService.shutdownAll()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
