#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function usage() {
  console.error('Usage: node scripts/verify-release-upgrade.mjs --previous <executable> --candidate <executable> --source-sha <40-char-sha> --evidence <directory> [--interactive-write-grant]')
  console.error('Use executable AppImages or packaged Electron executables. RPM packages must be installed/extracted by the release operator first.')
}

const values = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const key = argv[i]
  if (key === '--interactive-write-grant' && !values[key]) { values[key] = true; continue }
  if (!['--previous', '--candidate', '--source-sha', '--evidence'].includes(key) || values[key]) { usage(); process.exit(2) }
  values[key] = argv[++i]
  if (!values[key] || values[key].startsWith('--')) { usage(); process.exit(2) }
}
const interactiveGrant = values['--interactive-write-grant'] === true
delete values['--interactive-write-grant']
if (Object.keys(values).length !== 4 || process.platform !== 'linux' || process.getuid?.() === 0) { usage(); process.exit(2) }

const previous = resolve(values['--previous'])
const candidate = resolve(values['--candidate'])
const evidenceDir = resolve(values['--evidence'])
const sourceSha = values['--source-sha']
assert.match(sourceSha, /^[0-9a-f]{40}$/i)
for (const path of [previous, candidate]) {
  await access(path, constants.X_OK)
  assert((await stat(path)).isFile(), `Artifact is not a regular executable file: ${path}`)
}
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const previousSha = await sha256(previous)
const candidateSha = await sha256(candidate)
if (previousSha === candidateSha) {
  console.error('Previous and candidate artifacts have identical SHA-256 values; refusing to label this an upgrade.')
  process.exit(2)
}
const { _electron: electron } = await import('playwright-core')

const root = await mkdtemp(join(tmpdir(), 'ghost-release-upgrade-'))
await chmod(root, 0o700)
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const dataDir = join(root, 'profile', 'data')
await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(workspace, { recursive: true, mode: 0o700 }), mkdir(dataDir, { recursive: true, mode: 0o700 })])
const sentinelPath = join(workspace, 'unrelated-release-canary.txt')
await writeFile(sentinelPath, 'release acceptance canary\n', { mode: 0o600 })
const sentinelHash = await sha256(sentinelPath)
const marker = `release-${randomUUID()}`
const operationId = randomUUID()

const evidence = {
  kind: 'artifact-upgrade-restart', sourceSha,
  sourceShaProvenance: 'Operator-supplied candidate source SHA; binary provenance is not inferred by this runner.',
  platform: process.platform, architecture: process.arch,
  node: process.version, runtimeMode: 'mock', liveInference: false,
  artifacts: { previous: { path: previous, sha256: previousSha }, candidate: { path: candidate, sha256: candidateSha } },
  isolatedProfile: true, checks: {},
  unsupportedOrUnverified: [
    'RPM installation and AppImage native FUSE require separate host acceptance.',
    'Results apply only to the recorded artifact pair and Linux environment.',
  ],
  startedAt: new Date().toISOString(), status: 'failed',
}

let app
let seed
async function launch(executable) {
  const launchEnv = { ...process.env }
  delete launchEnv.ELECTRON_RUN_AS_NODE
  delete launchEnv.ELECTRON_DISABLE_SANDBOX
  delete launchEnv.NODE_OPTIONS
  const instance = await electron.launch({
    executablePath: executable, args: [], cwd: dirname(executable), timeout: 60_000,
    chromiumSandbox: true,
    env: {
      ...launchEnv, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
      GHOST_BOT_DATA_DIR: dataDir, GHOST_BOT_RUNTIME_MODE: 'mock', GHOST_BOT_SMOKE_EXIT: '0',
    },
  })
  const page = await instance.firstWindow()
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
  await page.getByText('Chief of Staff', { exact: true }).first().waitFor({ timeout: 30_000 })
  const security = await instance.evaluate(({ app, BrowserWindow }) => {
    const web = BrowserWindow.getAllWindows()[0]?.webContents
    const preferences = web?.getLastWebPreferences()
    return {
      packaged: app.isPackaged,
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
      sandbox: preferences?.sandbox,
      contextIsolation: preferences?.contextIsolation,
      nodeIntegration: preferences?.nodeIntegration,
    }
  })
  assert.deepEqual(security, { packaged: true, noSandbox: false, sandbox: true, contextIsolation: true, nodeIntegration: false })
  const health = await page.evaluate(() => window.ghostBot.getDaemonHealth())
  assert.equal(health.ok, true)
  assert.equal(health.runtimeMode, 'mock')
  return { instance, page, daemonPid: health.pid }
}
async function awaitRun(page, runId, expected) {
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    const run = await page.evaluate((id) => window.ghostBot.getRun(id), runId)
    if (expected.includes(run.status)) return run
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Run ${runId} did not reach ${expected.join('/')} in time`)
}
async function profileSnapshot() {
  const db = new DatabaseSync(join(dataDir, 'ghost-bot.sqlite'), { readOnly: true })
  try {
    return {
      migrations: db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all(),
      bots: db.prepare('SELECT id, name, avatar_json FROM agents WHERE archived_at IS NULL ORDER BY id').all(),
      sessions: db.prepare('SELECT id, agent_id, title FROM sessions ORDER BY id').all(),
      messages: db.prepare('SELECT id, session_id, content_json FROM messages ORDER BY id').all(),
      teams: db.prepare('SELECT id, name FROM teams ORDER BY id').all(),
      runCount: Number(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n),
    }
  } finally { db.close() }
}
async function assertDaemonExited(pid, phase) {
  const until = Date.now() + 8_000
  while (Date.now() < until) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`${phase} daemon process ${pid} remained after application close`)
}

try {
  // Seed durable state exclusively through the previous packaged application's real Electron bridge.
  const old = await launch(previous)
  app = old.instance
  seed = await old.page.evaluate(async ({ markerValue, workspacePath, taskOperationId }) => {
    const api = window.ghostBot
    const bots = (await api.listBots()).bots
    const chiefId = bots.find((bot) => bot.name === 'Chief of Staff')?.id
    const workerId = bots.find((bot) => bot.id !== chiefId)?.id
    if (!chiefId || !workerId) throw new Error('Default offline bots are unavailable')
    const bot = await api.createBot({
      name: 'Release Upgrade Fixture', description: 'Synthetic acceptance only',
      instructions: 'Offline fixture. No provider execution.',
      avatar: { kind: 'preset', shape: 'analyst', color: '#64748b', eyes: 'classic', rotation: 0, animation: false },
      runtimeId: 'mock-offline', modelId: 'gpt-6.2-mock', effort: 'medium', workspacePath, permission: 'read-only',
    })
    const session = await api.createSession({ agentId: bot.id, title: markerValue })
    const text = `${markerValue} preserved conversation`
    const first = await api.startRun({ sessionId: session.id, idempotencyKey: `${markerValue}:conversation`, text })
    const completed = await (async () => {
      const end = Date.now() + 20_000
      while (Date.now() < end) {
        const run = await api.getRun(first.run.id)
        if (run.status === 'completed') return run
        if (['failed', 'cancelled', 'interrupted'].includes(run.status)) throw new Error(`Fixture conversation ${run.status}`)
        await new Promise((done) => setTimeout(done, 100))
      }
      throw new Error('Mock conversation timed out')
    })()
    const repeated = await api.startRun({ sessionId: session.id, idempotencyKey: `${markerValue}:conversation`, text })
    const team = await api.createTeam({ name: `${markerValue} team`, description: 'Private-task fixture', leadBotId: chiefId, memberBotIds: [chiefId, workerId] })
    const taskInput = { teamId: team.id, assignedBotId: workerId, objective: `${markerValue} private objective`, operationId: taskOperationId }
    const task = await api.delegateTeamTask(taskInput)
    const repeatedTask = await api.delegateTeamTask(taskInput)
    let taskStatus = task.status
    const taskDeadline = Date.now() + 20_000
    while (!['completed', 'failed', 'cancelled', 'blocked', 'denied', 'uncertain', 'budget_exhausted', 'stopped_by_parent'].includes(taskStatus) && Date.now() < taskDeadline) {
      const current = await api.listPrivateTaskChats({ teamId: team.id })
      taskStatus = current.tasks.find((entry) => entry.taskId === task.taskId)?.status ?? taskStatus
      await new Promise((done) => setTimeout(done, 100))
    }
    if (!['completed', 'failed', 'cancelled', 'blocked', 'denied', 'uncertain', 'budget_exhausted', 'stopped_by_parent'].includes(taskStatus)) throw new Error('Private task did not settle before the upgrade fixture')
    const settings = await api.updateSettings({ appearance: { theme: 'dark', rightWidth: 360, workspaceTab: 'files' } })
    const interruptedSession = await api.createSession({ agentId: bot.id, title: `${markerValue} interrupted fixture` })
    const interrupted = await api.startRun({ sessionId: interruptedSession.id, idempotencyKey: `${markerValue}:interrupted`, text: 'Simulate disconnect mid-run' })
    return {
      marker: markerValue, botId: bot.id, botName: bot.name, avatar: bot.avatar, workerId,
      sessionId: session.id, runId: completed.id, duplicateRunId: repeated.run.id,
      duplicateReported: repeated.deduplicated, teamId: team.id, taskId: task.taskId,
      taskRunId: task.teamRunId, privateSessionId: task.sessionId, repeatedTaskId: repeatedTask.taskId,
      privateTaskStatus: taskStatus, operationId: taskOperationId, interruptedRunId: interrupted.run.id,
      settings: settings.appearance,
    }
  }, { markerValue: marker, workspacePath: workspace, taskOperationId: operationId })
  assert.equal(seed.duplicateReported, true)
  assert.equal(seed.duplicateRunId, seed.runId)
  assert.equal(seed.repeatedTaskId, seed.taskId)
  await awaitRun(old.page, seed.interruptedRunId, ['running', 'awaiting_approval', 'cancelling'])

  let grantBot = null
  if (interactiveGrant) {
    grantBot = await old.page.evaluate(async (path) => window.ghostBot.createBot({
      name: 'Release Grant Expiry Fixture', description: 'Temporary native-grant test',
      instructions: 'No execution. Temporary local file authorization only.',
      avatar: { kind: 'preset', shape: 'security', color: '#64748b', eyes: 'classic', rotation: 0, animation: false },
      runtimeId: 'mock-offline', modelId: 'gpt-6.2-mock', effort: 'medium', workspacePath: path, permission: 'workspace',
    }), workspace)
    console.log(`Select this temporary test folder in the native read-consent chooser: ${workspace}`)
    const readAllowed = await Promise.race([
      old.page.evaluate((id) => window.ghostBot.authorizeWorkspaceRead(id), grantBot.id),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Native read-grant decision timed out')), 120_000)),
    ])
    assert.equal(readAllowed, true, 'Native workspace read consent was not granted')
    console.log(`Approve the native write grant for this temporary test folder only: ${workspace}`)
    const granted = await Promise.race([
      old.page.evaluate((id) => window.ghostBot.authorizeWorkspaceWrite(id), grantBot.id),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Native grant decision timed out')), 120_000)),
    ])
    assert.equal(granted, true, 'Native workspace write consent was not granted')
    const context = await old.page.evaluate((id) => window.ghostBot.resolveWorkspaceContext({ botId: id }), grantBot.id)
    assert.equal(context.writeAuthorized, true)
    seed.grant = { botId: grantBot.id, workspaceId: context.workspaceId, authGeneration: context.authGeneration }
    await old.page.evaluate((grant) => window.ghostBot.createWorkspaceEntry({
      botId: grant.botId, workspaceId: grant.workspaceId, authGeneration: grant.authGeneration,
      relativePath: 'grant-before-restart.txt', kind: 'file', content: 'authorized temporary fixture\n',
    }), seed.grant)
  }

  const oldInfo = await old.page.evaluate(() => window.ghostBot.getAppInfo())
  evidence.checks.previousArtifact = { status: 'passed', appInfo: oldInfo, idempotency: 'verified duplicate run and private task deduplicated' }
  await old.instance.close()
  app = null
  await assertDaemonExited(old.daemonPid, 'previous')
  const before = await profileSnapshot()
  evidence.checks.preUpgradeProfile = {
    status: 'passed', latestMigration: before.migrations.at(-1)?.version,
    migrationCount: before.migrations.length, botCount: before.bots.length,
    sessionCount: before.sessions.length, messageCount: before.messages.length, runCount: before.runCount,
  }

  // Candidate starts from the same isolated HOME and SQLite profile.
  const next = await launch(candidate)
  app = next.instance
  if (interactiveGrant && seed.grant) {
    console.log(`Select this same temporary folder in the candidate native read-consent chooser: ${workspace}`)
    const readAllowed = await Promise.race([
      next.page.evaluate((id) => window.ghostBot.authorizeWorkspaceRead(id), seed.grant.botId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Candidate native read-grant decision timed out')), 120_000)),
    ])
    assert.equal(readAllowed, true, 'Candidate native workspace read consent was not granted')
  }
  const verified = await next.page.evaluate(async ({ fixture, grant }) => {
    const api = window.ghostBot
    const bot = (await api.listBots()).bots.find((value) => value.id === fixture.botId)
    const sessions = await api.listSessions({ agentId: fixture.botId })
    const messages = await api.listMessages({ sessionId: fixture.sessionId })
    const originalRun = await api.getRun(fixture.runId)
    const duplicate = await api.startRun({ sessionId: fixture.sessionId, idempotencyKey: `${fixture.marker}:conversation`, text: `${fixture.marker} preserved conversation` })
    const tasks = await api.listPrivateTaskChats({ teamId: fixture.teamId })
    const privateTask = tasks.tasks.find((value) => value.taskId === fixture.taskId && value.teamRunId === fixture.taskRunId)
    const privateMessages = privateTask?.sessionId ? await api.listMessages({ sessionId: privateTask.sessionId }) : { messages: [] }
    const personalMessages = await api.listMessages({ sessionId: fixture.sessionId })
    const repeatedTask = await api.delegateTeamTask({ teamId: fixture.teamId, assignedBotId: fixture.workerId, objective: `${fixture.marker} private objective`, operationId: fixture.operationId })
    const settings = await api.getSettings()
    const interrupted = await api.getRun(fixture.interruptedRunId)
    const health = await api.getDaemonHealth()
    let grantCheck = null
    if (grant) {
      const freshContext = await api.resolveWorkspaceContext({ botId: grant.botId })
      let denied = false
      try {
        await api.createWorkspaceEntry({ botId: grant.botId, workspaceId: freshContext.workspaceId, authGeneration: freshContext.authGeneration, relativePath: 'grant-after-restart.txt', kind: 'file', content: 'must be denied\n' })
      } catch { denied = true }
      grantCheck = { readAuthorized: freshContext.authorized, writeAuthorized: freshContext.writeAuthorized, denied }
    }
    return {
      bot, sessionFound: sessions.sessions.some((value) => value.id === fixture.sessionId),
      messageFound: messages.messages.some((value) => JSON.stringify(value).includes('preserved conversation')),
      personalMessagesContainPrivateObjective: personalMessages.messages.some((value) => JSON.stringify(value).includes('private objective')),
      runStatus: originalRun.status, duplicateRunId: duplicate.run.id, duplicateReported: duplicate.deduplicated,
      privateTask, repeatedTaskId: repeatedTask.taskId, workspaceSettings: settings.appearance,
      privateMessages: privateMessages.messages,
      interruptedStatus: interrupted.status, health, grantCheck,
    }
  }, { fixture: seed, grant: seed.grant ?? null })
  void grantBot
  assert(verified.bot, 'Bot identity was lost')
  assert.equal(verified.bot.name, seed.botName)
  assert.deepEqual(verified.bot.avatar, seed.avatar)
  assert.equal(verified.sessionFound, true)
  assert.equal(verified.messageFound, true)
  assert.equal(verified.runStatus, 'completed')
  assert.equal(verified.duplicateRunId, seed.runId)
  assert.equal(verified.duplicateReported, true)
  assert(verified.privateTask, 'Private task identity was lost')
  assert.equal(verified.privateTask.sessionId, seed.privateSessionId)
  assert.notEqual(verified.privateTask.sessionId, seed.sessionId, 'Private task must retain a distinct session')
  assert(verified.privateMessages.length > 0, 'Private task conversation history was not preserved')
  assert.equal(verified.repeatedTaskId, seed.taskId)
  assert.equal(verified.personalMessagesContainPrivateObjective, false)
  assert.equal(verified.workspaceSettings.theme, 'dark')
  assert.equal(verified.workspaceSettings.rightWidth, 360)
  assert.equal(verified.workspaceSettings.workspaceTab, 'files')
  assert.equal(verified.interruptedStatus, 'interrupted', 'Interrupted execution must recover without automatic replay')
  assert.equal(verified.health.ok, true)
  if (seed.grant) {
    assert.equal(verified.grantCheck.readAuthorized, true, 'Read consent was not reissued for the candidate')
    assert.equal(verified.grantCheck.writeAuthorized, false)
    assert.equal(verified.grantCheck.denied, true)
    evidence.checks.writeGrantExpiration = { status: 'passed', writeAuthorizedAfterRestart: false, unapprovedCreateDenied: true }
  } else {
    evidence.checks.writeGrantExpiration = { status: 'not-run', reason: 'Use --interactive-write-grant and approve the temporary-folder native prompt to include this check.' }
  }
  evidence.checks.candidateRestart = {
    status: 'passed', appInfo: await next.page.evaluate(() => window.ghostBot.getAppInfo()),
    bot: { id: verified.bot.id, name: verified.bot.name, avatar: verified.bot.avatar },
    session: seed.sessionId, conversationPersisted: verified.messageFound,
    originalRunStatus: verified.runStatus, duplicateExecutionPrevented: verified.duplicateReported,
    privateTaskId: verified.privateTask.taskId, privateTaskIdentityRecovered: true,
    privateTaskOutputAbsentFromPersonalChat: !verified.personalMessagesContainPrivateObjective,
    settings: verified.workspaceSettings,
    interruptedRunStatus: verified.interruptedStatus, daemonHealthy: verified.health.ok,
  }
  await next.instance.close()
  app = null
  await assertDaemonExited(next.daemonPid, 'candidate')

  const after = await profileSnapshot()
  for (const bot of before.bots) assert(after.bots.some((value) => value.id === bot.id), `Migration lost bot ${bot.id}`)
  for (const session of before.sessions) assert(after.sessions.some((value) => value.id === session.id), `Migration lost session ${session.id}`)
  for (const message of before.messages) assert(after.messages.some((value) => value.id === message.id && value.content_json === message.content_json), `Migration lost or changed message ${message.id}`)
  for (const team of before.teams) assert(after.teams.some((value) => value.id === team.id && value.name === team.name), `Migration lost team ${team.id}`)
  assert(after.migrations.length >= before.migrations.length, 'Migration history regressed')
  assert.deepEqual(
    after.migrations.slice(0, before.migrations.length),
    before.migrations,
    'Existing migration versions and names must remain unchanged and ordered',
  )
  evidence.checks.migrationAndDataPreservation = {
    status: 'passed', previousLatest: before.migrations.at(-1)?.version,
    candidateLatest: after.migrations.at(-1)?.version, previousMigrationCount: before.migrations.length,
    candidateMigrationCount: after.migrations.length, previousBotCount: before.bots.length,
    candidateBotCount: after.bots.length, previousSessionCount: before.sessions.length,
    candidateSessionCount: after.sessions.length, previousMessageCount: before.messages.length,
    candidateMessageCount: after.messages.length, previousTeamCount: before.teams.length,
    candidateTeamCount: after.teams.length, preservedMessageIdsAndContent: true,
  }
  assert.equal(await sha256(sentinelPath), sentinelHash, 'Unrelated synthetic workspace data changed')
  evidence.checks.unchangedWorkspaceCanary = { status: 'passed', sha256: sentinelHash }
  evidence.checks.daemonCleanup = { status: 'passed', previousDaemonExited: true, candidateDaemonExited: true }
  if (evidence.checks.writeGrantExpiration?.status !== 'passed') {
    evidence.status = 'passed-with-check-not-run'
  } else {
    evidence.status = 'passed'
  }
} catch (error) {
  evidence.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error) }
  if (app) {
    try { await app.close() } catch (closeError) { evidence.checks.daemonCleanup = { status: 'failed', error: String(closeError) } }
  }
} finally {
  evidence.finishedAt = new Date().toISOString()
  try { await rm(root, { recursive: true, force: true }) }
  catch (error) { evidence.status = 'failed'; evidence.profileCleanup = String(error) }
  await mkdir(evidenceDir, { recursive: true })
  const evidencePath = join(evidenceDir, `upgrade-${new Date().toISOString().replaceAll(':', '-')}.json`)
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ status: evidence.status, evidence: evidencePath, sourceSha, previousSha, candidateSha }, null, 2))
}
if (!evidence.status.startsWith('passed')) process.exitCode = 1
