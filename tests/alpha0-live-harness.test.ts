import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'
import {
  MessagesListResponseSchema,
  SessionInspectionResponseSchema,
} from '../packages/shared-types/ipc.ts'
import {
  createTurnBudgetTracker,
  extractAssistantTextForRun,
  runAlpha0LiveAcceptance,
} from '../scripts/verify-alpha0-live-codex.mjs'

function createSyntheticHarnessDeps(scenario: {
  delayRunCreationPolls?: number
  delayStopMountCalls?: number
  prompt1AssistantText?: string
  prompt2FinalStatus?: 'completed' | 'cancelled'
  prompt3FinalStatus?: 'completed' | 'interrupted'
  prompt3AssistantText?: string
  restartDropsThread?: boolean
  restartChangesAccount?: boolean
}) {
  const operations: string[] = []
  let launchCount = 0
  let promptIndex = 0
  const sessionId = 'sess_synth_1'
  let externalSessionId: string | null = null
  const initialAccountId = 'chatgpt:plus-primary'
  let currentAccountId = initialAccountId
  const runs = new Map<string, { id: string; status: string; permission_mode: string }>()
  const messages: Array<{ id: string; role: string; text: string; runId: string }> = []
  const runEvents = new Map<string, Array<{ type: string; payload: unknown }>>()
  const emittedEvidence: Array<Record<string, unknown>> = []
  const deletedDirs: string[] = []
  const createdFiles = new Map<string, string>()

  const fsApi = {
    async mkdtemp(prefix: string) {
      return `${prefix}synth-${Math.random().toString(36).slice(2, 7)}`
    },
    async writeFile(p: string, data: string) {
      createdFiles.set(p, data)
    },
    async readdir() {
      return ['sentinel.txt']
    },
    async readFile(p: string) {
      return createdFiles.get(p) ?? ''
    },
    async rm(p: string) {
      operations.push(`rm:${p}`)
      deletedDirs.push(p)
    },
  }

  const openDb = () => ({
    prepare(sql: string) {
      return {
        get() {
          if (sql.includes('FROM sessions')) {
            return {
              external_session_id: externalSessionId,
              account_id: currentAccountId,
              runtime_id: 'codex',
            }
          }
          return undefined
        },
        all() {
          if (sql.includes('FROM runs')) {
            return Array.from(runs.values())
          }
          return []
        },
      }
    },
    close() {},
  })

  const launchDesktop = async () => {
    launchCount += 1
    const currentLaunch = launchCount
    if (currentLaunch === 2 && scenario.restartChangesAccount) {
      currentAccountId = 'chatgpt:other-account'
    }
    let listMessagesPollCount = 0
    let stopCheckCount = 0
    let pendingPromptRunId: string | null = null

    const page = {
      async waitForSelector(selector: string) {
        if (selector.includes('Stop generation')) {
          const needed = scenario.delayStopMountCalls ?? 0
          stopCheckCount += 1
          if (stopCheckCount <= needed) {
            await new Promise((r) => setTimeout(r, 15))
          }
          if (scenario.prompt2FinalStatus === 'completed') {
            throw new Error('Timeout waiting for Stop generation')
          }
        }
      },
      locator() {
        return {
          async isVisible() {
            return scenario.prompt2FinalStatus !== 'completed'
          },
          async click() {
            if (pendingPromptRunId) {
              const r = runs.get(pendingPromptRunId)
              if (r && r.status === 'running') {
                r.status = 'cancelled'
                runEvents.get(pendingPromptRunId)?.push({ type: 'run.cancelled', payload: {} })
              }
            }
          },
        }
      },
      getByLabel() {
        return {
          async fill() {},
        }
      },
      getByRole() {
        return {
          async click() {
            promptIndex += 1
            const idx = promptIndex
            const runId = `run_synth_${idx}`
            pendingPromptRunId = runId
            listMessagesPollCount = 0

            const finalStatus =
              idx === 1
                ? 'completed'
                : idx === 2
                  ? (scenario.prompt2FinalStatus ?? 'cancelled')
                  : (scenario.prompt3FinalStatus ?? 'completed')

            runs.set(runId, {
              id: runId,
              status: idx === 2 && finalStatus === 'cancelled' ? 'running' : finalStatus,
              permission_mode: 'read-only',
            })

            const userText =
              idx === 1
                ? 'Reply with exactly ALPHA0_OK.'
                : idx === 2
                  ? 'Write 40 primes.'
                  : 'Repeat token.'
            const assistantText =
              idx === 1
                ? (scenario.prompt1AssistantText ?? 'ALPHA0_OK')
                : idx === 2
                  ? 'Partial prime 2'
                  : (scenario.prompt3AssistantText ?? 'ALPHA0_OK')

            if (idx === 1) {
              externalSessionId = 'thr_synth_123'
            }

            const delayPolls = scenario.delayRunCreationPolls ?? 0
            setTimeout(() => {
              messages.push({ id: `m_u_${idx}`, role: 'user', text: userText, runId })
              messages.push({ id: `m_a_${idx}`, role: 'assistant', text: assistantText, runId })
              const evs: Array<{ type: string; payload: unknown }> = [
                { type: 'message.delta', payload: { delta: assistantText } },
                { type: 'usage.updated', payload: { inputTokens: 10, outputTokens: 5, isMock: false } },
              ]
              if (finalStatus === 'completed') {
                evs.push({ type: 'run.completed', payload: {} })
              }
              runEvents.set(runId, evs)
            }, delayPolls * 10)
          },
        }
      },
      async reload() {},
      async evaluate(fn: (...args: unknown[]) => unknown, arg?: unknown) {
        const src = fn.toString()
        if (src.includes('getRuntimeSnapshot')) {
          return {
            status: 'available',
            authMethod: 'chatgpt',
            codexVersion: '0.172.0',
            models: [{ id: 'gpt-5-codex', efforts: ['medium'] }],
            usageStatus: 'available',
            usageWindows: [{ label: '5h', usedPercent: 1, resetAt: null }],
          }
        }
        if (src.includes('listBots')) {
          return { bots: [{ id: 'bot-chief' }] }
        }
        if (src.includes('updateBot')) {
          return { id: 'bot-chief' }
        }
        if (src.includes('createSession')) {
          return { id: sessionId }
        }
        if (src.includes('listMessages')) {
          listMessagesPollCount += 1
          const visibleMessages =
            listMessagesPollCount <= (scenario.delayRunCreationPolls ?? 0)
              ? messages.slice(0, Math.max(0, messages.length - 2))
              : messages
          // Conforms to MessagesListResponseSchema (SessionRecord carries accountId)
          return {
            session: {
              id: sessionId,
              agentId: 'bot-chief',
              accountId: currentAccountId,
              runtimeId: 'codex',
              externalSessionId,
              title: 'Alpha.0 Live Acceptance',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              archivedAt: null,
              activeRunId: null,
              activeRunStatus: null,
            },
            messages: visibleMessages,
            total: visibleMessages.length,
            hasMore: false,
          }
        }
        if (src.includes('getRunEvents')) {
          return { events: runEvents.get(String(arg)) ?? [] }
        }
        if (src.includes('getRun')) {
          return runs.get(String(arg)) ?? null
        }
        if (src.includes('inspectSession')) {
          // Conforms strictly to SessionInspectionResponseSchema (NO accountId field)
          return {
            sessionId,
            agentId: 'bot-chief',
            runtimeId: 'codex',
            externalSessionId:
              currentLaunch === 2 && scenario.restartDropsThread ? 'thr_different' : externalSessionId,
            providerThreadStatus: 'accessible',
            resumable: true,
            reason: 'ok',
            quarantined: false,
            lastRun: null,
            approvalsCount: 0,
          }
        }
        return null
      },
    }

    return {
      async firstWindow() {
        return page
      },
      async close() {},
    }
  }

  return {
    deps: {
      env: { GHOST_BOT_RUN_LIVE_CODEX: '1' },
      pollIntervalMs: 5,
      runDetectTimeoutMs: 1000,
      runTerminalTimeoutMs: 1000,
      stopMountTimeoutMs: 100,
      fsApi,
      openDb,
      launchDesktop,
      emitLog(payload: Record<string, unknown>) {
        operations.push('emitLog')
        emittedEvidence.push(payload)
      },
    },
    emittedEvidence,
    deletedDirs,
    operations,
  }
}

test('Alpha.0 harness enforces opt-in guard and 3-prompt maximum budget', async () => {
  let launched = false
  const skipped = await runAlpha0LiveAcceptance({
    env: {},
    launchDesktop: async () => {
      launched = true
      throw new Error('Should not launch')
    },
  })
  assert.equal(skipped.skipped, true)
  assert.equal(launched, false)

  const budget = createTurnBudgetTracker(3)
  assert.equal(budget.consume('t1'), 1)
  assert.equal(budget.consume('t2'), 2)
  assert.equal(budget.consume('t3'), 3)
  assert.throws(() => budget.consume('t4'), /Budget exceeded \(3\)/)
})

test('HARNESS-01: Harness validates against real IPC schemas (inspectSession without accountId, SessionRecord with accountId) and succeeds with unchanged binding', async () => {
  const { deps, emittedEvidence, deletedDirs } = createSyntheticHarnessDeps({
    delayRunCreationPolls: 2,
    delayStopMountCalls: 1,
    prompt2FinalStatus: 'cancelled',
    prompt3FinalStatus: 'completed',
  })

  const result = await runAlpha0LiveAcceptance(deps)
  assert.equal(result.alpha0LiveAcceptance, 'passed')
  assert.equal(result.accountBindingVerified, true)
  assert.equal(result.externalThreadBound, true)
  assert.equal(result.attemptedTurns, 3)
  assert.equal(result.runs.length, 3)
  assert.equal(result.runs[0].status, 'completed')
  assert.equal(result.runs[1].status, 'cancelled')
  assert.equal(result.runs[2].status, 'completed')
  assert.equal(emittedEvidence.length, 1)
  // Ensure raw accountId / threadId are not leaked in sanitized log
  assert.equal('accountId' in emittedEvidence[0], false)
  assert.equal('externalThreadId' in emittedEvidence[0], false)
  assert.equal(deletedDirs.length, 2)
})

test('HARNESS-01: Rejects account binding changes across restart, cancellation-before-stop, interrupted restart, and user-prompt spoofing', async () => {
  const acctFail = createSyntheticHarnessDeps({
    prompt2FinalStatus: 'cancelled',
    restartChangesAccount: true,
  })
  await assert.rejects(
    () => runAlpha0LiveAcceptance(acctFail.deps),
    /accountId must match original binding after restart/i,
  )
  assert.equal(acctFail.emittedEvidence.length, 1)

  const cancelFail = createSyntheticHarnessDeps({
    prompt2FinalStatus: 'completed',
  })
  await assert.rejects(() => runAlpha0LiveAcceptance(cancelFail.deps), /Cancellation not verified/i)
  assert.equal(cancelFail.emittedEvidence.length, 1)
  assert.equal(cancelFail.emittedEvidence[0].alpha0LiveAcceptance, 'failed')
  assert.equal(cancelFail.operations.indexOf('emitLog') < cancelFail.operations.findIndex((o) => o.startsWith('rm:')), true)

  const restartFail = createSyntheticHarnessDeps({
    prompt2FinalStatus: 'cancelled',
    prompt3FinalStatus: 'interrupted',
  })
  await assert.rejects(() => runAlpha0LiveAcceptance(restartFail.deps), /Prompt 3 expected completed, got interrupted/)
  assert.equal(restartFail.emittedEvidence.length, 1)

  const spoofFail = createSyntheticHarnessDeps({
    prompt1AssistantText: 'I cannot comply',
  })
  await assert.rejects(() => runAlpha0LiveAcceptance(spoofFail.deps), /Prompt 1 assistant message must contain ALPHA0_OK/)
  assert.equal(extractAssistantTextForRun([{ role: 'user', text: 'ALPHA0_OK', runId: 'r1' }], 'r1'), '')
})

type LinuxProcessSnapshot = {
  pid: number
  commandLine: string
  state: string
  startTime: string
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ESRCH')
  )
}

function readLinuxProcessSnapshot(pid: number): LinuxProcessSnapshot | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const statFields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    const state = status.match(/^State:\s+([A-Z])/m)?.[1]
    const startTime = statFields[19]
    assert.ok(state && startTime, `Linux process ${pid} has incomplete identity data`)
    return { pid, commandLine, state, startTime }
  } catch (error) {
    if (isMissingProcess(error)) return undefined
    throw error
  }
}

function readLinuxChildPids(pid: number): number[] {
  let threadIds: string[]
  try {
    threadIds = readdirSync(`/proc/${pid}/task`).filter((entry) => /^\d+$/.test(entry))
  } catch (error) {
    if (isMissingProcess(error)) return []
    throw error
  }

  const childPids = new Set<number>()
  for (const threadId of threadIds) {
    try {
      const children = readFileSync(`/proc/${pid}/task/${threadId}/children`, 'utf8')
      for (const childPid of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
        childPids.add(childPid)
      }
    } catch (error) {
      if (isMissingProcess(error)) continue
      throw error
    }
  }
  return [...childPids]
}

/**
 * Captures currently parented descendants, including children forked by non-leader
 * threads. A process already detached or reparented before this scan is not
 * discoverable from rootPid; this is not an exhaustive ownership inventory.
 */
function collectTrackedProcessTree(rootPid: number): LinuxProcessSnapshot[] {
  const pending = [rootPid]
  const visited = new Set<number>()
  const processes: LinuxProcessSnapshot[] = []

  while (pending.length > 0) {
    const pid = pending.pop()!
    if (visited.has(pid)) continue
    visited.add(pid)
    const process = readLinuxProcessSnapshot(pid)
    if (!process || process.state === 'Z') continue
    processes.push(process)
    pending.push(...readLinuxChildPids(pid))
  }

  return processes
}

function isSameLiveProcess(snapshot: LinuxProcessSnapshot): boolean {
  const current = readLinuxProcessSnapshot(snapshot.pid)
  return Boolean(current && current.state !== 'Z' && current.startTime === snapshot.startTime)
}

async function waitForTrackedProcessesToExit(
  processes: LinuxProcessSnapshot[],
  timeoutMs = 5000,
): Promise<LinuxProcessSnapshot[]> {
  const deadline = Date.now() + timeoutMs
  let remaining = processes.filter(isSameLiveProcess)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    remaining = processes.filter(isSameLiveProcess)
  }
  return remaining
}

function writeCleanupDiagnostic(
  tempRoot: string,
  reason: string,
  processes: LinuxProcessSnapshot[],
): void {
  writeFileSync(
    join(tempRoot, 'ipc-smoke-cleanup-diagnostic.json'),
    JSON.stringify(
      { reason, processes: processes.map(({ pid, state }) => ({ pid, state })) },
      null,
      2,
    ),
    { mode: 0o600 },
  )
}

function isTrackedProcessSetStopped(
  rootPid: number | undefined,
  trackedProcesses: LinuxProcessSnapshot[],
  remaining: LinuxProcessSnapshot[],
  captureError?: unknown,
  waitError?: unknown,
): boolean {
  return (
    !captureError &&
    !waitError &&
    Boolean(rootPid && trackedProcesses.some((process) => process.pid === rootPid)) &&
    remaining.length === 0
  )
}

function cleanupTemporaryProfile(
  tempRoot: string,
  shutdownVerified: boolean,
  processes: LinuxProcessSnapshot[],
): 'removed' | 'retained' {
  if (!shutdownVerified) {
    writeCleanupDiagnostic(
      tempRoot,
      'Tracked Electron/daemon process shutdown was not confirmed; temporary profile retained',
      processes,
    )
    return 'retained'
  }

  rmSync(tempRoot, { recursive: true, force: true })
  if (existsSync(tempRoot)) throw new Error('Temporary IPC profile remains after removal')
  return 'removed'
}

function waitForChildLine(child: ChildProcess, lines: Interface, expected: string): Promise<void> {
  return new Promise((resolveLine, rejectLine) => {
    const cleanup = () => {
      lines.off('line', onLine)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onLine = (line: string) => {
      if (line !== expected) return
      cleanup()
      resolveLine()
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      rejectLine(new Error(`Owned child exited before emitting ${expected}: code=${code}, signal=${signal}`))
    }
    const onError = (error: Error) => {
      cleanup()
      rejectLine(error)
    }
    lines.on('line', onLine)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timer)
      resolveExit(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function stopOwnedChild(child: ChildProcess): Promise<boolean> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return true
  const gracefulExit = waitForChildExit(child, 1500)
  child.kill('SIGTERM')
  if (await gracefulExit) return true
  const forcedExit = waitForChildExit(child, 1500)
  child.kill('SIGKILL')
  return forcedExit
}

function cleanupTestProfileAfterOwnedChild(
  tempRoot: string,
  childStopped: boolean,
  snapshot: LinuxProcessSnapshot | undefined,
): void {
  if (childStopped && (!snapshot || !isSameLiveProcess(snapshot))) {
    rmSync(tempRoot, { recursive: true, force: true })
  } else if (existsSync(tempRoot)) {
    try {
      writeCleanupDiagnostic(
        tempRoot,
        'Regression child shutdown was not confirmed; temporary profile retained',
        snapshot ? [snapshot] : [],
      )
    } catch {
      // Keep the profile in place if diagnostic writing also fails.
    }
  }
}

test('Cleanup retains the profile when a live process changes its title without changing identity', async (t) => {
  assert.equal(process.platform, 'linux', 'The controlled process identity regression requires Linux /proc')
  const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-process-identity-regression-'))
  chmodSync(tempRoot, 0o700)
  const profileDir = join(tempRoot, 'profile')
  mkdirSync(profileDir, { mode: 0o700 })

  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGUSR1', () => { process.title = 'ghost-qa-title-after'; process.stdout.write('renamed\\n') }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
      '--',
      '--ghost-qa-title-before',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const lines = createInterface({ input: child.stdout! })
  let snapshot: LinuxProcessSnapshot | undefined

  try {
    await waitForChildLine(child, lines, 'ready')
    const childPid = child.pid
    assert.ok(childPid && childPid > 0, 'The spawned regression child has no PID')
    snapshot = readLinuxProcessSnapshot(childPid)
    assert.ok(snapshot, `Regression child ${childPid} has no readable procfs identity`)
    const initialCommandLine = snapshot.commandLine

    const renamed = waitForChildLine(child, lines, 'renamed')
    assert.equal(child.kill('SIGUSR1'), true, 'Could not signal the owned regression child')
    await renamed

    const changedTitleProcess = readLinuxProcessSnapshot(childPid)
    assert.ok(changedTitleProcess && changedTitleProcess.state !== 'Z', 'Regression child exited during title change')
    assert.equal(changedTitleProcess.pid, snapshot.pid)
    assert.equal(changedTitleProcess.startTime, snapshot.startTime)
    assert.notEqual(
      changedTitleProcess.commandLine,
      initialCommandLine,
      'The controlled child title change did not update its procfs command line',
    )

    const trackedAfterTitleChange = isSameLiveProcess(snapshot)
    const remainingWhileAlive = await waitForTrackedProcessesToExit([snapshot], 150)
    const shutdownVerifiedWhileAlive = isTrackedProcessSetStopped(
      childPid,
      [snapshot],
      remainingWhileAlive,
    )
    const dispositionWhileAlive = cleanupTemporaryProfile(
      tempRoot,
      shutdownVerifiedWhileAlive,
      remainingWhileAlive.length > 0 ? remainingWhileAlive : [snapshot],
    )
    const processAfterCleanupDecision = readLinuxProcessSnapshot(childPid)
    const observations = {
      trackedAfterTitleChange,
      remainingWhileAlive: remainingWhileAlive.map((process) => process.pid),
      shutdownVerifiedWhileAlive,
      dispositionWhileAlive,
      profileRetainedWhileChildAlive: existsSync(tempRoot),
      childStillAlive: Boolean(processAfterCleanupDecision && processAfterCleanupDecision.state !== 'Z'),
      cleanupDiagnosticWritten: existsSync(join(tempRoot, 'ipc-smoke-cleanup-diagnostic.json')),
    }
    assert.deepEqual(observations, {
      trackedAfterTitleChange: true,
      remainingWhileAlive: [childPid],
      shutdownVerifiedWhileAlive: false,
      dispositionWhileAlive: 'retained',
      profileRetainedWhileChildAlive: true,
      childStillAlive: true,
      cleanupDiagnosticWritten: true,
    })

    assert.equal(await stopOwnedChild(child), true, 'Owned regression child did not stop')
    const remainingAfterExit = await waitForTrackedProcessesToExit([snapshot], 250)
    const shutdownVerifiedAfterExit = isTrackedProcessSetStopped(
      childPid,
      [snapshot],
      remainingAfterExit,
    )
    assert.equal(shutdownVerifiedAfterExit, true, 'Stopped child identity remained live')
    assert.equal(cleanupTemporaryProfile(tempRoot, shutdownVerifiedAfterExit, []), 'removed')
    assert.equal(existsSync(tempRoot), false, 'Temporary profile remained after the owned child exited')
    t.diagnostic(
      `Process identity regression passed: PID ${childPid} retained startTime after title change; profile retained until child exit.`,
    )
  } finally {
    lines.close()
    const childStopped = await stopOwnedChild(child)
    cleanupTestProfileAfterOwnedChild(tempRoot, childStopped, snapshot)
  }
})

test('Offline Electron/daemon IPC smoke check verifies Chromium sandbox and IPC schemas', async (t) => {
  assert.equal(process.platform, 'linux', 'Renderer OS sandbox evidence requires Linux /proc')
  assert.ok(readFileSync('/proc/self/status', 'utf8'), 'Linux /proc status must be available')

  const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-harness-ipc-smoke-'))
  const dataDir = join(tempRoot, 'data')
  const profileDir = join(tempRoot, 'electron-profile')
  const mainPath = resolve('apps/desktop/dist-electron/main.js')
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  let launchAttempted = false
  let launchError: unknown
  let rendererPid = 0
  let testError: unknown

  try {
    chmodSync(tempRoot, 0o700)
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    chmodSync(dataDir, 0o700)
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    chmodSync(profileDir, 0o700)

    const electronEnv = { ...process.env }
    delete electronEnv.ELECTRON_RUN_AS_NODE
    delete electronEnv.ELECTRON_DISABLE_SANDBOX
    delete electronEnv.GHOST_BOT_DEV_URL
    delete electronEnv.NODE_OPTIONS
    delete electronEnv.NODE_PATH

    launchAttempted = true
    try {
      app = await electron.launch({
        args: [
          ...(process.env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : []),
          mainPath,
          `--user-data-dir=${profileDir}`,
        ],
        chromiumSandbox: true,
        timeout: 30_000,
        env: {
          ...electronEnv,
          GHOST_BOT_DATA_DIR: dataDir,
          GHOST_BOT_RUNTIME_MODE: 'mock',
          GHOST_BOT_SMOKE_EXIT: '0',
          GHOST_SECRET_NAMESPACE: `harness-ipc-${randomUUID()}`,
        },
      })
    } catch (error) {
      launchError = error
      throw error
    }

    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    assert.match(win.url(), /^file:/, 'IPC smoke must use the built renderer, not a development URL')
    assert.equal(await win.evaluate(() => Boolean(window.ghostBot)), true, 'Built renderer preload bridge did not load')

    const security = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents
      const preferences = webContents?.getLastWebPreferences()
      const rendererPid = webContents?.getOSProcessId() ?? 0
      return {
        noSandbox: electronApp.commandLine.hasSwitch('no-sandbox'),
        rendererPid,
        rendererProcessType: electronApp.getAppMetrics().find((metric) => metric.pid === rendererPid)?.type,
        sandbox: preferences?.sandbox,
        contextIsolation: preferences?.contextIsolation,
        nodeIntegration: preferences?.nodeIntegration,
      }
    })
    const { rendererPid: actualRendererPid, rendererProcessType, ...preferences } = security
    assert.deepEqual(preferences, {
      noSandbox: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
    assert.ok(actualRendererPid > 0, 'Electron did not report a renderer OS process')
    assert.equal(
      rendererProcessType,
      'Tab',
      `Electron does not identify OS PID ${actualRendererPid} as the tested renderer process`,
    )
    rendererPid = actualRendererPid

    const rendererStatus = readFileSync(`/proc/${rendererPid}/status`, 'utf8')
    const rendererProcess = readLinuxProcessSnapshot(rendererPid)
    assert.ok(rendererProcess, `Renderer process ${rendererPid} does not exist in /proc`)
    assert.doesNotMatch(rendererProcess.commandLine, /(?:^|\s)--no-sandbox(?:=|\s|$)/)
    const seccomp = rendererStatus.match(/^Seccomp:\s+(\d+)$/m)?.[1]
    const noNewPrivs = rendererStatus.match(/^NoNewPrivs:\s+(\d+)$/m)?.[1]
    assert.equal(seccomp, '2', `Renderer ${rendererPid} is not under seccomp filtering`)
    assert.equal(noNewPrivs, '1', `Renderer ${rendererPid} lacks NoNewPrivs`)
    t.diagnostic(
      `Sandbox evidence: renderer OS PID ${rendererPid} (Electron process metric type=Tab); Chromium sandbox=true; Seccomp=${seccomp}; NoNewPrivs=${noNewPrivs}; effective --no-sandbox absent.`,
    )

    const nodeGlobals = await win.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    }))
    assert.deepEqual(nodeGlobals, { require: 'undefined', process: 'undefined' })

    const bots = (await win.evaluate(() => window.ghostBot.listBots())) as {
      bots: Array<{ id: string }>
    }
    assert.ok(bots.bots.length > 0, 'IPC smoke requires a discovered bot')
    const created = (await win.evaluate(
      (id) => window.ghostBot.createSession({ agentId: id, title: 'IPC Smoke' }),
      bots.bots[0].id,
    )) as { id: string }
    assert.ok(created.id.length > 0, 'IPC smoke requires a created session')

    const msgsPayload = await win.evaluate(
      (id) => window.ghostBot.listMessages({ sessionId: id }),
      created.id,
    )
    const parsedMsgs = MessagesListResponseSchema.parse(msgsPayload)
    assert.ok(parsedMsgs.session.accountId.length > 0)

    const inspectPayload = await win.evaluate(
      (id) => window.ghostBot.inspectSession(id),
      created.id,
    )
    const parsedInspect = SessionInspectionResponseSchema.parse(inspectPayload)
    assert.equal('accountId' in parsedInspect, false)

    const runtimePid = app.process().pid
    assert.ok(runtimePid && runtimePid > 0, 'Electron main process has no valid PID')
    const trackedProcesses = collectTrackedProcessTree(runtimePid)
    assert.ok(trackedProcesses.some((item) => item.pid === rendererPid), 'Renderer is outside the captured Electron process tree')
    assert.ok(
      trackedProcesses.every((item) => !/(?:^|\s)--no-sandbox(?:=|\s|$)/.test(item.commandLine)),
      'A captured Electron or daemon process has the --no-sandbox switch',
    )
    assert.ok(
      trackedProcesses.some((item) => item.commandLine.includes(resolve('apps/daemon/src/index.ts'))),
      'IPC smoke did not start a captured source daemon process',
    )
  } catch (error) {
    testError = error
  }

  let cleanupError: unknown
  if (app) {
    const runtimePid = app.process().pid
    let trackedProcesses: LinuxProcessSnapshot[] = []
    let captureError: unknown
    if (!runtimePid || runtimePid <= 0) {
      captureError = new Error('Electron main process has no valid PID')
    } else {
      try {
        trackedProcesses = collectTrackedProcessTree(runtimePid)
      } catch (error) {
        captureError = error
      }
    }

    let closeError: unknown
    try {
      await app.close()
    } catch (error) {
      closeError = error
    }

    let remaining: LinuxProcessSnapshot[] = []
    let waitError: unknown
    try {
      remaining = await waitForTrackedProcessesToExit(trackedProcesses)
    } catch (error) {
      waitError = error
    }
    const shutdownVerified = isTrackedProcessSetStopped(
      runtimePid,
      trackedProcesses,
      remaining,
      captureError,
      waitError,
    )
    if (!shutdownVerified) {
      let diagnosticError: unknown
      try {
        cleanupTemporaryProfile(
          tempRoot,
          false,
          remaining.length > 0 ? remaining : trackedProcesses,
        )
      } catch (error) {
        diagnosticError = error
      }
      cleanupError = new Error(`IPC smoke could not confirm tracked-process shutdown; retained ${tempRoot}`, {
        cause: captureError ?? waitError ?? closeError ?? diagnosticError,
      })
    } else {
      try {
        assert.equal(cleanupTemporaryProfile(tempRoot, true, []), 'removed')
        t.diagnostic(`Cleanup verified: captured Electron and daemon process snapshots exited; removed ${tempRoot}.`)
      } catch (error) {
        cleanupError = error
      }
      cleanupError ??= closeError
    }
  } else if (launchAttempted) {
    const launchReason =
      launchError instanceof Error ? launchError.message : String(launchError ?? 'unknown launch failure')
    let diagnosticError: unknown
    try {
      writeCleanupDiagnostic(
        tempRoot,
        `Playwright launch returned no application handle; shutdown cannot be verified: ${launchReason}`,
        [],
      )
    } catch (error) {
      diagnosticError = error
    }
    cleanupError = new Error(`Electron launch cleanup is unconfirmed; retained ${tempRoot}`, {
      cause: launchError ?? diagnosticError,
    })
  } else {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
      if (existsSync(tempRoot)) throw new Error('Temporary IPC profile remains after removal')
    } catch (error) {
      cleanupError = error
    }
  }

  if (testError && cleanupError) {
    throw new AggregateError([testError, cleanupError], 'IPC smoke failed and cleanup could not be fully verified')
  }
  if (testError) throw testError
  if (cleanupError) throw cleanupError
})
