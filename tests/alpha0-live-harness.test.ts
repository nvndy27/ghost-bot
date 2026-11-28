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

function readLinuxParentPid(pid: number): number | undefined {
  try {
    const status = readFileSync('/proc/' + pid + '/status', 'utf8')
    const parentPid = status.match(/^PPid:\s+(\d+)$/m)?.[1]
    assert.ok(parentPid, 'Linux process ' + pid + ' has no parent PID')
    return Number(parentPid)
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
 * discoverable from rootPid; this is a point-in-time capture. Successful captures
 * are merged into a persistent inventory so later scans cannot forget observed PIDs.
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

type TrackedProcessInventory = Map<string, LinuxProcessSnapshot>

function processIdentityKey(processSnapshot: LinuxProcessSnapshot): string {
  return processSnapshot.pid + ':' + processSnapshot.startTime
}

function mergeTrackedProcessInventory(
  inventory: TrackedProcessInventory,
  capturedProcesses: LinuxProcessSnapshot[],
): void {
  for (const processSnapshot of capturedProcesses) {
    inventory.set(processIdentityKey(processSnapshot), processSnapshot)
  }
}

function captureAndMergeTrackedProcessTree(
  inventory: TrackedProcessInventory,
  rootPid: number,
): LinuxProcessSnapshot[] {
  const capturedProcesses = collectTrackedProcessTree(rootPid)
  mergeTrackedProcessInventory(inventory, capturedProcesses)
  return capturedProcesses
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
      { reason, processes: processes.map(({ pid, state, startTime }) => ({ pid, state, startTime })) },
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

type ParentDescendantFixture = {
  parent: ChildProcess
  lines: Interface
  parentPid: number
  intermediate: LinuxProcessSnapshot
  descendant: LinuxProcessSnapshot
  inventory: TrackedProcessInventory
}

async function startParentDescendantFixture(tempRoot: string): Promise<ParentDescendantFixture> {
  const descendantScript = [
    "const readline = require('node:readline')",
    'const lines = readline.createInterface({ input: process.stdin })',
    "lines.on('line', (line) => { if (line === 'shutdown') { process.stdout.write('descendant-stopping\\n'); process.exit(0) } })",
    "process.stdout.write('descendant-ready\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const intermediateScript = [
    "const { spawn } = require('node:child_process')",
    "process.on('SIGUSR1', () => process.exit(0))",
    "spawn(process.execPath, ['-e', " + JSON.stringify(descendantScript) + "], { stdio: ['inherit', 'inherit', 'ignore'] })",
    "process.stdout.write('intermediate-ready\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const parentScript = [
    "const { spawn } = require('node:child_process')",
    "process.on('SIGUSR1', () => process.exit(0))",
    "spawn(process.execPath, ['-e', " + JSON.stringify(intermediateScript) + "], { stdio: ['inherit', 'inherit', 'ignore'] })",
    "process.stdout.write('parent-ready\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const parent = spawn(process.execPath, ['-e', parentScript], {
    cwd: tempRoot,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const lines = createInterface({ input: parent.stdout! })
  const inventory: TrackedProcessInventory = new Map()

  try {
    await Promise.all([
      waitForChildLine(parent, lines, 'parent-ready'),
      waitForChildLine(parent, lines, 'intermediate-ready'),
      waitForChildLine(parent, lines, 'descendant-ready'),
    ])
    const parentPid = parent.pid
    assert.ok(parentPid && parentPid > 0, 'The fixture parent has no PID')
    const capturedProcesses = captureAndMergeTrackedProcessTree(inventory, parentPid)
    const descendants = capturedProcesses.filter((processSnapshot) => processSnapshot.pid !== parentPid)
    assert.equal(descendants.length, 2, 'The fixture did not capture its intermediate and descendant')
    const intermediate = descendants.find(
      (processSnapshot) => readLinuxParentPid(processSnapshot.pid) === parentPid,
    )
    assert.ok(intermediate, 'The fixture intermediate process was not parented to the fixture root')
    const descendant = descendants.find(
      (processSnapshot) => readLinuxParentPid(processSnapshot.pid) === intermediate.pid,
    )
    assert.ok(descendant, 'The fixture descendant was not parented to the fixture intermediate')
    return { parent, lines, parentPid, intermediate, descendant, inventory }
  } catch (error) {
    const parentPid = parent.pid
    const rootSnapshot = [...inventory.values()].find(
      (processSnapshot) => processSnapshot.pid === parentPid,
    )
    const rootStillOwned = rootSnapshot
      ? isSameLiveProcess(rootSnapshot)
      : parent.exitCode === null && parent.signalCode === null
    if (parentPid && parentPid > 0 && rootStillOwned) {
      try {
        captureAndMergeTrackedProcessTree(inventory, parentPid)
      } catch {
        // Preserve the original fixture setup error; prior observations remain available.
      }
    }
    const cleanupSucceeded = await stopParentDescendantFixture(
      parent,
      lines,
      inventory,
      tempRoot,
      [...inventory.values()],
    )
    if (!cleanupSucceeded) {
      throw new AggregateError(
        [error, new Error('Fixture setup failed and an observed process could not be stopped; profile retained at ' + tempRoot)],
        'Parent/descendant fixture setup and cleanup failed',
      )
    }
    throw error
  }
}

async function stopParentDescendantFixture(
  parent: ChildProcess,
  lines: Interface,
  inventory: TrackedProcessInventory,
  tempRoot: string,
  knownIdentities: LinuxProcessSnapshot[],
): Promise<boolean> {
  let captureError: unknown
  const rootSnapshot = [...inventory.values()].find(
    (processSnapshot) => processSnapshot.pid === parent.pid,
  )
  const rootStillOwned = rootSnapshot
    ? isSameLiveProcess(rootSnapshot)
    : parent.exitCode === null && parent.signalCode === null
  if (parent.pid && parent.pid > 0 && rootStillOwned) {
    try {
      captureAndMergeTrackedProcessTree(inventory, parent.pid)
    } catch (error) {
      captureError = error
    }
  }
  mergeTrackedProcessInventory(inventory, knownIdentities)
  await stopOwnedChild(parent)

  const trackedProcesses = [...inventory.values()]
  let remaining: LinuxProcessSnapshot[] = []
  let waitError: unknown
  try {
    remaining = await waitForTrackedProcessesToExit(trackedProcesses, 300)
  } catch (error) {
    waitError = error
  }
  for (const trackedProcess of remaining) {
    if (!isSameLiveProcess(trackedProcess)) continue
    try {
      process.kill(trackedProcess.pid, 'SIGTERM')
    } catch (error) {
      if (!isMissingProcess(error)) throw error
    }
  }
  try {
    remaining = await waitForTrackedProcessesToExit(remaining, 1000)
  } catch (error) {
    waitError ??= error
  }
  for (const trackedProcess of remaining) {
    if (!isSameLiveProcess(trackedProcess)) continue
    try {
      process.kill(trackedProcess.pid, 'SIGKILL')
    } catch (error) {
      if (!isMissingProcess(error)) throw error
    }
  }
  try {
    remaining = await waitForTrackedProcessesToExit(remaining, 1000)
  } catch (error) {
    waitError ??= error
  }

  const shutdownVerified = isTrackedProcessSetStopped(
    parent.pid,
    trackedProcesses,
    remaining,
    captureError,
    waitError,
  )
  lines.close()
  if (shutdownVerified) {
    rmSync(tempRoot, { recursive: true, force: true })
    return !existsSync(tempRoot)
  }

  writeCleanupDiagnostic(
    tempRoot,
    'Fixture process shutdown was not confirmed; profile retained',
    remaining.length > 0 ? remaining : trackedProcesses,
  )
  return false
}

test('Observed descendant remains in cleanup inventory after reparenting', async (t) => {
  assert.equal(process.platform, 'linux', 'The reparenting regression requires Linux /proc')
  const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-reparented-process-regression-'))
  chmodSync(tempRoot, 0o700)
  const profileDir = join(tempRoot, 'profile')
  mkdirSync(profileDir, { mode: 0o700 })
  const fixture = await startParentDescendantFixture(tempRoot)
  const initiallyObserved = [...fixture.inventory.values()]

  try {
    const originalDescendant = fixture.inventory.get(processIdentityKey(fixture.descendant))
    assert.ok(originalDescendant, 'Initial tree capture did not record the descendant identity')
    const rootSnapshot = initiallyObserved.find(
      (processSnapshot) => processSnapshot.pid === fixture.parentPid,
    )
    assert.ok(rootSnapshot, 'Initial tree capture omitted the fixture root identity')
    assert.ok(
      initiallyObserved.some((processSnapshot) => processSnapshot.pid === fixture.intermediate.pid),
      'Initial tree capture omitted the fixture intermediate identity',
    )

    const intermediateExit = waitForTrackedProcessesToExit([fixture.intermediate], 1500)
    assert.equal(isSameLiveProcess(fixture.intermediate), true, 'Fixture intermediate identity changed before signaling')
    assert.equal(process.kill(fixture.intermediate.pid, 'SIGUSR1'), true, 'Could not release the descendant')
    assert.equal((await intermediateExit).length, 0, 'Fixture intermediate did not exit')
    assert.equal(isSameLiveProcess(rootSnapshot), true, 'Fixture root exited with its intermediate')

    const descendantAfterReparent = readLinuxProcessSnapshot(fixture.descendant.pid)
    assert.ok(descendantAfterReparent && descendantAfterReparent.state !== 'Z', 'Descendant did not remain alive')
    assert.equal(descendantAfterReparent.pid, fixture.descendant.pid)
    assert.equal(descendantAfterReparent.startTime, fixture.descendant.startTime)
    const newParentPid = readLinuxParentPid(fixture.descendant.pid)
    assert.ok(
      newParentPid !== undefined && newParentPid !== fixture.intermediate.pid,
      'Descendant was not reparented away from the intermediate process',
    )

    const finalTree = captureAndMergeTrackedProcessTree(fixture.inventory, fixture.parentPid)
    const rootInFinalTree = finalTree.some(
      (processSnapshot) => processSnapshot.pid === fixture.parentPid,
    )
    const descendantInFinalTree = finalTree.some(
      (processSnapshot) => processSnapshot.pid === fixture.descendant.pid,
    )

    const rootExit = waitForChildExit(fixture.parent, 1500)
    assert.equal(fixture.parent.kill('SIGUSR1'), true, 'Could not close the fixture root')
    assert.equal(await rootExit, true, 'Fixture root did not close')
    const descendantAfterRootExit = readLinuxProcessSnapshot(fixture.descendant.pid)
    assert.ok(descendantAfterRootExit && descendantAfterRootExit.state !== 'Z')
    assert.equal(descendantAfterRootExit.startTime, fixture.descendant.startTime)

    const descendantRetainedInInventory = fixture.inventory.has(processIdentityKey(fixture.descendant))
    const trackedProcesses = [...fixture.inventory.values()]
    const remainingWhileAlive = await waitForTrackedProcessesToExit(trackedProcesses, 150)
    const shutdownVerifiedWhileAlive = isTrackedProcessSetStopped(
      fixture.parentPid,
      trackedProcesses,
      remainingWhileAlive,
    )
    const dispositionWhileAlive = cleanupTemporaryProfile(
      tempRoot,
      shutdownVerifiedWhileAlive,
      remainingWhileAlive.length > 0 ? remainingWhileAlive : trackedProcesses,
    )
    const descendantAfterDecision = readLinuxProcessSnapshot(fixture.descendant.pid)
    const descendantStillAlive = Boolean(
      descendantAfterDecision &&
        descendantAfterDecision.state !== 'Z' &&
        descendantAfterDecision.startTime === fixture.descendant.startTime,
    )
    const observations = {
      initiallyCaptured: Boolean(originalDescendant),
      reparented: newParentPid !== undefined && newParentPid !== fixture.intermediate.pid,
      pidUnchanged: descendantAfterReparent.pid === fixture.descendant.pid,
      startTimeUnchanged: descendantAfterReparent.startTime === fixture.descendant.startTime,
      rootInFinalTree,
      absentFromFinalTree: !descendantInFinalTree,
      retainedInMergedInventory: descendantRetainedInInventory,
      rootClosed: fixture.parent.exitCode !== null || fixture.parent.signalCode !== null,
      descendantStillAlive,
      shutdownVerifiedWhileAlive,
      profileRetainedWhileAlive: dispositionWhileAlive === 'retained' && existsSync(profileDir),
      cleanupDiagnosticWritten: existsSync(join(tempRoot, 'ipc-smoke-cleanup-diagnostic.json')),
    }
    assert.deepEqual(observations, {
      initiallyCaptured: true,
      reparented: true,
      pidUnchanged: true,
      startTimeUnchanged: true,
      rootInFinalTree: true,
      absentFromFinalTree: true,
      retainedInMergedInventory: true,
      rootClosed: true,
      descendantStillAlive: true,
      shutdownVerifiedWhileAlive: false,
      profileRetainedWhileAlive: true,
      cleanupDiagnosticWritten: true,
    })

    if (fixture.parent.stdin && !fixture.parent.stdin.destroyed) fixture.parent.stdin.write('shutdown\n')
    let remainingAfterShutdown = await waitForTrackedProcessesToExit([fixture.descendant], 1000)
    if (remainingAfterShutdown.length > 0 && isSameLiveProcess(fixture.descendant)) {
      process.kill(fixture.descendant.pid, 'SIGTERM')
      remainingAfterShutdown = await waitForTrackedProcessesToExit([fixture.descendant], 1000)
    }
    assert.equal(remainingAfterShutdown.length, 0, 'Owned reparented descendant did not stop')
    const remainingAfterAllExit = await waitForTrackedProcessesToExit(trackedProcesses, 250)
    const shutdownVerifiedAfterExit = isTrackedProcessSetStopped(
      fixture.parentPid,
      trackedProcesses,
      remainingAfterAllExit,
    )
    assert.equal(shutdownVerifiedAfterExit, true, 'Cleanup did not verify all captured identities stopped')
    assert.equal(cleanupTemporaryProfile(tempRoot, shutdownVerifiedAfterExit, []), 'removed')
    assert.equal(existsSync(tempRoot), false, 'Profile remained after all observed identities stopped')
    t.diagnostic(
      'Reparenting regression passed: descendant PID ' + fixture.descendant.pid +
        ' remained in the merged inventory and blocked profile removal until shutdown.',
    )
  } finally {
    assert.equal(
      await stopParentDescendantFixture(
        fixture.parent,
        fixture.lines,
        fixture.inventory,
        tempRoot,
        initiallyObserved,
      ),
      true,
      'Test-owned parent/descendant fixture cleanup could not be confirmed',
    )
  }
})

test('Validation assertion failure preserves captured identities for cleanup', async (t) => {
  assert.equal(process.platform, 'linux', 'The validation inventory regression requires Linux /proc')
  const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-validation-inventory-regression-'))
  chmodSync(tempRoot, 0o700)
  mkdirSync(join(tempRoot, 'profile'), { mode: 0o700 })
  const fixture = await startParentDescendantFixture(tempRoot)
  const initiallyObserved = [...fixture.inventory.values()]
  const validationInventory: TrackedProcessInventory = new Map()

  try {
    let validationError: unknown
    try {
      const validationCapture = captureAndMergeTrackedProcessTree(validationInventory, fixture.parentPid)
      assert.ok(
        validationCapture.some((processSnapshot) => processIdentityKey(processSnapshot) === processIdentityKey(fixture.descendant)),
        'Validation capture omitted the live descendant',
      )
      throw new Error('controlled validation assertion failure')
    } catch (error) {
      validationError = error
    }
    assert.ok(validationError instanceof Error)
    assert.match(validationError.message, /controlled validation assertion failure/)
    assert.ok(
      validationInventory.has(processIdentityKey(fixture.descendant)),
      'Validation failure discarded an identity captured before the assertion',
    )

    const intermediateExit = waitForTrackedProcessesToExit([fixture.intermediate], 1500)
    assert.equal(isSameLiveProcess(fixture.intermediate), true, 'Fixture intermediate identity changed before signaling')
    assert.equal(process.kill(fixture.intermediate.pid, 'SIGUSR1'), true)
    assert.equal((await intermediateExit).length, 0)
    const finalCapture = captureAndMergeTrackedProcessTree(validationInventory, fixture.parentPid)
    assert.equal(finalCapture.some((processSnapshot) => processSnapshot.pid === fixture.descendant.pid), false)
    assert.ok(
      validationInventory.has(processIdentityKey(fixture.descendant)),
      'Cleanup capture replaced identities preserved across validation failure',
    )
    const remaining = await waitForTrackedProcessesToExit([...validationInventory.values()], 150)
    assert.equal(remaining.some((processSnapshot) => processIdentityKey(processSnapshot) === processIdentityKey(fixture.descendant)), true)
    const shutdownVerified = isTrackedProcessSetStopped(
      fixture.parentPid,
      [...validationInventory.values()],
      remaining,
    )
    assert.equal(shutdownVerified, false)
    assert.equal(cleanupTemporaryProfile(tempRoot, shutdownVerified, remaining), 'retained')
    assert.equal(existsSync(join(tempRoot, 'profile')), true)

    if (fixture.parent.stdin && !fixture.parent.stdin.destroyed) fixture.parent.stdin.write('shutdown\n')
    assert.equal((await waitForTrackedProcessesToExit([fixture.descendant], 1000)).length, 0)
    const rootExit = waitForChildExit(fixture.parent, 1500)
    assert.equal(fixture.parent.kill('SIGUSR1'), true)
    assert.equal(await rootExit, true)
    const remainingAfterExit = await waitForTrackedProcessesToExit([...validationInventory.values()], 250)
    const shutdownVerifiedAfterExit = isTrackedProcessSetStopped(
      fixture.parentPid,
      [...validationInventory.values()],
      remainingAfterExit,
    )
    assert.equal(shutdownVerifiedAfterExit, true)
    assert.equal(cleanupTemporaryProfile(tempRoot, shutdownVerifiedAfterExit, []), 'removed')
    t.diagnostic('Validation-failure inventory regression preserved descendant PID ' + fixture.descendant.pid + '.')
  } finally {
    assert.equal(
      await stopParentDescendantFixture(
        fixture.parent,
        fixture.lines,
        validationInventory,
        tempRoot,
        initiallyObserved,
      ),
      true,
      'Test-owned validation fixture cleanup could not be confirmed',
    )
  }
})

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
  const trackedProcessInventory: TrackedProcessInventory = new Map()

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
    const trackedProcesses = captureAndMergeTrackedProcessTree(trackedProcessInventory, runtimePid)
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
    let captureError: unknown
    if (!runtimePid || runtimePid <= 0) {
      captureError = new Error('Electron main process has no valid PID')
    } else {
      try {
        captureAndMergeTrackedProcessTree(trackedProcessInventory, runtimePid)
      } catch (error) {
        captureError = error
      }
    }
    const trackedProcesses = [...trackedProcessInventory.values()]

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
