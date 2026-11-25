/**
 * Opt-in Real Electron + Daemon + Codex 0.172.0 Live Tool & Approval Verification (Phase 2C).
 * Consumes live subscription inference and performs controlled temporary workspace writes.
 * MUST NOT run without explicit human authorization (`GHOST_BOT_RUN_LIVE_TOOLS=1`).
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

if (process.env.GHOST_BOT_RUN_LIVE_TOOLS !== '1') {
  console.log(
    'Skipping Phase 2C live tool/approval E2E (set GHOST_BOT_RUN_LIVE_TOOLS=1 with human authorization to run).',
  )
  process.exit(0)
}

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2c-live-'))
const workspaceDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2c-ws-'))
const canaryDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2c-canary-'))
const canaryFile = join(canaryDir, 'canary.txt')
await writeFile(join(workspaceDir, 'notes.md'), '# Initial Notes\n', 'utf8')
await writeFile(canaryFile, 'OUTSIDE_CANARY_INTACT', 'utf8')

const MAX_TURNS = 3
let attempted = 0
function useTurn(label) {
  if (attempted >= MAX_TURNS) throw new Error(`Turn budget (${MAX_TURNS}) exceeded at ${label}`)
  attempted += 1
}

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
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('text=Chief of Staff')

  const composer = page.getByLabel('Message Chief of Staff')

  // Turn 1: Benign workspace edit in ask-approval -> deny
  useTurn('Turn 1 (deny)')
  await composer.fill('Append a line "DENY_TEST" to notes.md.')
  await page.getByRole('button', { name: 'Send message' }).click()
  const denyBtn = page.getByRole('button', { name: 'Deny' })
  if (await denyBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await denyBtn.click()
  }
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Stop generation"]'),
    null,
    { timeout: 30_000 },
  )

  // Turn 2: Benign workspace edit in ask-approval -> approve once
  useTurn('Turn 2 (approve once)')
  await composer.fill('Append a line "APPROVED_TEST" to notes.md.')
  await page.getByRole('button', { name: 'Send message' }).click()
  const approveBtn = page.getByRole('button', { name: 'Approve once' })
  if (await approveBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await approveBtn.click()
  }
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Stop generation"]'),
    null,
    { timeout: 30_000 },
  )

  // Verify outside canary untouched
  assert.equal(await readFile(canaryFile, 'utf8'), 'OUTSIDE_CANARY_INTACT')
  console.log(JSON.stringify({ phase2cLiveVerification: 'passed', attempted, sessionId: sess.id }))
} finally {
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
  await rm(workspaceDir, { recursive: true, force: true })
  await rm(canaryDir, { recursive: true, force: true })
}
