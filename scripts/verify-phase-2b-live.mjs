/**
 * Opt-in Real Electron + Daemon + Codex 0.172.0 Live Verification Script (Phase 2B).
 * Consumes at most 3 short inference turns on the authorized ChatGPT subscription profile.
 * MUST NOT run in default `pnpm test`. Requires explicit `GHOST_BOT_RUN_LIVE_CODEX=1`.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

if (process.env.GHOST_BOT_RUN_LIVE_CODEX !== '1') {
  console.log('Skipping live Codex E2E (set GHOST_BOT_RUN_LIVE_CODEX=1 with human authorization to run).')
  process.exit(0)
}

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2b-live-e2e-'))
const workspaceDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2b-ws-'))

const app = await electron.launch({
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

try {
  const page = await app.firstWindow()
  await page.waitForSelector('text=Chief of Staff')

  const snap = await page.evaluate(() => window.ghostBot.getRuntimeSnapshot(true))
  assert.equal(snap.status, 'available')
  assert.equal(snap.authMethod, 'chatgpt')
  assert.ok(snap.models.length > 0)

  const modelId = snap.models[0].id
  const effort = snap.models[0].efforts[0] ?? 'medium'

  // Configure bot for verified read-only Codex execution
  const bots = await page.evaluate(() => window.ghostBot.listBots())
  const botId = bots.bots[0].id
  await page.evaluate(
    ({ id, m, e, ws }) =>
      window.ghostBot.updateBot({
        id,
        patch: { runtimeId: 'codex', modelId: m, effort: e, permission: 'read-only', workspacePath: ws },
      }),
    { id: botId, m: modelId, e: effort, ws: workspaceDir },
  )

  const sess = await page.evaluate((id) => window.ghostBot.createSession({ agentId: id, title: 'Live Probe' }), botId)

  // Turn 1: short completion
  const r1 = await page.evaluate(
    (sid) => window.ghostBot.startRun({ sessionId: sid, idempotencyKey: 'live-1', text: 'Reply with exactly GHOST_OK.' }),
    sess.id,
  )
  for (let i = 0; i < 60; i += 1) {
    const cur = await page.evaluate((rid) => window.ghostBot.getRun(rid), r1.run.id)
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(cur.status)) {
      assert.equal(cur.status, 'completed')
      break
    }
    await page.waitForTimeout(250)
  }

  // Turn 2: same-thread continuation
  const r2 = await page.evaluate(
    (sid) => window.ghostBot.startRun({ sessionId: sid, idempotencyKey: 'live-2', text: 'What word did I just ask you to reply with?' }),
    sess.id,
  )
  for (let i = 0; i < 60; i += 1) {
    const cur = await page.evaluate((rid) => window.ghostBot.getRun(rid), r2.run.id)
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(cur.status)) {
      assert.equal(cur.status, 'completed')
      break
    }
    await page.waitForTimeout(250)
  }

  const db = new DatabaseSync(join(dataDir, 'ghost-bot.sqlite'))
  try {
    const sRow = db.prepare('SELECT external_session_id FROM sessions WHERE id = ?').get(sess.id)
    assert.ok(sRow?.external_session_id, 'External Codex thread ID must be persisted')
  } finally {
    db.close()
  }

  console.log('Phase 2B live Codex Electron E2E passed (2 turns).')
} finally {
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
  await rm(workspaceDir, { recursive: true, force: true })
}
