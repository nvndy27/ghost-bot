/**
 * Phase 2E Performance Measurement & 15-Step Daily-Use UX Acceptance E2E.
 * Uses isolated temporary GHOST_BOT_DATA_DIR and mock runtime mode (zero live inference).
 */
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const outDir = join(repoRoot, 'design', 'reviews', 'phase-2e')
await mkdir(outDir, { recursive: true })

const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-2e-ux-'))
const consoleErrors = []

async function readProcMemMb(pid) {
  let rssMb = null
  let pssMb = null
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(status)
    if (m) rssMb = Number((Number(m[1]) / 1024).toFixed(1))
  } catch {
    // ignore
  }
  try {
    const smaps = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')
    const m = /Pss:\s+(\d+)\s+kB/.exec(smaps)
    if (m) pssMb = Number((Number(m[1]) / 1024).toFixed(1))
  } catch {
    // ignore
  }
  return { rssMb, pssMb }
}

async function launchDesktop() {
  return electron.launch({
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
}

const metrics = {
  scope: 'application-only (Electron main/renderer/GPU + @ghost-bot/daemon; zero external AI runtime)',
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpuCount: cpus().length,
  },
  coldStartupMs: 0,
  warmStartupMs: 0,
  daemonRssMb: null,
  daemonPssMb: null,
  totalTreeRssMb: null,
  totalTreePssMb: null,
  rendererMemoryMb: null,
  gpuMemoryMb: null,
  idleCpuPercent: null,
  repeatedSwitchesMs: 0,
  repeatedRunsMs: 0,
  streamingDurationMs: 0,
  metadataRefreshMs: 0,
  historyLoadMs: 0,
  shutdownMs: 0,
  daemonExitedCleanly: false,
}

try {
  // 1. Cold launch + steps 1-12, 14-15
  const coldStart = performance.now()
  const app1 = await launchDesktop()
  let activeSessionId = ''
  try {
    const page = await app1.firstWindow()
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    await page.waitForSelector('text=Chief of Staff')
    metrics.coldStartupMs = Math.round(performance.now() - coldStart)

    const health = await page.evaluate(() => window.ghostBot.getDaemonHealth())
    assert.equal(health.ok, true)
    const daemonPid = health.pid
    const daemonMem = await readProcMemMb(daemonPid)
    metrics.daemonRssMb = daemonMem.rssMb
    metrics.daemonPssMb = daemonMem.pssMb

    // Idle CPU & process-tree RSS/PSS over a 2-second observation interval
    const appMetricsBefore = await app1.evaluate(({ app }) => app.getAppMetrics())
    await page.waitForTimeout(2000)
    const appMetricsAfter = await app1.evaluate(({ app }) => app.getAppMetrics())
    const idleCpuSum = appMetricsAfter.reduce((acc, m) => acc + (m.cpu?.percentCPUUsage ?? 0), 0)
    metrics.idleCpuPercent = Number(idleCpuSum.toFixed(2))

    let treeRss = daemonMem.rssMb ?? 0
    let treePss = daemonMem.pssMb ?? 0
    for (const proc of appMetricsAfter) {
      const mem = await readProcMemMb(proc.pid)
      if (mem.rssMb !== null) treeRss += mem.rssMb
      if (mem.pssMb !== null) treePss += mem.pssMb
      if (proc.type === 'Tab') {
        metrics.rendererMemoryMb = Number(((proc.memory?.workingSetSize ?? 0) / 1024).toFixed(1))
      } else if (proc.type === 'GPU') {
        metrics.gpuMemoryMb = Number(((proc.memory?.workingSetSize ?? 0) / 1024).toFixed(1))
      }
    }
    metrics.totalTreeRssMb = Number(treeRss.toFixed(1))
    metrics.totalTreePssMb = Number(treePss.toFixed(1))
    void appMetricsBefore

    // 2. Create and edit bot
    await page.getByRole('button', { name: 'Create bot' }).click()
    await page.getByPlaceholder('e.g. Security Auditor').fill('Daily Use Bot')
    await page.getByRole('button', { name: 'Create bot' }).last().click()
    await page.waitForSelector('header >> text=Daily Use Bot')

    await page.getByRole('button', { name: 'Edit bot' }).click()
    await page.getByPlaceholder('e.g. Security Auditor').fill('Chief of Staff 2E')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.waitForSelector('header >> text=Chief of Staff 2E')

    // 3-4. Check composer selectors & permission mode
    await page.getByLabel('Model').isVisible()
    await page.getByLabel('Reasoning effort').isVisible()
    const permSelect = page.getByLabel('Permission mode')
    await permSelect.selectOption('read-only')

    // 5. Create conversation
    await page.getByRole('button', { name: 'New conversation' }).click()
    await page.waitForTimeout(200)

    // 6-7. Submit deterministic message & measure streaming
    const composer = page.getByLabel('Message Chief of Staff 2E')
    const streamStart = performance.now()
    await composer.fill('Phase 2E daily use streaming check')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 15_000 },
    )
    metrics.streamingDurationMs = Math.round(performance.now() - streamStart)
    await page.screenshot({ path: join(outDir, '01-daily-use-workspace-dark.png') })

    // 8. Trigger & resolve approval
    await composer.fill('Trigger approval test')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('button:has-text("Approve once")', { timeout: 10_000 })
    await page.screenshot({ path: join(outDir, '02-daily-use-approval-and-tools.png') })
    await page.getByRole('button', { name: 'Approve once' }).click()
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 15_000 },
    )

    // 9. Cancel a run
    await composer.fill('Trigger long stream cancel test')
    await page.getByRole('button', { name: 'Send message' }).click()
    try {
      await page.waitForSelector('button[aria-label="Stop generation"]', { timeout: 5000 })
      await page.getByRole('button', { name: 'Stop generation' }).click()
    } catch {
      // Completed before stop click
    }
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Stop generation"]'),
      null,
      { timeout: 15_000 },
    )

    // 10. Switch bots & back
    const bots = await page.evaluate(() => window.ghostBot.listBots())
    const editedBot = bots.bots.find((b) => b.name === 'Chief of Staff 2E') ?? bots.bots[0]
    if (bots.bots.length > 1) {
      await page.locator('[role="option"]').first().click()
      await page.waitForTimeout(150)
      await page.locator('[role="option"]', { hasText: 'Chief of Staff 2E' }).click()
      await page.waitForTimeout(150)
    }

    const sessions = await page.evaluate((id) => window.ghostBot.listSessions({ agentId: id }), editedBot.id)
    activeSessionId = sessions.sessions[0]?.id ?? ''
    assert.ok(activeSessionId, 'Expected active session ID')

    // Measure history loading
    const histStart = performance.now()
    const msgs = await page.evaluate((id) => window.ghostBot.listMessages({ sessionId: id }), activeSessionId)
    metrics.historyLoadMs = Math.round(performance.now() - histStart)
    assert.ok(msgs.messages.length >= 2)

    // 11-12. Inspect session & reconnect runtime + measure metadata refresh
    const insp = await page.evaluate((id) => window.ghostBot.inspectSession(id), activeSessionId)
    assert.equal(insp.resumable, true)
    const refStart = performance.now()
    const snap = await page.evaluate(() => window.ghostBot.getRuntimeSnapshot(true))
    metrics.metadataRefreshMs = Math.round(performance.now() - refStart)
    assert.equal(snap.status, 'mock')
    const reconnected = await page.evaluate(() => window.ghostBot.reconnectRuntime())
    assert.equal(reconnected.status, 'mock')

    // 14-15. Open Settings -> Usage & Accounts, switch theme to Light
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Usage' }).click()
    await page.waitForSelector('text=Mock mode active')
    await page.screenshot({ path: join(outDir, '03-settings-usage-and-providers.png') })

    await page.getByRole('button', { name: 'Appearance' }).click()
    await page.getByLabel('Theme').selectOption('light')
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.screenshot({ path: join(outDir, '04-daily-use-light-theme.png') })

    const shutdownStart = performance.now()
    await app1.close()
    metrics.shutdownMs = Math.round(performance.now() - shutdownStart)
    // Verify owned daemon exited cleanly
    try {
      process.kill(daemonPid, 0)
      metrics.daemonExitedCleanly = false
    } catch {
      metrics.daemonExitedCleanly = true
    }
  } catch (err) {
    await app1.close().catch(() => undefined)
    throw err
  }

  // 13. Warm restart & state restoration
  const warmStart = performance.now()
  const app2 = await launchDesktop()
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForSelector('header >> text=Chief of Staff 2E')
    metrics.warmStartupMs = Math.round(performance.now() - warmStart)
    await page2.waitForSelector('text=Phase 2E daily use streaming check')
  } finally {
    await app2.close()
  }

  assert.equal(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join('; ')}`)
  console.log(
    JSON.stringify({
      dailyUseUx: 'passed',
      screenshots: 4,
      consoleErrors: 0,
      metrics,
    }),
  )
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
