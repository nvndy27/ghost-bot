import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWorkspaceElectron } from './helpers/workspace-electron.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { DaemonError } from '../apps/daemon/src/errors.ts'
import { WorkspaceOutputService } from '../apps/daemon/src/workspace/output-service.ts'

function seedTaskOutput(
  db: Awaited<ReturnType<typeof openGhostBotDatabase>>,
  botId: string,
  fixture: string,
) {
  const now = new Date().toISOString()
  const sessionId = `${fixture}-session`
  const runId = `${fixture}-run`
  db.sqlite.prepare(`
    INSERT INTO sessions (id, agent_id, account_id, runtime_id, title, created_at, updated_at)
    VALUES (?, ?, 'local', 'mock', 'Synthetic private task', ?, ?)
  `).run(sessionId, botId, now, now)
  db.sqlite.prepare(`
    INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode,
      config_snapshot_json, status, started_at, created_at)
    VALUES (?, ?, ?, ?, 'mock', 'mock-fast', 'medium', 'read-only', '{}', 'running', ?, ?)
  `).run(runId, sessionId, botId, fixture, now, now)
  db.sqlite.prepare(`
    INSERT INTO run_events (id, run_id, seq, event_key, type, payload_json, timestamp)
    VALUES (?, ?, 1, 'fixture-delta', 'message.delta', '{"delta":"PRIVATE_TASK_OUTPUT_CANARY"}', ?)
  `).run(`${fixture}-event`, runId, now)
  return { sessionId, runId, now }
}

test('Alpha.2F WorkspaceOutputService: chronological output, redaction, hidden reasoning exclusion, and isolation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-alpha2f-db-'))
  const db = await openGhostBotDatabase(dataDir)
  try {
    const now = new Date().toISOString()
    const insertBot = db.sqlite.prepare(
      `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at, archived_at)
       VALUES (?, ?, '', '', '{}', 'codex', 'gpt-5', 'medium', ?, 'read-only', ?, ?, NULL)`,
    )
    insertBot.run('bot-a', 'Bot A', dataDir, now, now)
    insertBot.run('bot-b', 'Bot B', dataDir, now, now)

    db.sqlite
      .prepare(
        `INSERT INTO sessions (id, agent_id, account_id, runtime_id, title, created_at, updated_at, archived_at)
         VALUES (?, ?, 'acc-1', 'codex', 'Session', ?, ?, NULL)`,
      )
      .run('sess-a', 'bot-a', now, now)
    db.sqlite
      .prepare(
        `INSERT INTO sessions (id, agent_id, account_id, runtime_id, title, created_at, updated_at, archived_at)
         VALUES (?, ?, 'acc-1', 'codex', 'Session B', ?, ?, NULL)`,
      )
      .run('sess-b', 'bot-b', now, now)

    db.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at)
         VALUES (?, ?, ?, ?, 'codex', 'gpt-5', 'medium', 'read-only', '{}', ?, NULL, ?, ?, ?)`,
      )
      .run('run-a', 'sess-a', 'bot-a', 'idem-a', 'completed', '2026-11-27T10:00:00.000Z', '2026-11-27T10:00:02.000Z', now)
    db.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at)
         VALUES (?, ?, ?, ?, 'codex', 'gpt-5', 'medium', 'read-only', '{}', ?, NULL, ?, NULL, ?)`,
      )
      .run('run-b', 'sess-b', 'bot-b', 'idem-b', 'interrupted', '2026-11-27T10:01:00.000Z', now)

    const insertEvent = db.sqlite.prepare(
      `INSERT INTO run_events (id, run_id, seq, event_key, type, payload_json, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insertEvent.run(
      'ev-1',
      'run-a',
      1,
      'k1',
      'run.tool_started',
      JSON.stringify({ toolName: 'read_file', message: 'Bearer secret_token_123456789012' }),
      '2026-11-27T10:00:00.500Z',
    )
    insertEvent.run(
      'ev-hidden',
      'run-a',
      2,
      'k2',
      'hidden_reasoning',
      JSON.stringify({ text: 'MUST_NOT_APPEAR' }),
      '2026-11-27T10:00:01.000Z',
    )

    db.sqlite
      .prepare(
        `INSERT INTO terminal_commands (id, owner_id, bot_id, run_id, canonical_workspace, executable, args_json, permission_mode, policy_id, command_hash, status, exit_code, signal, timed_out, termination_confirmed, stdout_preview, stderr_preview, expires_at, started_at, ended_at, created_at, updated_at)
         VALUES ('cmd-1', 'bot:bot-a', 'bot-a', 'run-a', ?, 'pnpm', '["test"]', 'read-only', 'pol-1', 'hash-1', 'completed', 0, NULL, 0, 1, 'all green sk-secret1234567890123456', '', ?, '2026-11-27T10:00:01.200Z', '2026-11-27T10:00:01.700Z', ?, ?)`,
      )
      .run(dataDir, now, now, now)

    const marked = seedTaskOutput(db, 'bot-a', 'task-marker')
    db.sqlite.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run(`teams.child-session:${marked.sessionId}`, '"fixture-identity"', marked.now)
    const linked = seedTaskOutput(db, 'bot-a', 'legacy-task-link')
    db.sqlite.exec(`
      INSERT INTO teams (id, name) VALUES ('output-team-fixture', 'Synthetic Team');
      INSERT INTO team_tasks (id, team_id, owner_id, root_task_id, depth, assigned_bot_id,
        idempotency_key, prompt, prompt_hash, status, attempt, max_attempts, token_budget,
        duration_budget_ms, created_at, updated_at)
      VALUES ('output-task-fixture', 'output-team-fixture', 'local-user', 'output-task-fixture',
        0, 'bot-a', 'output-task-fixture', 'fixture', 'fixture', 'running', 1, 1, 1, 1000,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `)
    db.sqlite.prepare(`
      INSERT INTO team_execution_links (id, team_task_id, agent_id, session_id,
        daemon_run_id, runtime_id, account_id, attempt, role, created_at)
      VALUES ('output-task-link', 'output-task-fixture', 'bot-a', ?, ?, 'mock', 'local', 1, 'worker', ?)
    `).run(linked.sessionId, linked.runId, linked.now)

    const service = new WorkspaceOutputService(db)
    const outA = service.listOutput({ botId: 'bot-a', limit: 50 })
    assert.equal(outA.authorized, true)
    assert.equal(outA.runs.length, 1)
    assert.equal(outA.runs[0]?.durationMs, 2000)

    const serialized = JSON.stringify(outA.entries)
    assert.equal(serialized.includes('secret_token_123456789012'), false)
    assert.equal(serialized.includes('sk-secret1234567890123456'), false)
    assert.equal(serialized.includes('MUST_NOT_APPEAR'), false)
    assert.ok(outA.entries.some((e) => e.source === 'build' && e.exitCode === 0 && e.durationMs === 500))

    assert.equal(JSON.stringify(outA).includes('PRIVATE_TASK_OUTPUT_CANARY'), false)
    assert.deepEqual(service.listOutput({ teamId: 'output-team-fixture' }).entries, [])
    for (const task of [marked, linked]) {
      assert.throws(() => service.listOutput({ botId: 'bot-a', sessionId: task.sessionId }), {
        code: 'OUTPUT_SESSION_UNAUTHORIZED',
      })
      assert.deepEqual(service.listOutput({ botId: 'bot-a', runId: task.runId }).runs, [])
      await assert.rejects(service.cancelExecution({ botId: 'bot-a', runId: task.runId }, {
        cancelRun: async () => assert.fail('Personal Output reached a private-task dispatch'),
      }), { code: 'OUTPUT_RUN_NOT_FOUND' })
    }

    // Cross-bot session rejected
    assert.throws(
      () => service.listOutput({ botId: 'bot-a', sessionId: 'sess-b' }),
      (err: unknown) => err instanceof DaemonError && err.code === 'OUTPUT_SESSION_UNAUTHORIZED',
    )

    // Interrupted run maps to uncertain status
    const outB = service.listOutput({ botId: 'bot-b' })
    assert.equal(outB.runs[0]?.status, 'uncertain')

    const cancelling = await service.cancelExecution({ botId: 'bot-a', runId: 'run-a' }, {
      cancelRun: async () => ({ status: 'cancelling' }),
    })
    assert.equal(cancelling.cancelled, false)
    assert.equal(cancelling.status, 'running')
    db.sqlite.prepare("UPDATE runs SET status = 'cancelling' WHERE id = 'run-a'").run()
    assert.deepEqual(service.listOutput({ botId: 'bot-a' }).runs.map(({ status, cancellable }) =>
      ({ status, cancellable })), [{ status: 'running', cancellable: false }])

    // Cross-bot cancel rejected
    await assert.rejects(
      () =>
        service.cancelExecution(
          { botId: 'bot-a', runId: 'run-b' },
          { cancelRun: async () => {} },
        ),
      (err: unknown) => err instanceof DaemonError && err.code === 'OUTPUT_RUN_NOT_FOUND',
    )
  } finally {
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('Alpha.2F Electron Output filters, cancels, isolates and recovers persisted runs', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-alpha2f-e2e-'))
  let app = await launchWorkspaceElectron(dataDir)

  try {
    const page = await app.firstWindow()
    await page.getByTestId('workspace-tab-output').click()
    const output = page.getByTestId('workspace-output-tab')
    await output.waitFor()

    const fixture = await page.evaluate(async () => {
      const bridge = window.ghostBot!
      const { activeBotId } = await bridge.listBots()
      if (!activeBotId) throw new Error('Missing active bot')
      const first = await bridge.createSession({ agentId: activeBotId })
      const { run: completed } = await bridge.startRun({
        sessionId: first.id, idempotencyKey: crypto.randomUUID(), text: 'Hello mock runtime',
      })
      const second = await bridge.createSession({ agentId: activeBotId })
      const { run: pending } = await bridge.startRun({
        sessionId: second.id, idempotencyKey: crypto.randomUUID(), text: 'Test approval flow',
      })
      return { botId: activeBotId, completedId: completed.id, pendingId: pending.id, pendingSession: second.id }
    })
    await output.getByTestId('output-refresh-btn').click()
    const pending = output.getByTestId(`output-entry-run-summary:${fixture.pendingId}`)
    await pending.getByText('Run awaiting_approval', { exact: true }).waitFor()
    assert.equal(await page.locator(`[data-testid="output-cancel-${fixture.pendingId}"]`).count(), 1)
    await pending.getByRole('button', { name: 'Cancel', exact: true }).click()
    const cancelledTitle = pending.getByText('Run cancelled', { exact: true })
    const outputError = output.getByTestId('output-error-banner')
    await cancelledTitle.or(outputError).waitFor()
    assert.deepEqual(await outputError.allTextContents(), [])
    await cancelledTitle.waitFor()
    assert.equal(await page.evaluate(async (id) => (await window.ghostBot!.getRun(id)).status, fixture.pendingId), 'cancelled')
    assert.equal(await pending.getByRole('button', { name: 'Cancel', exact: true }).count(), 0)
    const completed = output.getByTestId(`output-entry-run-summary:${fixture.completedId}`)
    await completed.getByText('Run completed', { exact: true }).waitFor()

    await output.getByTestId('output-source-filter').selectOption('run')
    await output.getByTestId('output-search-input').fill('Run')
    await completed.waitFor()
    await output.getByTestId('output-clear-btn').click()
    await output.getByTestId('output-empty-state').waitFor()
    await output.getByTestId('output-refresh-btn').click()
    await completed.waitFor()
    await pending.waitFor()

    const bot = page.locator('[role="listbox"][aria-label="Bots"] [role="option"]').nth(1)
    await bot.click()
    await output.getByTestId('output-empty-state').waitFor()
    assert.equal(await completed.count(), 0)
    assert.equal(await pending.count(), 0)

    await app.close()
    // Persist a stranded run to model a process interrupted before terminal status was written.
    const db = await openGhostBotDatabase(dataDir)
    const interruptedId = 'alpha2g-interrupted-fixture'
    let privateTask: ReturnType<typeof seedTaskOutput>
    try {
      const now = new Date().toISOString()
      db.sqlite.prepare(`
        INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode,
          config_snapshot_json, status, started_at, created_at)
        VALUES (?, ?, ?, 'alpha2g-interrupted', 'mock', 'mock-fast', 'medium', 'read-only', '{}', 'running', ?, ?)
      `).run(interruptedId, fixture.pendingSession, fixture.botId, now, now)
      privateTask = seedTaskOutput(db, fixture.botId, 'packaged-private-task')
      db.sqlite.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run(`teams.child-session:${privateTask.sessionId}`, '"fixture-identity"', privateTask.now)
    } finally {
      db.close()
    }

    app = await launchWorkspaceElectron(dataDir)
    const restarted = await app.firstWindow()
    const restartedOutput = restarted.getByTestId('workspace-output-tab')
    await restartedOutput.getByTestId('output-empty-state').waitFor()
    await restarted.locator('[role="listbox"][aria-label="Bots"] [role="option"]').first().click()
    await restartedOutput.getByTestId(`output-entry-run-summary:${fixture.pendingId}`)
      .getByText('Run cancelled', { exact: true }).waitFor()
    const interrupted = restartedOutput.getByTestId(`output-entry-run-summary:${interruptedId}`)
    await interrupted.getByText('uncertain', { exact: true }).waitFor()
    assert.equal(await interrupted.getByRole('button', { name: 'Cancel', exact: true }).count(), 0)
    assert.equal(await restarted.evaluate(async (id) => (await window.ghostBot!.getRun(id)).status, interruptedId), 'interrupted')
    assert.equal(await restartedOutput.getByTestId(`output-entry-run-summary:${privateTask.runId}`).count(), 0)
    const access = { botId: fixture.botId }
    const listed = await restarted.evaluate((scope) => window.ghostBot!.listWorkspaceOutput(scope), access)
    assert.equal(listed.entries.some((entry) => entry.runId === privateTask.runId ||
      entry.message.includes('PRIVATE_TASK_OUTPUT_CANARY')), false)
    await assert.rejects(restarted.evaluate((scope) => window.ghostBot!.listWorkspaceOutput(scope), {
      ...access, sessionId: privateTask.sessionId,
    }), /outside personal Workspace Output/)
    await assert.rejects(restarted.evaluate((scope) => window.ghostBot!.cancelWorkspaceOutput(scope), {
      ...access, runId: privateTask.runId,
    }), /Run not found for authorized bot/)

  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
