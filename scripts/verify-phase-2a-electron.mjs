import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2a-e2e-'))
const codexDataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2a-codex-'))

async function launchDesktop(runtimeMode, dir) {
  return electron.launch({
    executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
    args: [join(desktopDir, 'dist-electron', 'main.js')],
    cwd: desktopDir,
    env: {
      ...process.env,
      GHOST_BOT_DATA_DIR: dir,
      GHOST_BOT_RUNTIME_MODE: runtimeMode,
      GHOST_BOT_SMOKE_EXIT: '0',
    },
  })
}

try {
  // Launch 1: Real Electron + Daemon + SQLite in mock mode
  let sessionId = ''
  const app1 = await launchDesktop('mock', dataDir)
  try {
    const page = await app1.firstWindow()
    await page.waitForSelector('text=Chief of Staff')

    // 1. Send normal prompt -> wait for daemon-owned mock runtime completion
    const composer = page.getByLabel('Message Chief of Staff')
    await composer.fill('Hello Phase 2A persistence')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('text=daemon-owned Mock Runtime', { timeout: 8000 })

    // 1b. Verify idempotency retry with same key deduplicates and different text returns conflict
    const idemCheck = await page.evaluate(async () => {
      const bots = await window.ghostBot.listBots()
      const sessions = await window.ghostBot.listSessions({ agentId: bots.bots[0].id })
      const sid = sessions.activeSessionId
      const r1 = await window.ghostBot.startRun({
        sessionId: sid,
        idempotencyKey: 'e2e-idem-1',
        text: 'Idempotency probe',
      })
      const r2 = await window.ghostBot.startRun({
        sessionId: sid,
        idempotencyKey: 'e2e-idem-1',
        text: 'Idempotency probe',
      })
      let conflictBlocked = false
      try {
        await window.ghostBot.startRun({
          sessionId: sid,
          idempotencyKey: 'e2e-idem-1',
          text: 'Different payload',
        })
      } catch {
        conflictBlocked = true
      }
      return { sameRunId: r1.run.id === r2.run.id, deduplicated: r2.deduplicated, conflictBlocked }
    })
    assert.equal(idemCheck.sameRunId, true)
    assert.equal(idemCheck.deduplicated, true)
    assert.equal(idemCheck.conflictBlocked, true)
    await page.waitForTimeout(350)

    // 2. Create a new conversation, test cancel, and verify approval flow
    await page.getByRole('button', { name: 'New conversation' }).click()
    await page.waitForTimeout(200)
    await composer.fill('Run slow-cancel test')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('button[aria-label="Stop generation"]', { timeout: 5000 })
    await page.getByRole('button', { name: 'Stop generation' }).click()
    await page.waitForSelector('text=Cancelled', { timeout: 5000 })

    await composer.fill('Second conversation approval check')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('text=Approve simulated workspace write', { timeout: 8000 })

    // Approve simulated action
    await page.getByRole('button', { name: 'Approve' }).click()
    await page.waitForSelector('text=Approval granted', { timeout: 8000 })

    // 3. Start a disconnect/hanging run so it is active when app1 closes (crash recovery test)
    await composer.fill('Simulate disconnect mid-run')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('text=Streaming partial output before simulated daemon disconnect', {
      timeout: 8000,
    })

    sessionId = await page.getByLabel('Conversation session').inputValue()
    assert.ok(sessionId.length > 0, 'Active session id should be non-empty')
  } finally {
    await app1.close()
  }

  // Launch 2: Restart Electron + Daemon against same SQLite DB -> verify persistence + interrupted recovery
  const app2 = await launchDesktop('mock', dataDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('text=Chief of Staff')
    await page.waitForSelector('text=Approval granted', { timeout: 8000 })
    await page.waitForSelector('text=Interrupted', { timeout: 8000 })
  } finally {
    await app2.close()
  }

  // Verify SQLite directly: sessions, runs, run_events, messages persisted cleanly
  const db = new DatabaseSync(join(dataDir, 'ghost-bot.sqlite'))
  try {
    const runCount = db.prepare('SELECT COUNT(*) AS cnt FROM runs').get().cnt
    const evtCount = db.prepare('SELECT COUNT(*) AS cnt FROM run_events').get().cnt
    const msgCount = db.prepare('SELECT COUNT(*) AS cnt FROM messages').get().cnt
    const interruptedCount = db
      .prepare(`SELECT COUNT(*) AS cnt FROM runs WHERE status = 'interrupted'`)
      .get().cnt

    assert.ok(Number(runCount) >= 3, `Expected >=3 runs, got ${runCount}`)
    assert.ok(Number(evtCount) >= 10, `Expected >=10 run_events, got ${evtCount}`)
    assert.ok(Number(msgCount) >= 6, `Expected >=6 messages, got ${msgCount}`)
    assert.equal(Number(interruptedCount), 1, 'Expected exactly 1 interrupted run after restart')
  } finally {
    db.close()
  }

  // Launch 3: Codex mode still blocks live inference in Phase 2A
  const appCodex = await launchDesktop('codex', codexDataDir)
  try {
    const page = await appCodex.firstWindow()
    await page.waitForSelector('text=Chief of Staff')
    const res = await page.evaluate(async () => {
      const bots = await window.ghostBot.listBots()
      const sessions = await window.ghostBot.listSessions({ agentId: bots.bots[0].id })
      const sessId =
        sessions.sessions[0]?.id ??
        (await window.ghostBot.createSession({ agentId: bots.bots[0].id })).id
      // Switch bot runtimeId is 'codex' or 'mock'? Default seeded chief is 'mock', update to 'codex'
      await window.ghostBot.updateBot({ id: bots.bots[0].id, patch: { runtimeId: 'codex' } })
      try {
        await window.ghostBot.startRun({
          sessionId: sessId,
          idempotencyKey: 'e2e-codex-block',
          text: 'Should block live inference',
        })
        return { blocked: false }
      } catch (err) {
        return { blocked: true, message: err instanceof Error ? err.message : String(err) }
      }
    })
    assert.equal(res.blocked, true, 'Historical mock session must not run live Codex inference')
    assert.match(res.message, /historical mock session|Live AI inference/)
  } finally {
    await appCodex.close()
  }

  console.log('Phase 2A Electron + Daemon + SQLite E2E verification passed.')
} finally {
  await rm(dataDir, { recursive: true, force: true })
  await rm(codexDataDir, { recursive: true, force: true })
}
