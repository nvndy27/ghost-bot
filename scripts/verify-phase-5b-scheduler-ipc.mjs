import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-5b-ipc-'))

const app = await electron.launch({
  executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
  args: [join(desktopDir, 'dist-electron', 'main.js')],
  cwd: desktopDir,
  env: {
    ...process.env,
    GHOST_BOT_DATA_DIR: dataDir,
    GHOST_BOT_RUNTIME_MODE: 'mock',
    GHOST_BOT_SMOKE_EXIT: '0',
  },
})

try {
  const page = await app.firstWindow()
  await page.waitForSelector('text=Chief of Staff', { timeout: 10_000 })

  const result = await page.evaluate(async () => {
    const bridge = window.ghostBot
    if (!bridge) throw new Error('window.ghostBot unavailable')
    const botsRes = await bridge.listBots()
    const botId = botsRes.bots[0]?.id
    if (!botId) throw new Error('No seeded bot found')

    const created = await bridge.createRoutine({
      name: 'IPC Verification Routine',
      botId,
      trigger: { kind: 'daily', hour: 8, minute: 30 },
      timezone: 'UTC',
      task: { prompt: 'Generate daily IPC summary' },
      enabled: true,
    })
    const routineId = String(created.id)

    const listed = await bridge.listRoutines({ botId })
    const preview = await bridge.previewRoutineSchedule({ routineId, botId, count: 3 })
    const sim = await bridge.simulateRoutine({ routineId, botId, count: 2 })
    const trig = await bridge.triggerRoutine({
      routineId,
      botId,
      idempotencyKey: 'ipc-e2e-trigger-1',
    })
    const history = await bridge.listRoutineHistory({ routineId, botId, count: 10 })
    const notifs = await bridge.listRoutineNotifications({ botId })
    const unread = await bridge.getRoutineUnreadNotificationCount({ botId })
    const disabled = await bridge.disableRoutine({ routineId, botId })
    const archived = await bridge.archiveRoutine({ routineId, botId })

    let invalidRejected = false
    try {
      await bridge.listRoutines({ botId, unexpected: true })
    } catch {
      invalidRejected = true
    }

    return {
      routineId,
      listedCount: listed.routines.length,
      previewCount: Array.isArray(preview.occurrences) ? preview.occurrences.length : 0,
      simCount: Array.isArray(sim.runs) ? sim.runs.length : 0,
      trigCreated: Boolean(trig.created),
      historyCount: history.tasks.length,
      notifIsArray: Array.isArray(notifs.notifications),
      unreadType: typeof unread.unreadCount,
      disabledEnabled: disabled.enabled,
      archivedAtSet: archived.archivedAt !== null,
      invalidRejected,
    }
  })

  assert.ok(result.routineId.length > 0)
  assert.ok(result.listedCount >= 1)
  assert.equal(result.previewCount, 3)
  assert.equal(result.simCount, 2)
  assert.equal(result.trigCreated, true)
  assert.equal(result.historyCount, 1)
  assert.equal(result.notifIsArray, true)
  assert.equal(result.unreadType, 'number')
  assert.equal(result.disabledEnabled, false)
  assert.equal(result.archivedAtSet, true)
  assert.equal(result.invalidRejected, true)

  console.log('Phase 5B offline Electron IPC verification PASSED')
} finally {
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
}
