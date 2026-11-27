/**
 * Opt-in Alpha.0 Final Live Acceptance Harness (Codex App Server 0.172.0).
 * Strictly enforces a maximum budget of 3 inference prompts total on the dedicated
 * ChatGPT-authenticated profile, using read-only permission and isolated temp dirs.
 * Requires explicit `GHOST_BOT_RUN_LIVE_CODEX=1`.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright-core'

export const MAX_TURNS_BUDGET = 3

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export function createTurnBudgetTracker(maxTurns = MAX_TURNS_BUDGET) {
  let attemptedTurns = 0
  return {
    consume(label) {
      if (attemptedTurns >= maxTurns) {
        throw new Error(`Budget exceeded (${maxTurns}) before ${label}`)
      }
      attemptedTurns += 1
      return attemptedTurns
    },
    getAttemptedTurns() {
      return attemptedTurns
    },
  }
}

export async function waitForNewRunId(
  getSessionMessages,
  sessionId,
  knownRunIds,
  timeoutMs = 15_000,
  pollIntervalMs = 50,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await getSessionMessages(sessionId)
    const messages = Array.isArray(res?.messages) ? res.messages : []
    for (const msg of messages) {
      if (msg?.runId && !knownRunIds.has(msg.runId)) {
        return msg.runId
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  throw new Error(`Timed out waiting for new run ID in session ${sessionId}`)
}

export async function waitForRunTerminalIpc(
  getRun,
  runId,
  timeoutMs = 30_000,
  pollIntervalMs = 50,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await getRun(runId)
    if (run && TERMINAL_RUN_STATUSES.has(run.status)) {
      return run
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  throw new Error(`Timed out waiting for run ${runId} to reach durable terminal status`)
}

export function extractAssistantTextForRun(messages, runId) {
  const assistantMsg = (messages ?? []).find((m) => m?.runId === runId && m?.role === 'assistant')
  if (!assistantMsg) return ''
  if (typeof assistantMsg.text === 'string') return assistantMsg.text
  if (typeof assistantMsg.content?.text === 'string') return assistantMsg.content.text
  return ''
}

export async function runAlpha0LiveAcceptance(options = {}) {
  const env = options.env ?? process.env
  if (env.GHOST_BOT_RUN_LIVE_CODEX !== '1') {
    return {
      skipped: true,
      reason: 'GHOST_BOT_RUN_LIVE_CODEX is not set to 1',
    }
  }

  const budget = createTurnBudgetTracker(options.maxTurns ?? MAX_TURNS_BUDGET)
  const pollIntervalMs = options.pollIntervalMs ?? 50
  const runDetectTimeoutMs = options.runDetectTimeoutMs ?? 15_000
  const runTerminalTimeoutMs = options.runTerminalTimeoutMs ?? 30_000
  const stopMountTimeoutMs = options.stopMountTimeoutMs ?? 10_000

  const fsApi = options.fsApi ?? { mkdtemp, readdir, readFile, rm, writeFile }
  const openDb = options.openDb ?? ((dbPath) => new DatabaseSync(dbPath))
  const launchDesktop =
    options.launchDesktop ??
    (async (dataDir) => {
      const repoRoot = process.cwd()
      const desktopDir = join(repoRoot, 'apps', 'desktop')
      return electron.launch({
        executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
        // Test-only sandbox exception for headless Linux Playwright launches; production main.ts retains sandbox: true.
        args: [join(desktopDir, 'dist-electron', 'main.js'), '--no-sandbox'],
        cwd: desktopDir,
        env: {
          ...env,
          GHOST_BOT_DATA_DIR: dataDir,
          GHOST_BOT_RUNTIME_MODE: 'codex',
          GHOST_BOT_SMOKE_EXIT: '0',
        },
      })
    })
  const emitLog = options.emitLog ?? ((payload) => console.log(JSON.stringify(payload)))

  const dataDir = await fsApi.mkdtemp(join(tmpdir(), 'ghost-alpha0-live-data-'))
  const workspaceDir = await fsApi.mkdtemp(join(tmpdir(), 'ghost-alpha0-live-ws-'))
  const sentinelPath = join(workspaceDir, 'sentinel.txt')
  await fsApi.writeFile(sentinelPath, 'DO_NOT_MODIFY_IN_READ_ONLY', 'utf8')

  const evidence = {
    alpha0LiveAcceptance: 'failed',
    attemptedTurns: 0,
    sessionIdPresent: false,
    externalThreadBound: false,
    accountBindingVerified: false,
    modelUsed: null,
    effortUsed: null,
    runs: [],
    runtimeUsage: null,
    workspaceIntact: false,
    error: null,
  }

  let sessionId = ''
  let expectedExternalThreadId = ''
  let expectedAccountId = ''
  const knownRunIds = new Set()

  try {
    // Launch 1: Prompt 1 (Streaming & persistence) + Prompt 2 (Cancellation)
    const app1 = await launchDesktop(dataDir)
    try {
      const page = await app1.firstWindow()
      await page.waitForSelector('text=Chief of Staff')

      const snap = await page.evaluate(() => window.ghostBot.getRuntimeSnapshot(true))
      assert.equal(snap.status, 'available', `Expected Codex available, got: ${snap.detail}`)
      assert.equal(snap.authMethod, 'chatgpt', `Expected chatgpt auth, got: ${snap.authMethod}`)
      assert.equal(snap.codexVersion, '0.172.0')
      assert.ok(Array.isArray(snap.models) && snap.models.length > 0, 'Expected discovered models > 0')

      evidence.modelUsed = snap.models[0].id
      evidence.effortUsed = snap.models[0].efforts?.[0] ?? 'medium'

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
        { id: botId, m: evidence.modelUsed, e: evidence.effortUsed, ws: workspaceDir },
      )

      const createdSess = await page.evaluate(
        (id) => window.ghostBot.createSession({ agentId: id, title: 'Alpha.0 Live Acceptance' }),
        botId,
      )
      sessionId = createdSess.id
      evidence.sessionIdPresent = Boolean(sessionId)
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForSelector('text=Chief of Staff')

      const getMessages = (sId) =>
        page.evaluate((id) => window.ghostBot.listMessages({ sessionId: id }), sId)
      const getRun = (rId) => page.evaluate((id) => window.ghostBot.getRun(id), rId)
      const getRunEvents = (rId) =>
        page.evaluate((id) => window.ghostBot.getRunEvents({ runId: id }), rId)
      const inspectSession = (sId) =>
        page.evaluate((id) => window.ghostBot.inspectSession(id), sId)

      const composer = page.getByLabel('Message Chief of Staff')

      // Prompt 1: Streaming & persistence
      budget.consume('Prompt 1')
      evidence.attemptedTurns = budget.getAttemptedTurns()
      await composer.fill('Reply with exactly ALPHA0_OK.')
      await page.getByRole('button', { name: 'Send message' }).click()

      const run1Id = await waitForNewRunId(
        getMessages,
        sessionId,
        knownRunIds,
        runDetectTimeoutMs,
        pollIntervalMs,
      )
      knownRunIds.add(run1Id)
      const run1 = await waitForRunTerminalIpc(getRun, run1Id, runTerminalTimeoutMs, pollIntervalMs)
      const msgs1 = await getMessages(sessionId)
      const run1AssistantText = extractAssistantTextForRun(msgs1.messages, run1Id)
      const events1 = await getRunEvents(run1Id)
      const evList1 = Array.isArray(events1?.events) ? events1.events : []
      const usage1 = evList1.findLast?.((ev) => ev?.type === 'usage.updated')?.payload ?? 'unavailable'
      const deltaCount1 = evList1.filter((ev) => ev?.type === 'message.delta').length
      const terminalEvt1 =
        evList1.findLast?.(
          (ev) =>
            ev?.type === 'run.completed' ||
            ev?.type === 'run.failed' ||
            ev?.type === 'run.cancelled' ||
            ev?.type === 'run.interrupted',
        )?.type ?? null

      const sessInspect1 = await inspectSession(sessionId)
      expectedExternalThreadId = sessInspect1?.externalSessionId ?? ''
      expectedAccountId = msgs1?.session?.accountId ?? ''
      evidence.externalThreadBound = Boolean(expectedExternalThreadId)

      evidence.runs.push({
        prompt: 1,
        runId: run1Id,
        status: run1.status,
        assistantReplyMatched: /ALPHA0_OK/.test(run1AssistantText),
        deltaEventCount: deltaCount1,
        terminalEvent: terminalEvt1,
        usage: usage1,
      })

      assert.equal(run1.status, 'completed', `Prompt 1 expected completed, got ${run1.status}`)
      assert.match(run1AssistantText, /ALPHA0_OK/, 'Prompt 1 assistant message must contain ALPHA0_OK')
      assert.ok(expectedExternalThreadId, 'External Codex thread ID must be persisted after Prompt 1')
      assert.ok(expectedAccountId, 'Session accountId must be persisted in SessionRecord after Prompt 1')
      assert.equal(msgs1?.session?.externalSessionId, expectedExternalThreadId)

      // Prompt 2: Bounded streaming cancellation
      budget.consume('Prompt 2')
      evidence.attemptedTurns = budget.getAttemptedTurns()
      await composer.fill(
        'Write a numbered list of 40 prime numbers with a one-sentence explanation for each.',
      )
      await page.getByRole('button', { name: 'Send message' }).click()

      const run2Id = await waitForNewRunId(
        getMessages,
        sessionId,
        knownRunIds,
        runDetectTimeoutMs,
        pollIntervalMs,
      )
      knownRunIds.add(run2Id)

      let stopClicked = false
      try {
        await page.waitForSelector('button[aria-label="Stop generation"]', {
          timeout: stopMountTimeoutMs,
        })
        const stopBtn = page.locator('button[aria-label="Stop generation"]')
        if (await stopBtn.isVisible()) {
          await stopBtn.click()
          stopClicked = true
        }
      } catch {
        // Stop button did not mount before timeout or fast completion
      }

      const run2 = await waitForRunTerminalIpc(getRun, run2Id, runTerminalTimeoutMs, pollIntervalMs)
      const events2 = await getRunEvents(run2Id)
      const evList2 = Array.isArray(events2?.events) ? events2.events : []
      const usage2 = evList2.findLast?.((ev) => ev?.type === 'usage.updated')?.payload ?? 'unavailable'
      const terminalEvt2 =
        evList2.findLast?.(
          (ev) =>
            ev?.type === 'run.completed' ||
            ev?.type === 'run.failed' ||
            ev?.type === 'run.cancelled' ||
            ev?.type === 'run.interrupted',
        )?.type ?? null
      evidence.runs.push({
        prompt: 2,
        runId: run2Id,
        status: run2.status,
        stopClicked,
        terminalEvent: terminalEvt2,
        usage: usage2,
      })

      assert.equal(
        run2.status,
        'cancelled',
        `Cancellation not verified: Prompt 2 terminal status was ${run2.status} (stopClicked=${stopClicked})`,
      )

      const postSnap = await page.evaluate(() => window.ghostBot.getRuntimeSnapshot(false))
      evidence.runtimeUsage = {
        usageStatus: postSnap.usageStatus ?? 'unavailable',
        usageWindows: postSnap.usageWindows ?? [],
      }
    } finally {
      await app1.close()
    }

    // Launch 2: Restart Electron & daemon, reopen conversation, verify thread/account binding, run Prompt 3
    const app2 = await launchDesktop(dataDir)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForSelector('text=Chief of Staff')

      const getMessages2 = (sId) =>
        page2.evaluate((id) => window.ghostBot.listMessages({ sessionId: id }), sId)
      const getRun2 = (rId) => page2.evaluate((id) => window.ghostBot.getRun(id), rId)
      const getRunEvents2 = (rId) =>
        page2.evaluate((id) => window.ghostBot.getRunEvents({ runId: id }), rId)
      const inspectSession2 = (sId) =>
        page2.evaluate((id) => window.ghostBot.inspectSession(id), sId)

      const sessInspect2 = await inspectSession2(sessionId)
      assert.equal(
        sessInspect2?.externalSessionId,
        expectedExternalThreadId,
        'External Codex thread ID must persist across restart',
      )
      assert.equal(sessInspect2?.resumable, true, 'Session must remain resumable after restart')
      assert.equal(sessInspect2?.quarantined, false, 'Session must not be quarantined after clean cancel')

      const msgsBefore3 = await getMessages2(sessionId)
      assert.equal(
        msgsBefore3?.session?.accountId,
        expectedAccountId,
        'Session accountId must match original binding after restart',
      )
      const restoredRun1Text = extractAssistantTextForRun(msgsBefore3.messages, evidence.runs[0].runId)
      assert.match(restoredRun1Text, /ALPHA0_OK/, 'Restored conversation must retain Prompt 1 assistant reply')

      const composer2 = page2.getByLabel('Message Chief of Staff')
      budget.consume('Prompt 3')
      evidence.attemptedTurns = budget.getAttemptedTurns()
      await composer2.fill(
        'What exact token did I ask you to reply with in my first message? Reply with that token only.',
      )
      await page2.getByRole('button', { name: 'Send message' }).click()

      const run3Id = await waitForNewRunId(
        getMessages2,
        sessionId,
        knownRunIds,
        runDetectTimeoutMs,
        pollIntervalMs,
      )
      knownRunIds.add(run3Id)
      const run3 = await waitForRunTerminalIpc(getRun2, run3Id, runTerminalTimeoutMs, pollIntervalMs)
      const msgs3 = await getMessages2(sessionId)
      assert.equal(
        msgs3?.session?.accountId,
        expectedAccountId,
        'Session accountId must remain unchanged after Prompt 3',
      )
      assert.equal(
        msgs3?.session?.externalSessionId,
        expectedExternalThreadId,
        'External Codex thread ID must remain unchanged after Prompt 3',
      )
      const run3AssistantText = extractAssistantTextForRun(msgs3.messages, run3Id)
      const events3 = await getRunEvents2(run3Id)
      const evList3 = Array.isArray(events3?.events) ? events3.events : []
      const usage3 = evList3.findLast?.((ev) => ev?.type === 'usage.updated')?.payload ?? 'unavailable'
      const deltaCount3 = evList3.filter((ev) => ev?.type === 'message.delta').length
      const terminalEvt3 =
        evList3.findLast?.(
          (ev) =>
            ev?.type === 'run.completed' ||
            ev?.type === 'run.failed' ||
            ev?.type === 'run.cancelled' ||
            ev?.type === 'run.interrupted',
        )?.type ?? null

      evidence.runs.push({
        prompt: 3,
        runId: run3Id,
        status: run3.status,
        assistantReplyMatched: /ALPHA0_OK/.test(run3AssistantText),
        deltaEventCount: deltaCount3,
        terminalEvent: terminalEvt3,
        usage: usage3,
      })

      assert.equal(run3.status, 'completed', `Prompt 3 expected completed, got ${run3.status}`)
      assert.match(run3AssistantText, /ALPHA0_OK/, 'Prompt 3 assistant message must recall ALPHA0_OK')
    } finally {
      await app2.close()
    }

    // Verify SQLite durable state matches IPC evidence
    const db = openDb(join(dataDir, 'ghost-bot.sqlite'))
    try {
      const sessRow = db
        .prepare('SELECT external_session_id, account_id, runtime_id FROM sessions WHERE id = ?')
        .get(sessionId)
      assert.equal(sessRow?.external_session_id, expectedExternalThreadId)
      assert.equal(sessRow?.account_id, expectedAccountId)
      assert.equal(sessRow?.runtime_id, 'codex')
      evidence.accountBindingVerified = true

      const dbRuns = db
        .prepare('SELECT id, status, permission_mode FROM runs WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId)
      assert.equal(dbRuns.length, 3)
      assert.deepEqual(
        dbRuns.map((r) => r.id),
        evidence.runs.map((r) => r.runId),
      )
      assert.equal(dbRuns[0].status, 'completed')
      assert.equal(dbRuns[1].status, 'cancelled')
      assert.equal(dbRuns[2].status, 'completed')
      assert.ok(dbRuns.every((r) => r.permission_mode === 'read-only'))
    } finally {
      db.close()
    }

    // Verify read-only sentinel and workspace integrity
    const files = await fsApi.readdir(workspaceDir)
    assert.deepEqual(files, ['sentinel.txt'])
    assert.equal(await fsApi.readFile(sentinelPath, 'utf8'), 'DO_NOT_MODIFY_IN_READ_ONLY')
    evidence.workspaceIntact = true
    evidence.alpha0LiveAcceptance = 'passed'
    return evidence
  } catch (err) {
    evidence.error = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    try {
      const files = await fsApi.readdir(workspaceDir).catch(() => [])
      const content = await fsApi.readFile(sentinelPath, 'utf8').catch(() => null)
      evidence.workspaceIntact =
        files.length === 1 && files[0] === 'sentinel.txt' && content === 'DO_NOT_MODIFY_IN_READ_ONLY'
    } catch {
      evidence.workspaceIntact = false
    }
    emitLog(evidence)
    await fsApi.rm(dataDir, { recursive: true, force: true })
    await fsApi.rm(workspaceDir, { recursive: true, force: true })
  }
}

const isDirectEntry =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectEntry) {
  if (process.env.GHOST_BOT_RUN_LIVE_CODEX !== '1') {
    console.log(
      'Skipping Alpha.0 live Codex E2E (set GHOST_BOT_RUN_LIVE_CODEX=1 with explicit authorization to run).',
    )
    process.exit(0)
  }
  await runAlpha0LiveAcceptance()
}
