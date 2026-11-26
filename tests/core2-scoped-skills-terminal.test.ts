import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  DiscoverLocalSkillsInputSchema,
  RequestTerminalCommandInputSchema,
} from '../packages/shared-types/ipc.ts'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { SessionRepository } from '../apps/daemon/src/sessions/repository.ts'
import { LocalSkillsService } from '../apps/daemon/src/skills/service.ts'
import { ScopedTerminalService } from '../apps/daemon/src/terminal/service.ts'

async function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-core2-'))
  chmodSync(dir, 0o700)
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  chmodSync(workspace, 0o700)

  const db = await openGhostBotDatabase(dir)
  seedInitialBotsIfNeeded(db)
  const botRepo = new BotRepository(db)
  const sessionRepo = new SessionRepository(db)
  const bot = await botRepo.createBot({
    name: 'Core2 Terminal Bot',
    description: 'Scoped terminal test bot',
    instructions: 'Test',
    avatar: { shape: 'chief', color: '#4B5563', eyes: 'classic', rotation: 0, animation: true },
    runtimeId: 'codex',
    modelId: 'gpt-5.4-mini',
    effort: 'medium',
    workspacePath: workspace,
    permission: 'ask-approval',
  })

  const terminal = new ScopedTerminalService(db, botRepo)
  const skills = new LocalSkillsService(db)
  const chatSess = sessionRepo.createSession({ agentId: bot.id, title: 'Core2' })

  const insertRun = (id: string, status: string, permissionMode = 'ask-approval') => {
    const nowIso = new Date().toISOString()
    db.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, status, permission_mode, runtime_id, model_id, effort, config_snapshot_json, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'mock', 'gpt-5.4-mini', 'medium', '{}', ?, ?)`,
      )
      .run(id, chatSess.id, bot.id, `idem_${id}`, status, permissionMode, nowIso, nowIso)
  }

  return {
    dir,
    workspace,
    db,
    botRepo,
    sessionRepo,
    bot,
    terminal,
    skills,
    insertRun,
    async cleanup() {
      await terminal.shutdownAll()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('Core.2: Scoped Terminal & Local Skills Registry', () => {
  it('executes approved command inside bwrap workspace, isolates host filesystem/network/env, and enforces output bounds', async () => {
    const env = await setupEnv()
    const hostCanary = join(env.dir, 'host-secret-canary.txt')
    writeFileSync(hostCanary, 'HOST_SECRET_CANARY_VALUE', 'utf8')
    const tcpServer = net.createServer()
    await new Promise<void>((res) => tcpServer.listen(0, '127.0.0.1', res))
    const tcpPort = (tcpServer.address() as net.AddressInfo).port

    try {
      const caps = await env.terminal.getCapabilities()
      assert.equal(caps.bubblewrapAvailable, true)
      assert.equal(caps.interactivePtySupported, false)
      assert.equal(caps.hostUnisolatedFallbackAllowed, false)

      // 1. Valid approved command
      const req1 = env.terminal.requestCommandApproval({
        botId: env.bot.id,
        executable: '/bin/sh',
        args: ['-c', 'pwd && echo "ok-core2" > out.txt && cat out.txt'],
      })
      assert.equal(req1.status, 'awaiting_approval')

      const res1 = await env.terminal.resolveCommandApproval({
        commandId: req1.id,
        decision: 'approved',
        expectedCommandHash: req1.commandHash,
      })
      assert.equal(res1.status, 'completed')
      assert.equal(res1.exitCode, 0)
      assert.match(res1.stdoutPreview, /\/workspace/)
      assert.match(res1.stdoutPreview, /ok-core2/)
      assert.equal(res1.replayAllowed, false)

      // Duplicate consumption rejected
      await assert.rejects(
        () => env.terminal.resolveCommandApproval({ commandId: req1.id, decision: 'approved' }),
        { code: 'TERMINAL_NOT_AWAITING_APPROVAL' },
      )

      // 2. Host filesystem, env, and network containment inside bwrap
      process.env.GHOST_TEST_LEAK_GUARD = 'MUST_NOT_APPEAR_IN_BWRAP'
      const req2 = env.terminal.requestCommandApproval({
        botId: env.bot.id,
        executable: '/bin/sh',
        args: [
          '-c',
          `test ! -r "${hostCanary}" && test -z "$GHOST_TEST_LEAK_GUARD" && test -z "$DBUS_SESSION_BUS_ADDRESS" && ! node -e "const s=require('net').connect(${tcpPort},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))"`,
        ],
      })
      const res2 = await env.terminal.resolveCommandApproval({
        commandId: req2.id,
        decision: 'approved',
      })
      assert.equal(res2.status, 'completed', `Containment probe failed: ${res2.stderrPreview}`)
      assert.equal(res2.exitCode, 0)

      // 3. Output bounds (> 256 KiB truncated)
      const req3 = env.terminal.requestCommandApproval({
        botId: env.bot.id,
        executable: '/bin/sh',
        args: ['-c', 'head -c 300000 /dev/zero | tr "\\0" "A"'],
      })
      const res3 = await env.terminal.resolveCommandApproval({
        commandId: req3.id,
        decision: 'approved',
      })
      assert.equal(res3.status, 'completed')
      assert.equal(res3.truncated, true)
      assert.ok(Buffer.byteLength(res3.stdoutPreview, 'utf8') <= 256 * 1024)
    } finally {
      delete process.env.GHOST_TEST_LEAK_GUARD
      await new Promise<void>((res) => tcpServer.close(() => res()))
      await env.cleanup()
    }
  })

  it('enforces denial, expiry, hash mismatch, read-only, non-running runs, path traversal, and workspace replacement', async () => {
    const env = await setupEnv()
    try {
      // Denied command never executes
      const deniedReq = env.terminal.requestCommandApproval({
        botId: env.bot.id,
        executable: '/bin/echo',
        args: ['should-not-run'],
      })
      const deniedRes = await env.terminal.resolveCommandApproval({
        commandId: deniedReq.id,
        decision: 'denied',
      })
      assert.equal(deniedRes.status, 'cancelled')
      assert.equal(deniedRes.errorCode, 'TERMINAL_APPROVAL_DENIED')

      // Hash mismatch rejected
      const mismatchReq = env.terminal.requestCommandApproval({
        botId: env.bot.id,
        executable: '/bin/echo',
        args: ['hi'],
      })
      await assert.rejects(
        () =>
          env.terminal.resolveCommandApproval({
            commandId: mismatchReq.id,
            decision: 'approved',
            expectedCommandHash: '0'.repeat(64),
          }),
        { code: 'TERMINAL_COMMAND_HASH_MISMATCH' },
      )

      // Expired approval rejected
      env.db.sqlite
        .prepare(`UPDATE terminal_commands SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?`)
        .run(mismatchReq.id)
      await assert.rejects(
        () => env.terminal.resolveCommandApproval({ commandId: mismatchReq.id, decision: 'approved' }),
        { code: 'TERMINAL_APPROVAL_EXPIRED' },
      )

      // Read-only bot rejected
      env.db.sqlite
        .prepare(`UPDATE agents SET permission_mode = 'read-only' WHERE id = ?`)
        .run(env.bot.id)
      assert.throws(
        () => env.terminal.requestCommandApproval({ botId: env.bot.id, executable: '/bin/echo', args: ['x'] }),
        { code: 'TERMINAL_PERMISSION_FORBIDDEN' },
      )
      env.db.sqlite
        .prepare(`UPDATE agents SET permission_mode = 'ask-approval' WHERE id = ?`)
        .run(env.bot.id)

      // Non-running parent runs rejected
      env.insertRun('run_term_done', 'completed')
      assert.throws(
        () =>
          env.terminal.requestCommandApproval({
            botId: env.bot.id,
            runId: 'run_term_done',
            executable: '/bin/echo',
            args: ['x'],
          }),
        { code: 'TERMINAL_RUN_NOT_ACTIVE' },
      )

      // Executable traversal rejected
      assert.throws(
        () =>
          env.terminal.requestCommandApproval({
            botId: env.bot.id,
            executable: '../bin/sh',
            args: [],
          }),
        { code: 'VALIDATION_ERROR' },
      )

      // Workspace replacement race rejected before spawn
      const raceReq = env.terminal.requestCommandApproval({
        botId: env.bot.id,
        executable: '/bin/echo',
        args: ['race'],
      })
      const altWorkspace = join(env.dir, 'alt-workspace')
      mkdirSync(altWorkspace, { recursive: true })
      env.db.sqlite
        .prepare(`UPDATE agents SET workspace_path = ? WHERE id = ?`)
        .run(altWorkspace, env.bot.id)
      await assert.rejects(
        () => env.terminal.resolveCommandApproval({ commandId: raceReq.id, decision: 'approved' }),
        { code: 'TERMINAL_WORKSPACE_CHANGED' },
      )
    } finally {
      await env.cleanup()
    }
  })

  it('handles timeout, descendant termination, active cancellation, and startup reconciliation without replay', async () => {
    const env = await setupEnv()
    try {
      // Timeout kills process & descendants
      const tReq = env.terminal.requestCommandApproval({
        botId: env.bot.id,
        executable: '/bin/sh',
        args: ['-c', 'sleep 30 & wait'],
      })
      const tRes = await env.terminal.resolveCommandApproval({
        commandId: tReq.id,
        decision: 'approved',
        timeoutMs: 250,
      })
      assert.equal(tRes.status, 'failed')
      assert.equal(tRes.timedOut, true)
      assert.equal(tRes.errorCode, 'TERMINAL_TIMEOUT')
      assert.equal(tRes.terminationConfirmed, true)

      // Active cancellation
      const cReq = env.terminal.requestCommandApproval({
        botId: env.bot.id,
        executable: '/bin/sleep',
        args: ['20'],
      })
      const execPromise = env.terminal.resolveCommandApproval({
        commandId: cReq.id,
        decision: 'approved',
        timeoutMs: 10_000,
      })
      await new Promise((r) => setTimeout(r, 150))
      const cancelRes = await env.terminal.cancelCommand(cReq.id)
      assert.equal(cancelRes.status, 'cancelled')
      assert.equal(cancelRes.terminationConfirmed, true)
      const finished = await execPromise
      assert.equal(finished.status, 'cancelled')

      // Restart reconciliation marks running -> uncertain, awaiting_approval -> cancelled
      const leftPending = env.terminal.requestCommandApproval({
        botId: env.bot.id,
        executable: '/bin/echo',
        args: ['pending-before-restart'],
      })
      const leftRunning = env.terminal.requestCommandApproval({
        botId: env.bot.id,
        executable: '/bin/echo',
        args: ['running-before-restart'],
      })
      env.db.sqlite
        .prepare(`UPDATE terminal_commands SET status = 'running' WHERE id = ?`)
        .run(leftRunning.id)

      const rec = env.terminal.reconcileOnStartup()
      assert.equal(rec.uncertainCommands, 1)
      assert.equal(rec.cancelledApprovals, 1)
      assert.equal(env.terminal.getCommand(leftRunning.id).status, 'uncertain')
      assert.equal(env.terminal.getCommand(leftRunning.id).terminationConfirmed, false)
      assert.equal(env.terminal.getCommand(leftPending.id).status, 'cancelled')
    } finally {
      await env.cleanup()
    }
  })

  it('discovers local skills, pins SHA-256 trust, invalidates on content change, rejects symlinks, and never grants terminal permission', async () => {
    const env = await setupEnv()
    try {
      const skillsRoot = join(env.dir, 'skills-root')
      const validDir = join(skillsRoot, 'sample-skill')
      const invalidDir = join(skillsRoot, 'bad-skill')
      const symlinkDir = join(skillsRoot, 'symlink-skill')
      mkdirSync(validDir, { recursive: true })
      mkdirSync(invalidDir, { recursive: true })
      mkdirSync(symlinkDir, { recursive: true })

      const validFile = join(validDir, 'SKILL.md')
      writeFileSync(
        validFile,
        `---\nname: sample-skill\ndescription: Harmless test skill\n---\n# Instructions\nDo safe things.\n`,
        'utf8',
      )
      writeFileSync(join(invalidDir, 'SKILL.md'), 'No frontmatter here', 'utf8')

      const discovered = env.skills.discoverSkills([skillsRoot])
      assert.equal(discovered.length, 2)
      const valid = discovered.find((s) => s.name === 'sample-skill')!
      const bad = discovered.find((s) => s.sourcePath.includes('bad-skill'))!
      assert.equal(valid.trustState, 'untrusted')
      assert.equal(valid.enabled, false)
      assert.equal(bad.trustState, 'invalid')
      assert.ok(bad.validationError)

      // Cannot enable untrusted skill
      assert.throws(() => env.skills.setEnabled(valid.id, true), { code: 'SKILL_UNTRUSTED' })

      // Trust & enable
      const trusted = env.skills.approveTrust(valid.id)
      assert.equal(trusted.trustState, 'trusted')
      const enabled = env.skills.setEnabled(valid.id, true)
      assert.equal(enabled.enabled, true)

      // Skill trust never grants terminal permission to read-only bot
      env.db.sqlite
        .prepare(`UPDATE agents SET permission_mode = 'read-only' WHERE id = ?`)
        .run(env.bot.id)
      assert.throws(
        () => env.terminal.requestCommandApproval({ botId: env.bot.id, executable: '/bin/echo', args: ['x'] }),
        { code: 'TERMINAL_PERMISSION_FORBIDDEN' },
      )

      // Content change invalidates trust and disables skill
      writeFileSync(
        validFile,
        `---\nname: sample-skill\ndescription: Modified description\n---\nChanged content.\n`,
        'utf8',
      )
      const rediscovered = env.skills.discoverSkills([skillsRoot])
      const changed = rediscovered.find((s) => s.id === valid.id)!
      assert.equal(changed.trustState, 'revoked')
      assert.equal(changed.enabled, false)

      // Symlinked SKILL.md rejected
      const outsideFile = join(env.dir, 'outside.md')
      writeFileSync(outsideFile, '---\nname: sym\ndescription: sym\n---\n', 'utf8')
      symlinkSync(outsideFile, join(symlinkDir, 'SKILL.md'))
      assert.throws(() => env.skills.discoverSkills([skillsRoot]), { code: 'SKILL_SYMLINK_REJECTED' })

      // Strict IPC schemas reject unexpected fields
      assert.equal(
        RequestTerminalCommandInputSchema.safeParse({
          botId: env.bot.id,
          executable: '/bin/echo',
          args: [],
          extra: true,
        }).success,
        false,
      )
      assert.equal(
        DiscoverLocalSkillsInputSchema.safeParse({ roots: [], extra: 1 }).success,
        false,
      )
    } finally {
      await env.cleanup()
    }
  })
})
