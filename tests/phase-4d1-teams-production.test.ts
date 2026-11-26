import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, it } from 'node:test'
import { CreateTeamIpcInputSchema, StartTeamRunIpcInputSchema } from '../packages/shared-types/ipc.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { MIGRATIONS, runMigrations } from '../apps/daemon/src/db/migrations.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { RunOrchestrator } from '../apps/daemon/src/execution/orchestrator.ts'
import { RuntimePolicyBroker } from '../apps/daemon/src/runtime/policy-broker.ts'
import { RuntimeRegistry } from '../apps/daemon/src/runtime/registry.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'
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

describe('Phase 4D.1 Production Teams Daemon Integration', () => {
  it('upgrades a v7 database with legacy teams/team_members to 0008 preserving existing records', async () => {
    const dir = makeTempDir('ghost-4d1-v7-')
    const dbPath = path.join(dir, 'ghost-bot.sqlite')
    const raw = new DatabaseSync(dbPath)
    raw.exec('PRAGMA foreign_keys = ON;')

    // Apply migrations 1..7 only
    raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`)
    for (const m of MIGRATIONS.filter((x) => x.version <= 7)) {
      if (m.version === 2) raw.exec('PRAGMA foreign_keys = OFF;')
      raw.exec(m.sql)
      if (m.version === 2) raw.exec('PRAGMA foreign_keys = ON;')
      raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        '2026-11-26T00:00:00.000Z',
      )
    }

    // Seed two legacy agents and a legacy Phase 1C team + team_members
    const now = '2026-11-26T00:00:00.000Z'
    raw.prepare(
      `INSERT INTO agents (id, name, description, avatar_json, instructions, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at)
       VALUES (?, ?, '', '{}', '', 'mock', 'mock-model', 'medium', ?, 'read-only', ?, ?)`,
    ).run('legacy-lead', 'Legacy Lead', dir, now, now)
    raw.prepare(
      `INSERT INTO agents (id, name, description, avatar_json, instructions, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at)
       VALUES (?, ?, '', '{}', '', 'mock', 'mock-model', 'medium', ?, 'read-only', ?, ?)`,
    ).run('legacy-worker', 'Legacy Worker', dir, now, now)
    raw.prepare(`INSERT INTO teams (id, name, leader_agent_id) VALUES ('legacy-team', 'Legacy Crew', 'legacy-lead')`).run()
    raw.prepare(`INSERT INTO team_members (team_id, agent_id, role) VALUES ('legacy-team', 'legacy-lead', 'lead')`).run()
    raw.prepare(`INSERT INTO team_members (team_id, agent_id, role) VALUES ('legacy-team', 'legacy-worker', 'member')`).run()
    raw.close()

    const dbHandle = await openGhostBotDatabase(dir)
    const verRow = dbHandle.sqlite.prepare('SELECT MAX(version) AS ver FROM schema_migrations').get() as { ver: number }
    assert.equal(Number(verRow.ver), 8)
    // Idempotent re-run
    assert.equal(runMigrations(dbHandle.sqlite), 0)

    const botRepo = new BotRepository(dbHandle)
    const sessionRepo = new SessionRepository(dbHandle)
    const settingsRepo = new SettingsRepository(dbHandle)
    const orchestrator = new RunOrchestrator(dbHandle, {
      runtimeRegistry: new RuntimeRegistry('mock'),
      settingsRepo,
    })
    const bridge = new TeamsExecutionBridge({
      dbHandle,
      botRepo,
      sessionRepo,
      orchestrator,
      policyBroker: new RuntimePolicyBroker(),
      getRuntimeState: () => ({ runtimeMode: 'mock', codexVersion: null, authMethod: 'none', accountId: null }),
    })
    const teamsService = new TeamsService(dbHandle, botRepo, bridge)

    const legacy = teamsService.getTeam('legacy-team')
    assert.equal(legacy.name, 'Legacy Crew')
    assert.equal(legacy.leadBotId, 'legacy-lead')
    assert.deepEqual(legacy.memberBotIds.sort(), ['legacy-lead', 'legacy-worker'])

    dbHandle.close()
  })

  it('executes sequential/parallel DAG tasks through RunOrchestrator, enforces policy, and supports cancellation', async () => {
    const dir = makeTempDir('ghost-4d1-exec-')
    const dbHandle = await openGhostBotDatabase(dir)
    seedInitialBotsIfNeeded(dbHandle)

    const botRepo = new BotRepository(dbHandle)
    const sessionRepo = new SessionRepository(dbHandle)
    const settingsRepo = new SettingsRepository(dbHandle)
    const runtimeRegistry = new RuntimeRegistry('mock')
    const orchestrator = new RunOrchestrator(dbHandle, { runtimeRegistry, settingsRepo })
    const policyBroker = new RuntimePolicyBroker()

    const presetAvatar = {
      kind: 'preset' as const,
      shape: 'ghost' as const,
      color: '#64748b',
      eyes: 'classic' as const,
      rotation: 0,
      animation: false,
    }
    const lead = await botRepo.createBot({
      name: 'CoS Bot',
      avatar: presetAvatar,
      instructions: 'Coordinate',
      runtimeId: 'mock',
      modelId: 'mock-model',
      effort: 'medium',
      workspacePath: dir,
      permission: 'read-only',
    })
    const workerA = await botRepo.createBot({
      name: 'Worker A',
      avatar: presetAvatar,
      instructions: 'Work A',
      runtimeId: 'mock',
      modelId: 'mock-model',
      effort: 'medium',
      workspacePath: dir,
      permission: 'read-only',
    })
    const workerB = await botRepo.createBot({
      name: 'Worker B',
      avatar: presetAvatar,
      instructions: 'Work B',
      runtimeId: 'mock',
      modelId: 'mock-model',
      effort: 'medium',
      workspacePath: dir,
      permission: 'workspace',
    })

    const bridge = new TeamsExecutionBridge({
      dbHandle,
      botRepo,
      sessionRepo,
      orchestrator,
      policyBroker,
      getRuntimeState: () => ({ runtimeMode: 'mock', codexVersion: null, authMethod: 'none', accountId: null }),
      pollIntervalMs: 10,
    })
    const teamsService = new TeamsService(dbHandle, botRepo, bridge)

    const team = teamsService.createTeam({
      name: 'Prod Integration Team',
      leadBotId: lead.id,
      memberBotIds: [lead.id, workerA.id, workerB.id],
    })

    // Verify Phase 1C team_members table stays in sync
    const memberCount = dbHandle.sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM team_members WHERE team_id = ?')
      .get(team.id) as { cnt: number }
    assert.equal(Number(memberCount.cnt), 3)

    // Policy broker denies permission escalation
    const esc = await bridge.revalidateWorkerPolicy({
      teamId: team.id,
      teamRunId: null,
      taskId: 't-esc',
      ownerId: 'local-user',
      assignedBotId: workerA.id,
      requestedPermissionMode: 'workspace',
      requirePolicyRevalidation: true,
      noPermissionEscalation: true,
      reusePriorApprovals: false,
    })
    assert.equal(esc.allowed, false)
    assert.equal(esc.reasonCode, 'PERMISSION_ESCALATION_DENIED')

    // Start and execute DAG run through RunOrchestrator
    const started = await teamsService.startTeamRun({
      teamId: team.id,
      goal: 'Run DAG',
      idempotencyKey: 'dag-prod-1',
      plan: {
        summary: 'Parallel then join',
        tasks: [
          { planKey: 'p1', assignedBotId: workerA.id, prompt: 'Task 1' },
          { planKey: 'p2', assignedBotId: workerB.id, prompt: 'Task 2', dependsOn: ['p1'] },
        ],
      },
    })

    const agg = await teamsService.executeTeamRunToCompletion(started.run.id)
    assert.equal(agg.status, 'completed')
    assert.equal(agg.completedCount, 2)

    // Verify durable team_execution_links correlation
    const links = dbHandle.sqlite
      .prepare('SELECT * FROM team_execution_links WHERE team_run_id = ?')
      .all(started.run.id) as Array<{ daemon_run_id: string; session_id: string }>
    assert.equal(links.length, 2)
    assert.notEqual(links[0]!.session_id, links[1]!.session_id)

    // Cancellation & restart reconciliation
    const started2 = await teamsService.startTeamRun({
      teamId: team.id,
      goal: 'Cancel me',
      idempotencyKey: 'dag-prod-cancel',
      plan: {
        summary: 'Single task',
        tasks: [{ planKey: 'c1', assignedBotId: workerA.id, prompt: 'Wait' }],
      },
    })
    const cancelRes = await teamsService.cancelTeamRun(started2.run.id)
    assert.equal(cancelRes.run.status, 'cancelled')

    const restarted = teamsService.reconcileOnStartup()
    assert.equal(restarted.tasksMarkedUncertain, 0)

    await runtimeRegistry.closeOwnedClient()
    dbHandle.close()
  })

  it('exposes authenticated daemon HTTP routes and validates strict Teams IPC schemas', async () => {
    const dir = makeTempDir('ghost-4d1-http-')
    const authToken = 'test-auth-token-4d1-secure'
    const daemon = new GhostBotDaemon({
      authToken,
      port: 0,
      dataDir: dir,
      runtimeMode: 'mock',
    })
    const { address } = await daemon.start()
    const headers = {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    }

    try {
      const botsRes = await fetch(`${address}/bots`, { headers })
      const botsJson = (await botsRes.json()) as { bots: Array<{ id: string }> }
      const botId = botsJson.bots[0]!.id

      const createRes = await fetch(`${address}/teams`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'HTTP Team',
          leadBotId: botId,
          memberBotIds: [botId],
        }),
      })
      assert.equal(createRes.status, 201)
      const team = (await createRes.json()) as { id: string }

      const previewRes = await fetch(`${address}/teams/${team.id}/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          plan: {
            summary: 'One task',
            tasks: [{ planKey: 'only', assignedBotId: botId, prompt: 'Hello' }],
          },
        }),
      })
      assert.equal(previewRes.status, 200)
      const preview = (await previewRes.json()) as { valid: boolean }
      assert.equal(preview.valid, true)

      const runRes = await fetch(`${address}/teams/${team.id}/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          goal: 'Check HTTP run',
          idempotencyKey: 'http-run-1',
        }),
      })
      assert.equal(runRes.status, 201)
      const runPayload = (await runRes.json()) as { run: { id: string } }

      const diagRes = await fetch(`${address}/teams/runs/${runPayload.run.id}/diagnostics`, { headers })
      assert.equal(diagRes.status, 200)
      const usageRes = await fetch(`${address}/teams/runs/${runPayload.run.id}/usage`, { headers })
      assert.equal(usageRes.status, 200)

      // Strict Zod IPC validation rejects extra fields
      assert.equal(
        CreateTeamIpcInputSchema.safeParse({
          name: 'Bad',
          leadBotId: botId,
          memberBotIds: [botId],
          extraUnexpected: true,
        }).success,
        false,
      )
      assert.equal(
        StartTeamRunIpcInputSchema.safeParse({
          teamId: team.id,
          goal: '',
          idempotencyKey: 'k',
        }).success,
        false,
      )
    } finally {
      await daemon.stop()
    }
  })
})
