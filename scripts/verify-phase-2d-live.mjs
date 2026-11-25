/**
 * Opt-in Real Electron + Daemon + Codex 0.172.0 Live Recovery Verification (Phase 2D).
 * Strictly enforces a maximum budget of 1 attempted inference turns on the authorized
 * ChatGPT subscription profile, exclusively for Phase 2D verification.
 * Requires explicit human authorization (`GHOST_BOT_RUN_LIVE_RECOVERY=1`).
 */
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

if (process.env.GHOST_BOT_RUN_LIVE_RECOVERY !== '1') {
  console.log(
    'Skipping Phase 2D live recovery E2E (set GHOST_BOT_RUN_LIVE_RECOVERY=1 with human authorization to run).',
  )
  process.exit(0)
}

const MAX_TURNS_BUDGET = 1
let attemptedTurns = 0

function consumeTurnBudget(label) {
  if (attemptedTurns >= MAX_TURNS_BUDGET) {
    throw new Error(`Budget exceeded (${MAX_TURNS_BUDGET}) before ${label}`)
  }
  attemptedTurns += 1
}

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const outDir = join(repoRoot, 'design', 'reviews', 'phase-2d')
await mkdir(outDir, { recursive: true })

const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2d-live-'))
const workspaceDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2d-ws-'))
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

try {
  // Launch 1: Turn 1 (read-only live inference)
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

    const createdSess = await page.evaluate(
      (id) => window.ghostBot.createSession({ agentId: id, title: 'Live Recovery Probe' }),
      botId,
    )
    sessionId = createdSess.id
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('text=Chief of Staff')

    const composer = page.getByLabel('Message Chief of Staff')
    consumeTurnBudget('Turn 1')
    await composer.fill('Reply with exactly GHOST_2D_TOKEN_91.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('text=GHOST_2D_TOKEN_91', { timeout: 45_000 })
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 45_000 },
    )
    await page.screenshot({ path: join(outDir, '03-live-turn1.png') })
  } finally {
    await app1.close()
  }

  // Verify Turn 1 persisted in SQLite with external thread ID
  const db1 = new DatabaseSync(join(dataDir, 'ghost-bot.sqlite'))
  try {
    const sessRow = db1
      .prepare('SELECT external_session_id, runtime_id FROM sessions WHERE id = ?')
      .get(sessionId)
    assert.ok(sessRow?.external_session_id, 'External Codex thread ID must be persisted')
    assert.equal(sessRow.runtime_id, 'codex')
    threadId = sessRow.external_session_id

    const runs = db1
      .prepare('SELECT id, status FROM runs WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId)
    assert.equal(runs.length, 1, `Expected 1 run after Turn 1, got ${runs.length}`)
    assert.equal(runs[0].status, 'completed')
  } finally {
    db1.close()
  }

  // Launch 2: Restart Electron, verify restoration, reconnectRuntime, inspectSession without a second turn
  const app2 = await launchDesktop()
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('text=Chief of Staff')
    await page.waitForSelector('text=GHOST_2D_TOKEN_91', { timeout: 15_000 })

    const reconnected = await page.evaluate(() => window.ghostBot.reconnectRuntime())
    assert.equal(reconnected.status, 'available')
    assert.equal(reconnected.lifecycleState, 'connected')

    const inspection = await page.evaluate((id) => window.ghostBot.inspectSession(id), sessionId)
    assert.equal(inspection.providerThreadStatus, 'unknown')
    assert.equal(inspection.resumable, true)
    assert.equal(inspection.quarantined, false)
    await page.screenshot({ path: join(outDir, '04-live-reconnected-inspected.png') })
  } finally {
    await app2.close()
  }

  // Verify SQLite state & zero unauthorized workspace changes
  const db2 = new DatabaseSync(join(dataDir, 'ghost-bot.sqlite'))
  try {
    const sessRow = db2
      .prepare('SELECT external_session_id FROM sessions WHERE id = ?')
      .get(sessionId)
    assert.equal(sessRow?.external_session_id, threadId, 'Thread ID must remain consistent across reconnect')

    const runs = db2
      .prepare('SELECT id, status FROM runs WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId)
    assert.equal(runs.length, 1, `Expected 1 run after restart/reconnect, got ${runs.length}`)
    assert.equal(runs[0].status, 'completed')
  } finally {
    db2.close()
  }

  const files = await readdir(workspaceDir)
  assert.deepEqual(files, ['sentinel.txt'])
  const sentinelContent = await readFile(sentinelPath, 'utf8')
  assert.equal(sentinelContent, 'DO_NOT_MODIFY_IN_READ_ONLY')

  console.log(
    JSON.stringify({
      ok: true,
      attemptedTurns,
      sessionId,
      threadId,
      providerThreadStatus: 'unknown',
      reconnectedLifecycle: 'connected',
      workspaceIntact: true,
    }),
  )
} finally {
  await rm(dataDir, { recursive: true, force: true })
  await rm(workspaceDir, { recursive: true, force: true })
}
