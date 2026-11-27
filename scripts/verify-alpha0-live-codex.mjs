/**
 * Opt-in Alpha.0 Final Live Acceptance Script (Codex App Server 0.172.0).
 * Strictly enforces a maximum budget of 3 inference prompts total on the dedicated
 * ChatGPT-authenticated profile, using read-only permission and isolated temp dirs.
 * Requires explicit `GHOST_BOT_RUN_LIVE_CODEX=1`.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

if (process.env.GHOST_BOT_RUN_LIVE_CODEX !== '1') {
  console.log('Skipping Alpha.0 live Codex E2E (set GHOST_BOT_RUN_LIVE_CODEX=1 with explicit authorization to run).')
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
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-alpha0-live-data-'))
const workspaceDir = await mkdtemp(join(tmpdir(), 'ghost-alpha0-live-ws-'))
const sentinelPath = join(workspaceDir, 'sentinel.txt')
await writeFile(sentinelPath, 'DO_NOT_MODIFY_IN_READ_ONLY', 'utf8')

async function launchDesktop() {
  return electron.launch({
    executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
    args: [join(desktopDir, 'dist-electron', 'main.js'), '--no-sandbox'],
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
let accountId = ''
let modelUsed = ''
let effortUsed = ''
let prompt1Usage = null
let prompt2Status = ''
let prompt3Text = ''
let runtimeUsage = null

try {
  // Launch 1: Prompt 1 (Streaming & persistence) + Prompt 2 (Cancellation)
  const app1 = await launchDesktop()
  try {
    const page = await app1.firstWindow()
    await page.waitForSelector('text=Chief of Staff')

    const snap = await page.evaluate(() => window.ghostBot.getRuntimeSnapshot(true))
    assert.equal(snap.status, 'available', `Expected Codex available, got: ${snap.detail}`)
    assert.equal(snap.authMethod, 'chatgpt', `Expected chatgpt auth, got: ${snap.authMethod}`)
    assert.equal(snap.codexVersion, '0.172.0')
    assert.ok(snap.models.length > 0, 'Expected discovered models > 0')

    modelUsed = snap.models[0].id
    effortUsed = snap.models[0].efforts[0] ?? 'medium'

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
      { id: botId, m: modelUsed, e: effortUsed, ws: workspaceDir },
    )

    const createdSess = await page.evaluate(
      (id) => window.ghostBot.createSession({ agentId: id, title: 'Alpha.0 Live Acceptance' }),
      botId,
    )
    sessionId = createdSess.id
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('text=Chief of Staff')

    const composer = page.getByLabel('Message Chief of Staff')

    // Prompt 1: Streaming & persistence
    consumeTurnBudget('Prompt 1')
    await composer.fill('Reply with exactly ALPHA0_OK.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('text=ALPHA0_OK', { timeout: 30_000 })
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 30_000 },
    )

    // Prompt 2: Bounded streaming cancellation
    consumeTurnBudget('Prompt 2')
    await composer.fill('Write a numbered list of 40 prime numbers with a one-sentence explanation for each.')
    await page.getByRole('button', { name: 'Send message' }).click()
    try {
      await page.waitForSelector('button[aria-label="Stop generation"]', { timeout: 10_000 })
      await page.waitForTimeout(400)
      const stopBtn = page.locator('button[aria-label="Stop generation"]')
      if (await stopBtn.isVisible()) {
        await stopBtn.click()
      }
    } catch {
      // Completed before Stop could be clicked
    }
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 30_000 },
    )

    const postSnap = await page.evaluate(() => window.ghostBot.getRuntimeSnapshot(false))
    runtimeUsage = {
      usageStatus: postSnap.usageStatus,
      usageWindows: postSnap.usageWindows,
    }
  } finally {
    await app1.close()
  }

  // Launch 2: Restart Electron & daemon, reopen first conversation, run Prompt 3 (Restart continuity)
  const app2 = await launchDesktop()
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForSelector('text=Chief of Staff')
    await page2.waitForSelector('text=ALPHA0_OK', { timeout: 15_000 })

    const composer2 = page2.getByLabel('Message Chief of Staff')
    consumeTurnBudget('Prompt 3')
    await composer2.fill('What exact token did I ask you to reply with in my first message? Reply with that token only.')
    await page2.getByRole('button', { name: 'Send message' }).click()
    try {
      await page2.waitForSelector('button[aria-label="Stop generation"]', { timeout: 5000 })
    } catch {
      // Completed before Stop button mounted
    }
    await page2.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 30_000 },
    )
  } finally {
    await app2.close()
  }

  // Verify SQLite persistence across all 3 runs
  const db = new DatabaseSync(join(dataDir, 'ghost-bot.sqlite'))
  try {
    const sessRow = db
      .prepare('SELECT external_session_id, account_id, runtime_id FROM sessions WHERE id = ?')
      .get(sessionId)
    assert.ok(sessRow?.external_session_id, 'External Codex thread ID must be persisted')
    assert.equal(sessRow.runtime_id, 'codex')
    threadId = sessRow.external_session_id
    accountId = sessRow.account_id

    const runs = db
      .prepare('SELECT id, status, model_id, effort, permission_mode FROM runs WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId)
    assert.equal(runs.length, 3, `Expected 3 runs, got ${runs.length}`)
    assert.equal(runs[0].status, 'completed')
    assert.equal(runs[0].permission_mode, 'read-only')
    prompt2Status = runs[1].status
    assert.equal(runs[2].status, 'completed')

    const msgs = db
      .prepare('SELECT role, content_json, status, run_id FROM messages WHERE session_id = ? ORDER BY seq_order ASC')
      .all(sessionId)
    const run3Assistant = msgs.find((m) => m.run_id === runs[2].id && m.role === 'assistant')
    prompt3Text = run3Assistant ? (JSON.parse(run3Assistant.content_json).text ?? '') : ''
    assert.match(prompt3Text, /ALPHA0_OK/)

    const usageEvt = db
      .prepare(
        `SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'usage.updated' ORDER BY seq DESC LIMIT 1`,
      )
      .get(runs[0].id)
    prompt1Usage = usageEvt ? JSON.parse(usageEvt.payload_json) : null

    const runEventsCount = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)`,
      )
      .get(sessionId).cnt
    assert.ok(Number(runEventsCount) >= 6)
  } finally {
    db.close()
  }

  // Verify read-only workspace intact
  const files = await readdir(workspaceDir)
  assert.deepEqual(files, ['sentinel.txt'])
  assert.equal(await readFile(sentinelPath, 'utf8'), 'DO_NOT_MODIFY_IN_READ_ONLY')

  console.log(
    JSON.stringify({
      alpha0LiveAcceptance: 'passed',
      attemptedTurns,
      modelUsed,
      effortUsed,
      accountIdPresent: Boolean(accountId),
      threadIdPersisted: Boolean(threadId),
      prompt1Completed: true,
      prompt1Usage,
      prompt2Status,
      prompt3ResumedContinuity: prompt3Text.trim(),
      runtimeUsage,
      workspaceIntact: true,
    }),
  )
} finally {
  await rm(dataDir, { recursive: true, force: true })
  await rm(workspaceDir, { recursive: true, force: true })
}
