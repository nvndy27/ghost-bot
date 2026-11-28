import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

const clone = (value) => JSON.parse(JSON.stringify(value))
import {
  assertExecutionIdentitiesUnchanged,
  assertExecutionRowsUnchanged,
  assertCandidateStartupExecutionStable,
  assertInterruptedRunNotReplayed,
  assertPackagedRendererIdentity,
  assertWriteGrantDenial,
  cleanupOwnedApplication,
  createReleaseLaunchEnv,
  launchOwnedApplication,
  profileMayBeRemoved,
  recordCleanupResult,
  recordValidationError,
  WRITE_GRANT_EXPIRED_MESSAGE,
} from '../scripts/release-upgrade-support.mjs'

test('release runner strips inherited development renderer and bypass overrides', () => {
  const env = createReleaseLaunchEnv({
    GHOST_BOT_DEV_URL: 'http://127.0.0.1:4173',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_DISABLE_SANDBOX: '1',
    NODE_OPTIONS: '--require /tmp/inject.cjs',
    PATH: '/usr/bin',
  })
  assert.equal(env.GHOST_BOT_DEV_URL, '')
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.ELECTRON_DISABLE_SANDBOX, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.PATH, '/usr/bin')
})

test('packaged renderer identity accepts only the expected file entry', () => {
  const expectedRendererUrl = 'file:///opt/ghost-bot/resources/app.asar/dist/index.html'
  assert.doesNotThrow(() => assertPackagedRendererIdentity({
    packaged: true,
    mainFrameUrl: expectedRendererUrl,
    expectedRendererUrl,
  }))
  for (const mainFrameUrl of ['http://127.0.0.1:4173/', 'file:///tmp/other/dist/index.html']) {
    assert.throws(() => assertPackagedRendererIdentity({ packaged: true, mainFrameUrl, expectedRendererUrl }))
  }
  assert.throws(() => assertPackagedRendererIdentity({ packaged: false, mainFrameUrl: expectedRendererUrl, expectedRendererUrl }))
})

test('post-launch validation failure leaves an owned instance available for cleanup', async () => {
  const owners = []
  const instance = { process: () => ({ pid: 404, exitCode: null, signalCode: null }) }
  const failure = new Error('synthetic renderer validation failure')
  await assert.rejects(launchOwnedApplication({
    launch: async () => instance,
    owners,
    phase: 'candidate',
    validate: async () => { throw failure },
  }), failure)
  assert.equal(owners.length, 1)
  assert.equal(owners[0].instance, instance)
  const evidence = {}
  recordValidationError(evidence, failure)
  recordValidationError(evidence, new Error('cleanup failure must not replace validation failure'))
  assert.deepEqual(evidence.error, { name: 'Error', message: 'synthetic renderer validation failure' })
  recordCleanupResult(evidence, {
    phase: 'candidate', profileSafeToRemove: false,
    errors: ['owned daemon remained alive'],
  })
  assert.deepEqual(evidence.error, { name: 'Error', message: 'synthetic renderer validation failure' })
  assert.deepEqual(evidence.cleanupErrors, ['owned daemon remained alive'])
})

test('owned application cleanup verifies Electron, daemon and child exit before profile removal', async () => {
  const procRoot = await mkdtemp(join(tmpdir(), 'release-runner-proc-'))
  const putStat = async (pid, start) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = '1'
    fields[19] = String(start)
    await writeFile(join(procRoot, String(pid), 'stat'), `${pid} (fixture) ${fields.join(' ')}\n`)
  }
  try {
    await mkdir(join(procRoot, '500', 'task', '500'), { recursive: true })
    await mkdir(join(procRoot, '501', 'task', '501'), { recursive: true })
    await writeFile(join(procRoot, '500', 'task', '500', 'children'), '501')
    await writeFile(join(procRoot, '501', 'task', '501', 'children'), '')
    await putStat(501, 9)
    const signals = []
    const child = { pid: 500, exitCode: null, signalCode: null, kill() { this.exitCode = 0; return true } }
    const owner = {
      phase: 'previous',
      daemonPid: 501,
      daemonIdentity: { pid: 501, startTime: '9' },
      processHandle: child,
      instance: { close: async () => { child.exitCode = 0 } },
    }
    const result = await cleanupOwnedApplication(owner, {
      procRoot,
      timeoutMs: 0,
      closeTimeoutMs: 100,
      snapshotDescendants: async () => [],
      signalProcess: (pid, signal) => {
        signals.push([pid, signal])
        rmSync(join(procRoot, String(pid)), { recursive: true, force: true })
      },
      isPidAlive: () => false,
      sleep: async () => {},
    })
    assert.equal(result.electronExited, true)
    assert.equal(result.daemonExited, true)
    assert.equal(result.ownedChildrenExited, true)
    assert.equal(result.profileSafeToRemove, true)
    assert.equal(profileMayBeRemoved([result]), true)
    assert.deepEqual(signals, [[501, 'SIGTERM']])
  } finally {
    await rm(procRoot, { recursive: true, force: true })
  }
})

test('cleanup failures are reported, retain the profile, and never signal the daemon PID', async () => {
  const procRoot = await mkdtemp(join(tmpdir(), 'release-runner-proc-'))
  try {
    await mkdir(join(procRoot, '600', 'task', '600'), { recursive: true })
    const electronSignals = []
    const daemonSignals = []
    const child = { pid: 600, exitCode: null, signalCode: null, kill(signal) { electronSignals.push(signal); return true } }
    const owner = {
      phase: 'candidate', daemonPid: 601, processHandle: child,
      instance: { close: async () => { throw new Error('injected close failure') } },
    }
    const result = await cleanupOwnedApplication(owner, {
      procRoot,
      timeoutMs: 0,
      closeTimeoutMs: 100,
      snapshotDescendants: async () => [],
      signalProcess: (pid, signal) => daemonSignals.push([pid, signal]),
      isPidAlive: () => true,
      sleep: async () => {},
    })
    assert.deepEqual(electronSignals, ['SIGTERM', 'SIGKILL'])
    assert.deepEqual(daemonSignals, [])
    assert.equal(result.electronExited, false)
    assert.equal(result.daemonExited, false)
    assert.equal(result.ownedChildrenExited, true)
    assert.equal(result.profileSafeToRemove, false)
    assert.equal(profileMayBeRemoved([result]), false)
    assert.match(result.errors.join('\n'), /injected close failure/)
    assert.match(result.errors.join('\n'), /daemon process 601 did not exit/)
  } finally {
    await rm(procRoot, { recursive: true, force: true })
  }
})

test('write-grant expiry accepts only the specific expired-grant denial with no file side effect', () => {
  assert.doesNotThrow(() => assertWriteGrantDenial({
    error: new Error(WRITE_GRANT_EXPIRED_MESSAGE),
    targetExistedBefore: false,
    targetExistsAfter: false,
  }))
  for (const input of [
    { error: new Error('validation failed'), targetExistedBefore: false, targetExistsAfter: false },
    { error: new Error('Daemon request timed out'), targetExistedBefore: false, targetExistsAfter: false },
    { error: new Error('EACCES: permission denied'), targetExistedBefore: false, targetExistsAfter: false },
    { error: new Error(WRITE_GRANT_EXPIRED_MESSAGE), targetExistedBefore: true, targetExistsAfter: false },
    { error: new Error(WRITE_GRANT_EXPIRED_MESSAGE), targetExistedBefore: false, targetExistsAfter: true },
  ]) assert.throws(() => assertWriteGrantDenial(input))
})

test('execution snapshots reject duplicate runs/tasks, replay and extra event rows', () => {
  const base = {
    sessions: [{ id: 'session-1', agent_id: 'bot-1', title: 'fixture' }],
    messages: [{ id: 'message-1', session_id: 'session-1', run_id: 'run-1' }],
    runs: [{ id: 'run-1', session_id: 'session-1', idempotency_key: 'fixture:run', status: 'interrupted' }],
    teamRuns: [{ id: 'team-run-1', team_id: 'team-1', idempotency_key: 'fixture:task', root_task_id: 'task-1', status: 'completed', tasks_created: 1 }],
    teamTasks: [{ id: 'task-1', team_run_id: 'team-run-1', idempotency_key: 'fixture:task', attempt: 1, status: 'completed' }],
    teamExecutionLinks: [{ id: 'link-1', team_run_id: 'team-run-1', team_task_id: 'task-1', session_id: 'task-session-1', daemon_run_id: 'task-run-1', attempt: 1, role: 'worker' }],
    teamMessages: [{ id: 'team-message-1', team_id: 'team-1', team_run_id: 'team-run-1', originating_task_id: 'task-1', seq: 1 }],
    approvals: [],
    usageRecords: [{ id: 'usage-1', run_id: 'run-1' }],
    runEvents: [{ run_id: 'run-1', seq: 1, event_key: 'run.interrupted:shutdown', type: 'run.interrupted' }],
  }
  assert.doesNotThrow(() => assertInterruptedRunNotReplayed(base, 'run-1'))
  assert.doesNotThrow(() => assertExecutionRowsUnchanged(base, clone(base), 'repeat request'))
  assert.doesNotThrow(() => assertExecutionIdentitiesUnchanged(base, clone(base), 'candidate startup'))
  assert.doesNotThrow(() => assertCandidateStartupExecutionStable(base, clone(base), 'run-1'))

  const recovered = clone(base)
  recovered.runEvents.push({ run_id: 'run-1', seq: 2, event_key: 'run.interrupted:startup:run-1', type: 'run.interrupted' })
  assert.doesNotThrow(() => assertCandidateStartupExecutionStable(base, recovered, 'run-1'))

  const duplicate = clone(base)
  duplicate.runs.push({ id: 'run-2', session_id: 'session-1', idempotency_key: 'fixture:run:duplicate', status: 'completed' })
  assert.throws(() => assertExecutionIdentitiesUnchanged(base, duplicate, 'injected duplicate run'))
  const duplicateTask = clone(base)
  duplicateTask.teamTasks.push({ id: 'task-2', team_run_id: 'team-run-1', idempotency_key: 'fixture:task:duplicate', attempt: 1, status: 'completed' })
  assert.throws(() => assertExecutionIdentitiesUnchanged(base, duplicateTask, 'injected duplicate task'))
  const duplicateDispatch = clone(base)
  duplicateDispatch.teamExecutionLinks.push({ id: 'link-2', team_run_id: 'team-run-1', team_task_id: 'task-1', session_id: 'task-session-1', daemon_run_id: 'task-run-2', attempt: 2, role: 'worker' })
  assert.throws(() => assertExecutionIdentitiesUnchanged(base, duplicateDispatch, 'injected duplicate dispatch'))
  const replay = clone(base)
  replay.runs[0].status = 'completed'
  assert.throws(() => assertInterruptedRunNotReplayed(replay, 'run-1'))
  const extraSideEffect = clone(base)
  extraSideEffect.runEvents.push({ run_id: 'run-1', seq: 2, event_key: 'unexpected', type: 'run.started' })
  assert.throws(() => assertExecutionRowsUnchanged(base, extraSideEffect, 'injected replay event'))
  assert.throws(() => assertCandidateStartupExecutionStable(base, extraSideEffect, 'run-1'))
  const extraTaskSideEffect = clone(base)
  extraTaskSideEffect.teamMessages.push({ id: 'team-message-2', team_id: 'team-1', team_run_id: 'team-run-1', originating_task_id: 'task-1', seq: 2 })
  assert.throws(() => assertExecutionRowsUnchanged(base, extraTaskSideEffect, 'injected duplicate task side effect'))
  const extraStartupRun = clone(base)
  extraStartupRun.runs.push({ id: 'run-2', session_id: 'session-1', idempotency_key: 'fixture:replay', status: 'running' })
  assert.throws(() => assertCandidateStartupExecutionStable(base, extraStartupRun, 'run-1'))
})
