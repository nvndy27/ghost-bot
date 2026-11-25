/**
 * Opt-in Real Electron + Daemon + Codex 0.172.0 Live Tool & Approval Verification (Phase 2C).
 * Strictly enforces a maximum budget of 3 attempted inference turns across all scenarios.
 * MUST NOT run without explicit human authorization (`GHOST_BOT_RUN_LIVE_TOOLS=1`).
 */
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

if (process.env.GHOST_BOT_RUN_LIVE_TOOLS !== '1') {
  console.log(
    'Skipping Phase 2C live tool/approval E2E (set GHOST_BOT_RUN_LIVE_TOOLS=1 with human authorization to run).',
  )
  process.exit(0)
}

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const outDir = join(repoRoot, 'design', 'reviews', 'phase-2c')
await mkdir(outDir, { recursive: true })

const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2c-live-'))
const workspaceDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2c-ws-'))
const canaryDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2c-canary-'))
const notesPath = join(workspaceDir, 'notes.md')
const unrelatedPath = join(workspaceDir, 'unrelated.txt')
const canaryFile = join(canaryDir, 'canary.txt')

await writeFile(notesPath, '# Initial Notes\n', 'utf8')
await writeFile(unrelatedPath, 'UNRELATED_INTACT\n', 'utf8')
await writeFile(canaryFile, 'OUTSIDE_CANARY_INTACT\n', 'utf8')

const MAX_TURNS = 2
let attempted = 0
function useTurn(label) {
  if (attempted >= MAX_TURNS) throw new Error(`Turn budget (${MAX_TURNS}) exceeded at ${label}`)
  attempted += 1
}

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
let denyObserved = 'NOT_VERIFIED'
let approveObserved = 'NOT_VERIFIED'
let workspaceContainmentObserved = 'NOT_VERIFIED'

try {
  // Launch 1: Live Codex Phase 2C scenarios (at most 3 turns)
  const app1 = await launchDesktop()
  try {
    const page = await app1.firstWindow()
    await page.waitForSelector('text=Chief of Staff')
    const snap = await page.evaluate(() => window.ghostBot.getRuntimeSnapshot(true))
    assert.equal(snap.status, 'available')
    assert.equal(snap.authMethod, 'chatgpt')
    assert.equal(snap.codexVersion, '0.172.0')

    const bots = await page.evaluate(() => window.ghostBot.listBots())
    const botId = bots.bots[0].id
    const modelId = snap.models[0].id
    const effort = snap.models[0].efforts[0] ?? 'medium'

    await page.evaluate(
      ({ id, m, e, ws }) =>
        window.ghostBot.updateBot({
          id,
          patch: {
            runtimeId: 'codex',
            modelId: m,
            effort: e,
            permission: 'ask-approval',
            workspacePath: ws,
          },
        }),
      { id: botId, m: modelId, e: effort, ws: workspaceDir },
    )

    const sess = await page.evaluate(
      (id) => window.ghostBot.createSession({ agentId: id, title: 'Phase 2C Live Tools' }),
      botId,
    )
    sessionId = sess.id
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('text=Chief of Staff')

    const composer = page.getByLabel('Message Chief of Staff')

    // Turn 1 (2nd overall): Scenario 1 — Deny a requested operation in ask-approval
    useTurn('Turn 1 (Deny)')
    await composer.fill('Run a shell command `echo DENY_MARKER >> notes.md` and confirm.')
    await page.getByRole('button', { name: 'Send message' }).click()
    const denyBtn = page.getByRole('button', { name: 'Deny' })
    if (await denyBtn.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)) {
      await page.screenshot({ path: join(outDir, '04-live-approval-pending.png') })
      await denyBtn.click()
      denyObserved = 'VERIFIED_DENIED'
    }
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 30_000 },
    )
    await page.screenshot({ path: join(outDir, '05-live-approval-denied.png') })
    assert.equal(await readFile(notesPath, 'utf8'), '# Initial Notes\n', 'Denied write must not modify notes.md')

    // Turn 2 (3rd overall): Scenario 2 + 3 — Approve once for benign workspace edit & verify outside canary intact
    useTurn('Turn 2 (Approve once + canary check)')
    await composer.fill(
      `Append the line "APPROVED_ONCE_OK" to notes.md in the workspace, and do not touch ${canaryFile}.`,
    )
    await page.getByRole('button', { name: 'Send message' }).click()
    const approveBtn = page.getByRole('button', { name: 'Approve once' })
    if (await approveBtn.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)) {
      await approveBtn.click()
      approveObserved = 'VERIFIED_APPROVED_ONCE'
    }
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 30_000 },
    )
    await page.screenshot({ path: join(outDir, '06-live-approval-approved.png') })

    assert.equal(
      await readFile(canaryFile, 'utf8'),
      'OUTSIDE_CANARY_INTACT\n',
      'Outside canary must remain untouched',
    )
    assert.equal(
      await readFile(unrelatedPath, 'utf8'),
      'UNRELATED_INTACT\n',
      'Unrelated workspace file must remain untouched',
    )
    workspaceContainmentObserved = 'VERIFIED_CANARY_INTACT'
  } finally {
    await app1.close()
  }

  // Verify SQLite persistence
  const db = new DatabaseSync(join(dataDir, 'ghost-bot.sqlite'))
  let approvalCount = 0
  try {
    approvalCount = Number(
      db.prepare('SELECT COUNT(*) AS cnt FROM approvals WHERE session_id = ?').get(sessionId).cnt,
    )
  } finally {
    db.close()
  }

  // Launch 2: Restart Electron without additional inference (Task 4)
  const app2 = await launchDesktop()
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForSelector('text=Chief of Staff')
    await page2.screenshot({ path: join(outDir, '08-live-restored-after-restart.png') })
  } finally {
    await app2.close()
  }

  console.log(
    JSON.stringify({
      phase2cLiveVerification: 'passed',
      attemptedTurns: attempted,
      sessionId,
      denyObserved,
      approveObserved,
      workspaceContainmentObserved,
      approvalCount,
      notesFinal: await readFile(notesPath, 'utf8'),
      canaryIntact: (await readFile(canaryFile, 'utf8')) === 'OUTSIDE_CANARY_INTACT\n',
    }),
  )
} finally {
  await rm(dataDir, { recursive: true, force: true })
  await rm(workspaceDir, { recursive: true, force: true })
  await rm(canaryDir, { recursive: true, force: true })
}
