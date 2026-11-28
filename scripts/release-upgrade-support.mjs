import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

export const WRITE_GRANT_EXPIRED_MESSAGE = 'Explicit native write consent is required or has expired'

export function createReleaseLaunchEnv(parentEnv) {
  const env = { ...parentEnv, GHOST_BOT_DEV_URL: '' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_DISABLE_SANDBOX
  delete env.NODE_OPTIONS
  return env
}

export function assertPackagedRendererIdentity({ packaged, mainFrameUrl, expectedRendererUrl }) {
  assert.equal(packaged, true, 'Release acceptance must run the packaged application')
  assert.equal(typeof mainFrameUrl, 'string')
  assert.equal(typeof expectedRendererUrl, 'string')
  const actual = new URL(mainFrameUrl)
  const expected = new URL(expectedRendererUrl)
  assert.equal(actual.protocol, 'file:', 'Packaged renderer must use a local file URL')
  assert.equal(expected.protocol, 'file:', 'Expected packaged renderer entry must use a local file URL')
  assert.equal(actual.href, expected.href, 'Renderer URL does not match the packaged dist/index.html entry')
}

export async function launchOwnedApplication({ launch, validate, owners, phase }) {
  const instance = await launch()
  const owner = { instance, processHandle: null, phase, daemonPid: null, cleanupResult: null }
  owners.push(owner)
  owner.processHandle = instance.process()
  return validate(owner)
}

export function recordValidationError(evidence, error) {
  if (evidence.error) return
  evidence.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error) }
}

export function recordCleanupResult(evidence, result) {
  evidence.checks ??= {}
  evidence.checks.processCleanup ??= []
  if (!evidence.checks.processCleanup.some((entry) => entry.phase === result.phase)) {
    evidence.checks.processCleanup.push(result)
  }
  if (result.errors.length > 0) {
    evidence.cleanupErrors ??= []
    evidence.cleanupErrors.push(...result.errors)
  }
}

function processStartTime(statText) {
  const commandEnd = statText.lastIndexOf(')')
  if (commandEnd < 0) throw new Error('Malformed proc stat record')
  const fields = statText.slice(commandEnd + 1).trim().split(/\s+/)
  if (!fields[19]) throw new Error('Missing process start-time identity')
  return fields[19]
}

export async function snapshotOwnedDescendants(rootPid, procRoot = '/proc') {
  if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error('Invalid owned Electron PID')
  const pending = [rootPid]
  const visited = new Set(pending)
  const descendants = []
  while (pending.length > 0) {
    const parentPid = pending.shift()
    let childrenText
    try {
      childrenText = await readFile(`${procRoot}/${parentPid}/task/${parentPid}/children`, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const rawPid of childrenText.trim().split(/\s+/).filter(Boolean)) {
      const pid = Number(rawPid)
      if (!Number.isInteger(pid) || pid <= 0 || visited.has(pid)) continue
      visited.add(pid)
      try {
        const statText = await readFile(`${procRoot}/${pid}/stat`, 'utf8')
        descendants.push({ pid, startTime: processStartTime(statText) })
        pending.push(pid)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  return descendants
}

async function processIdentityStillExists(identity, procRoot) {
  try {
    const statText = await readFile(`${procRoot}/${identity.pid}/stat`, 'utf8')
    return processStartTime(statText) === identity.startTime
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function waitFor(predicate, timeoutMs, intervalMs, sleep, now) {
  const deadline = now() + timeoutMs
  do {
    if (await predicate()) return true
    if (now() >= deadline) break
    await sleep(Math.min(intervalMs, Math.max(1, deadline - now())))
  } while (now() < deadline)
  return Boolean(await predicate())
}

function childHasExited(child) {
  return Boolean(child && (child.exitCode != null || child.signalCode != null))
}

export async function cleanupOwnedApplication(owner, options = {}) {
  if (owner.cleanupResult) return owner.cleanupResult
  const {
    procRoot = '/proc',
    snapshotDescendants = snapshotOwnedDescendants,
    signalProcess = (processId, signal) => process.kill(processId, signal),
    isPidAlive = (pid) => {
      try { process.kill(pid, 0); return true }
      catch (error) { if (error?.code === 'ESRCH') return false; return true }
    },
    timeoutMs = 5000,
    closeTimeoutMs = 5000,
    pollIntervalMs = 50,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = options
  const errors = []
  const child = owner.processHandle
  const pid = child?.pid
  let descendants = []
  let descendantsSnapshotSucceeded = false
  if (!Number.isInteger(pid) || pid <= 0) errors.push('Owned Electron process handle has no valid PID')
  else {
    try { descendants = await snapshotDescendants(pid, procRoot); descendantsSnapshotSucceeded = true }
    catch (error) { errors.push(`Could not snapshot owned child processes: ${error?.message ?? String(error)}`) }
  }

  let closeTimeout
  try {
    await Promise.race([
      Promise.resolve().then(() => owner.instance.close()),
      new Promise((_, reject) => { closeTimeout = setTimeout(() => reject(new Error(`Electron close timed out (${closeTimeoutMs}ms)`)), closeTimeoutMs) }),
    ])
  } catch (error) {
    errors.push(`Electron close: ${error?.message ?? String(error)}`)
  } finally {
    clearTimeout(closeTimeout)
  }

  const waitElectronExit = () => waitFor(() => childHasExited(child), timeoutMs, pollIntervalMs, sleep, now)
  let electronExited = await waitElectronExit()
  if (!electronExited && child && !childHasExited(child)) {
    try { child.kill('SIGTERM') } catch (error) { errors.push(`Electron SIGTERM: ${error?.message ?? String(error)}`) }
    electronExited = await waitElectronExit()
  }
  if (!electronExited && child && !childHasExited(child)) {
    try { child.kill('SIGKILL') } catch (error) { errors.push(`Electron SIGKILL: ${error?.message ?? String(error)}`) }
    electronExited = await waitElectronExit()
  }
  if (!electronExited) errors.push(`Owned Electron process ${pid ?? '(unknown)'} did not exit`)

  if (owner.daemonIdentity?.pid === owner.daemonPid &&
      !descendants.some(({ pid: childPid, startTime }) => childPid === owner.daemonIdentity.pid && startTime === owner.daemonIdentity.startTime)) {
    descendants.push(owner.daemonIdentity)
  }
  const ownedDescendantsExited = async () => {
    for (const identity of descendants) {
      if (await processIdentityStillExists(identity, procRoot)) return false
    }
    return true
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const identity of descendants) {
      try {
        if (await processIdentityStillExists(identity, procRoot)) signalProcess(identity.pid, signal)
      } catch (error) {
        errors.push(`Owned child ${identity.pid} ${signal}: ${error?.message ?? String(error)}`)
      }
    }
    try { if (await waitFor(ownedDescendantsExited, timeoutMs, pollIntervalMs, sleep, now)) break }
    catch (error) { errors.push(`Owned child process check: ${error?.message ?? String(error)}`) }
  }
  let descendantsExited = false
  try { descendantsExited = await ownedDescendantsExited() }
  catch (error) { errors.push(`Owned child process check: ${error?.message ?? String(error)}`) }
  if (!descendantsExited) errors.push('One or more owned Electron child processes remain alive')

  let daemonExited = owner.daemonPid == null
  if (Number.isInteger(owner.daemonPid) && owner.daemonPid > 0) {
    const daemonIdentity = descendants.find(({ pid: childPid }) => childPid === owner.daemonPid)
    try {
      daemonExited = daemonIdentity
        ? !(await processIdentityStillExists(daemonIdentity, procRoot))
        : await waitFor(async () => !(await isPidAlive(owner.daemonPid)), timeoutMs, pollIntervalMs, sleep, now)
    } catch (error) {
      errors.push(`Daemon process check: ${error?.message ?? String(error)}`)
    }
    if (!daemonExited) errors.push(`Owned daemon process ${owner.daemonPid} did not exit`)
  } else if (owner.daemonPid != null) {
    errors.push('Daemon health returned an invalid PID')
  }

  owner.cleanupResult = {
    phase: owner.phase,
    electronPid: pid ?? null,
    electronExited,
    daemonPid: owner.daemonPid ?? null,
    daemonExited,
    ownedChildPids: descendants.map(({ pid: childPid }) => childPid),
    ownedChildrenExited: descendantsExited,
    profileSafeToRemove: descendantsSnapshotSucceeded && electronExited && daemonExited && descendantsExited,
    errors,
  }
  return owner.cleanupResult
}

export function assertWriteGrantDenial({ error, targetExistedBefore, targetExistsAfter }) {
  assert.equal(targetExistedBefore, false, 'Write-denial target must be absent before the operation')
  assert(error instanceof Error, 'Workspace create must reject with an Error')
  assert.equal(error.message, WRITE_GRANT_EXPIRED_MESSAGE, 'Workspace create did not fail for the expired native write grant')
  assert.equal(targetExistsAfter, false, 'Denied workspace create left a target file behind')
}

export function assertInterruptedRunNotReplayed(execution, runId) {
  const run = execution.runs.find((entry) => entry.id === runId)
  assert(run, `Interrupted run ${runId} is missing`)
  assert.equal(run.status, 'interrupted', 'Interrupted execution was replayed or changed status')
}

export function assertExecutionRowsUnchanged(before, after, context) {
  for (const key of [
    'sessions', 'messages', 'runs', 'teamRuns', 'teamTasks', 'teamExecutionLinks',
    'teamMessages', 'approvals', 'usageRecords', 'runEvents',
  ]) {
    assert.deepEqual(after[key], before[key], `${context}: ${key} rows changed`)
  }
}

export function assertExecutionIdentitiesUnchanged(before, after, context) {
  const project = (snapshot) => ({
    sessions: snapshot.sessions.map(({ id, agent_id }) => ({ id, agent_id })),
    messages: snapshot.messages.map(({ id, session_id, run_id }) => ({ id, session_id, run_id })),
    runs: snapshot.runs.map(({ id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode }) => ({ id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode })),
    teamRuns: snapshot.teamRuns.map(({ id, team_id, owner_id, lead_bot_id, conversation_id, idempotency_key, root_task_id }) => ({ id, team_id, owner_id, lead_bot_id, conversation_id, idempotency_key, root_task_id })),
    teamTasks: snapshot.teamTasks.map(({ id, team_run_id, team_id, owner_id, root_task_id, assigned_bot_id, idempotency_key, attempt }) => ({ id, team_run_id, team_id, owner_id, root_task_id, assigned_bot_id, idempotency_key, attempt })),
    teamExecutionLinks: snapshot.teamExecutionLinks.map(({ id, team_run_id, team_task_id, agent_id, session_id, daemon_run_id, runtime_id, account_id, attempt, role }) => ({ id, team_run_id, team_task_id, agent_id, session_id, daemon_run_id, runtime_id, account_id, attempt, role })),
    teamMessages: snapshot.teamMessages.map(({ id, team_id, team_run_id, originating_task_id, seq }) => ({ id, team_id, team_run_id, originating_task_id, seq })),
    approvals: snapshot.approvals.map(({ id, run_id, session_id }) => ({ id, run_id, session_id })),
    usageRecords: snapshot.usageRecords.map(({ id, run_id }) => ({ id, run_id })),
  })
  assert.deepEqual(project(after), project(before), `${context}: durable execution identities/counts changed`)
}

export function assertCandidateStartupExecutionStable(before, after, interruptedRunId) {
  assertExecutionIdentitiesUnchanged(before, after, 'candidate startup')
  const beforeRuns = new Map(before.runs.map((run) => [run.id, run]))
  for (const run of after.runs) {
    const prior = beforeRuns.get(run.id)
    assert(prior, `Candidate startup added run ${run.id}`)
    if (run.id === interruptedRunId) {
      assert.equal(run.status, 'interrupted', 'Interrupted run was replayed during candidate startup')
      assert(['interrupted', 'running', 'starting', 'awaiting_approval', 'cancelling'].includes(prior.status), 'Fixture run was not live before restart')
    } else {
      assert.equal(run.status, prior.status, `Candidate startup changed unrelated run ${run.id}`)
    }
  }
  assert.deepEqual(after.teamRuns, before.teamRuns, 'Candidate startup changed team run rows')
  assert.deepEqual(after.teamTasks, before.teamTasks, 'Candidate startup changed team task rows')
  for (const key of ['sessions', 'messages', 'teamExecutionLinks', 'teamMessages', 'approvals', 'usageRecords']) {
    assert.deepEqual(after[key], before[key], `Candidate startup changed ${key} rows`)
  }
  const beforeEvents = new Set(before.runEvents.map((event) => `${event.run_id}\0${event.event_key}`))
  const afterEvents = new Set(after.runEvents.map((event) => `${event.run_id}\0${event.event_key}`))
  for (const key of beforeEvents) assert(afterEvents.has(key), `Candidate startup removed run event ${key}`)
  assert.deepEqual(
    after.runEvents.filter((event) => beforeEvents.has(`${event.run_id}\0${event.event_key}`)),
    before.runEvents,
    'Candidate startup changed an existing run event',
  )
  const added = after.runEvents.filter((event) => !beforeEvents.has(`${event.run_id}\0${event.event_key}`))
  assert(added.length <= 1, 'Candidate startup added unexpected run events')
  if (added.length === 1) {
    assert.equal(added[0].run_id, interruptedRunId)
    assert.equal(added[0].event_key, `run.interrupted:startup:${interruptedRunId}`)
    assert.equal(added[0].type, 'run.interrupted')
  }
}

export function profileMayBeRemoved(cleanupResults) {
  return cleanupResults.every((result) => result.profileSafeToRemove)
}
