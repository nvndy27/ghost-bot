/**
 * Opt-in Real Electron + Daemon + Codex 0.172.0 Live Verification Script (Phase 2B).
 * Strictly enforces a maximum budget of 3 attempted inference turns on the authorized
 * ChatGPT subscription profile, exclusively for Phase 2B verification.
 * MUST NOT run in default `pnpm test`. Requires explicit `GHOST_BOT_RUN_LIVE_CODEX=1`.
 */
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

if (process.env.GHOST_BOT_RUN_LIVE_CODEX !== '1') {
  console.log('Skipping live Codex E2E (set GHOST_BOT_RUN_LIVE_CODEX=1 with human authorization to run).')
  process.exit(0)
}

const MAX_TURNS_BUDGET = 3
let attemptedTurns = 0

function consumeTurnBudget(label) {
  if (attemptedTurns >= MAX_TURNS_BUDGET) {
    throw new Error(`Budget exceeded (${MAX_TURNS_BUDGET}) before ${label}`)
  }
  attemptedTurns += 1
}

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const outDir = join(repoRoot, 'design', 'reviews', 'phase-2b')
await mkdir(outDir, { recursive: true })

const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2b-live-e2e-'))
const workspaceDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2b-ws-'))
const sentinelPath = join(workspaceDir, 'sentinel.txt')
await writeFile(sentinelPath, 'DO_NOT_MODIFY_IN_READ_ONLY', 'utf8')

async function launchDesktop() {
  return electron.launch({
    executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
    args: [join(desktopDir, 'dist-electron', 'main.js')],
    cwd: desktopDir,
    env: {
      ...process.env,
      GHOST_BOT_DATA_DIR: dataDir,
      GHOST_BOT_RUNTIME_MODE: 'codex',
      GHOST_BOT_SMOKE_EXIT: '0',
    },
  })
}

let sessionId = ''
let threadId = ''
let cancellationOutcome = 'NOT_VERIFIED'
let usageSummary = null

try {
  // Launch 1: Live Codex execution (at most 3 attempted turns)
  const app1 = await launchDesktop()
  try {
    const page = await app1.firstWindow()
    await page.waitForSelector('text=Chief of Staff')

    const snap = await page.evaluate(() => window.ghostBot.getRuntimeSnapshot(true))
    assert.equal(snap.status, 'available', `Expected Codex available, got: ${snap.detail}`)
    assert.equal(snap.authMethod, 'chatgpt')
    assert.equal(snap.codexVersion, '0.172.0')
    assert.ok(snap.models.length > 0, 'Expected discovered models > 0')

    const modelId = snap.models[0].id
    const effort = snap.models[0].efforts[0] ?? 'medium'

    // Configure Chief of Staff bot for verified read-only Codex execution
    const bots = await page.evaluate(() => window.ghostBot.listBots())
    const botId = bots.bots[0].id
    await page.evaluate(
      ({ id, m, e, ws }) =>
        window.ghostBot.updateBot({
          id,
          patch: {
            runtimeId: 'codex',
            modelId: m,
            effort: e,
            permission: 'read-only',
            workspacePath: ws,
          },
        }),
      { id: botId, m: modelId, e: effort, ws: workspaceDir },
    )

    // Create a fresh live Codex session and reload window state cleanly via New chat
    const createdSess = await page.evaluate(
      (id) => window.ghostBot.createSession({ agentId: id, title: 'Live Codex Probe' }),
      botId,
    )
    sessionId = createdSess.id
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('text=Chief of Staff')

    const composer = page.getByLabel('Message Chief of Staff')

    // Turn 1: Short completion probe
    consumeTurnBudget('Turn 1')
    await composer.fill('Reply with exactly GHOST_OK.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('text=GHOST_OK', { timeout: 30_000 })
    // Wait until streaming stops (Send button returns or Stop disappears)
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 30_000 },
    )
    await page.screenshot({ path: join(outDir, '01-live-codex-reply.png') })

    // Turn 2: Same-thread continuation probe
    consumeTurnBudget('Turn 2')
    await composer.fill('What exact token did I ask you to reply with in my previous message?')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 30_000 },
    )
    await page.screenshot({ path: join(outDir, '02-same-thread-continuation.png') })

    // Turn 3: Bounded streaming cancellation probe
    consumeTurnBudget('Turn 3')
    await composer.fill('Write a numbered list of 40 prime numbers with a one-sentence explanation for each.')
    await page.getByRole('button', { name: 'Send message' }).click()
    try {
      await page.waitForSelector('button[aria-label="Stop generation"]', { timeout: 5000 })
      await page.waitForTimeout(300)
      const stopBtn = page.locator('button[aria-label="Stop generation"]')
      if (await stopBtn.isVisible()) {
        await stopBtn.click()
      }
    } catch {
      // Completed before Stop button could be clicked
    }
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 30_000 },
    )
    await page.screenshot({ path: join(outDir, '03-after-cancel-probe.png') })

    const postSnap = await page.evaluate(() => window.ghostBot.getRuntimeSnapshot(false))
    usageSummary = {
      usageStatus: postSnap.usageStatus,
      usageWindowsCount: postSnap.usageWindows.length,
    }
  } finally {
    await app1.close()
  }

  // Verify SQLite persistence & cancellation outcome
  const db = new DatabaseSync(join(dataDir, 'ghost-bot.sqlite'))
  try {
    const sessRow = db
      .prepare('SELECT external_session_id, account_id, runtime_id FROM sessions WHERE id = ?')
      .get(sessionId)
    assert.ok(sessRow?.external_session_id, 'External Codex thread ID must be persisted')
    assert.equal(sessRow.runtime_id, 'codex')
    threadId = sessRow.external_session_id

    const runs = db
      .prepare('SELECT id, status FROM runs WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId)
    assert.equal(runs.length, 3, `Expected 3 runs in live session, got ${runs.length}`)
    assert.equal(runs[0].status, 'completed')
    assert.equal(runs[1].status, 'completed')
    cancellationOutcome =
      runs[2].status === 'cancelled'
        ? 'VERIFIED_CANCELLED'
        : `NOT_VERIFIED_TERMINAL_${String(runs[2].status).toUpperCase()}`

    const evtsCount = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)`,
      )
      .get(sessionId).cnt
    assert.ok(Number(evtsCount) >= 6, `Expected persisted run_events >= 6, got ${evtsCount}`)
  } finally {
    db.close()
  }

  // Verify zero unauthorized workspace changes
  const files = await readdir(workspaceDir)
  assert.deepEqual(files, ['sentinel.txt'])
  const sentinelContent = await readFile(sentinelPath, 'utf8')
  assert.equal(sentinelContent, 'DO_NOT_MODIFY_IN_READ_ONLY')

  // Launch 2: Restart Electron against same dataDir and verify conversation restoration (0 inference turns)
  const app2 = await launchDesktop()
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForSelector('text=Chief of Staff')
    await page2.waitForSelector('text=GHOST_OK', { timeout: 10_000 })
    await page2.screenshot({ path: join(outDir, '04-restored-after-restart.png') })
  } finally {
    await app2.close()
  }

  console.log(
    JSON.stringify({
      phase2bLiveVerification: 'passed',
      attemptedTurns,
      sessionId,
      threadIdPersisted: Boolean(threadId),
      cancellationOutcome,
      workspaceIntact: true,
      usageSummary,
      screenshots: 4,
    }),
  )
} finally {
  await rm(dataDir, { recursive: true, force: true })
  await rm(workspaceDir, { recursive: true, force: true })
}
