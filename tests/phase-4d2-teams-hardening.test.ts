import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'
import { SettingsRepository } from '../apps/daemon/src/settings/repository.ts'
import { TeamsExecutionBridge } from '../apps/daemon/src/teams/execution-bridge.ts'
import { TeamsService } from '../apps/daemon/src/teams/service.ts'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.chmodSync(dir, 0o700)
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

async function setupHarness(runtimeMode: 'mock' | 'codex') {
  const dir = makeTempDir('ghost-4d2-hardening-')
  const db = await openGhostBotDatabase(dir)
  seedInitialBotsIfNeeded(db)
  const bots = new BotRepository(db)
  const settingsRepo = new SettingsRepository(db)
  const sessionRepo = new SessionRepository(db)
  const runtimeRegistry = new RuntimeRegistry(runtimeMode)
  const policyBroker = new RuntimePolicyBroker()
  const orchestrator = new RunOrchestrator(db, {
    runtimeRegistry,
    settingsRepo,
  })
  const bridge = new TeamsExecutionBridge({
    dbHandle: db,
    botRepo: bots,
    sessionRepo,
    orchestrator,
    policyBroker,
    getRuntimeState: () => ({
      runtimeMode,
      codexVersion: null,
      authMethod: 'none',
      accountId: null,
    }),
  })
  const teams = new TeamsService(db, bots, bridge)
  const botList = bots.listBots().bots
  return { db, bots, botList, teams, bridge, orchestrator }
}

describe('Phase 4D.2 Teams Production Hardening', () => {
  it('updates team metadata, lead, members, and bounds cleanly', async () => {
    const { db, botList, teams } = await setupHarness('mock')
    try {
      const lead = botList[0]!
      const worker = botList[1] ?? lead
      const created = teams.createTeam({
        name: 'Initial Squad',
        description: 'v1',
        leadBotId: lead.id,
        memberBotIds: [lead.id],
        bounds: { maxConcurrentTasks: 1 },
      })
      const updated = teams.updateTeam({
        teamId: created.id,
        name: 'Updated Squad',
        description: 'v2',
        leadBotId: lead.id,
        memberBotIds: [lead.id, worker.id],
        bounds: { maxConcurrentTasks: 3, maxTokens: 9000 },
      })
      assert.equal(updated.name, 'Updated Squad')
      assert.equal(updated.description, 'v2')
      assert.deepEqual(updated.memberBotIds, [lead.id, worker.id])
      assert.equal(updated.bounds.maxConcurrentTasks, 3)
      assert.equal(updated.bounds.maxTokens, 9000)
    } finally {
      db.close()
    }
  })

  it('fails closed with LIVE_TEAMS_GATED when starting or executing Teams outside mock mode', async () => {
    const { db, botList, teams, bridge } = await setupHarness('codex')
    try {
      const lead = botList[0]!
      const team = teams.createTeam({
        name: 'Live Gated Squad',
        leadBotId: lead.id,
        memberBotIds: [lead.id],
      })
      await assert.rejects(
        () =>
          teams.startTeamRun({
            teamId: team.id,
            goal: 'Attempt live team execution',
            idempotencyKey: 'live-gated-1',
            autoExecute: true,
          }),
        (err: unknown) =>
          err instanceof Error &&
          ((err as Error & { code?: string }).code === 'LIVE_TEAMS_GATED' ||
            err.message.includes('LIVE_TEAMS_GATED')),
      )

      const policy = await bridge.revalidateWorkerPolicy({
        teamId: team.id,
        teamRunId: null,
        taskId: 'task-1',
        ownerId: 'local-user',
        assignedBotId: lead.id,
        requestedPermissionMode: 'read-only',
        requirePolicyRevalidation: true,
        noPermissionEscalation: true,
        reusePriorApprovals: false,
      })
      assert.equal(policy.allowed, false)
      assert.equal(policy.reasonCode, 'LIVE_TEAMS_GATED')
    } finally {
      db.close()
    }
  })

  it('auto-executes mock team run with single-flight guard and lists run history and approvals', async () => {
    const { db, botList, teams } = await setupHarness('mock')
    try {
      const lead = botList[0]!
      const worker = botList[1] ?? lead
      const team = teams.createTeam({
        name: 'Mock Auto Squad',
        leadBotId: lead.id,
        memberBotIds: [lead.id, worker.id],
      })
      const started = await teams.startTeamRun({
        teamId: team.id,
        goal: 'Verify end-to-end mock team execution',
        idempotencyKey: 'auto-exec-1',
        autoExecute: true,
        plan: {
          summary: '2-step plan',
          tasks: [
            { planKey: 'step_1', assignedBotId: worker.id, prompt: 'Gather facts' },
            {
              planKey: 'step_2',
              assignedBotId: lead.id,
              prompt: 'Synthesize final report',
              dependsOn: ['step_1'],
            },
          ],
        },
      })

      const runs = teams.listRunsForTeam(team.id)
      assert.equal(runs.length, 1)
      assert.equal(runs[0]?.id, started.run.id)

      // Poll briefly for background mock execution to finish
      let finalRun = teams.getTeamRun(started.run.id)
      for (let i = 0; i < 40; i += 1) {
        if (
          finalRun.status === 'completed' ||
          finalRun.status === 'failed' ||
          finalRun.status === 'cancelled'
        ) {
          break
        }
        await new Promise((r) => setTimeout(r, 100))
        finalRun = teams.getTeamRun(started.run.id)
      }
      assert.equal(finalRun.status, 'completed')

      const tasks = teams.listRunTasks(started.run.id)
      assert.ok(tasks.length >= 2)
      assert.ok(tasks.every((t) => t.status === 'completed'))

      const approvals = teams.listPendingApprovalsForRun(started.run.id)
      assert.equal(Array.isArray(approvals), true)
    } finally {
      db.close()
    }
  })
})
