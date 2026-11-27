import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { LinuxSecretServiceStore } from '../apps/daemon/src/secrets/store.ts'
import { ScopedTerminalService } from '../apps/daemon/src/terminal/service.ts'

test('CORE1-SS-01: LinuxSecretServiceStore fails closed when busctl/D-Bus service/collection cannot be verified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-core1-ss-'))
  try {
    const fakeSecretTool = join(dir, 'secret-tool')
    writeFileSync(fakeSecretTool, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    // 1. Missing busctl -> fails closed (previously returned available: true)
    const missingBusctl = new LinuxSecretServiceStore({
      secretToolPath: fakeSecretTool,
      busctlPath: join(dir, 'nonexistent-busctl'),
    })
    const s1 = missingBusctl.getStatus()
    assert.equal(s1.available, false)
    assert.equal(s1.backend, 'unavailable')
    assert.match(s1.reason ?? '', /busctl/i)
    assert.equal(s1.diagnostics?.executableAvailable, true)
    assert.equal(s1.diagnostics?.dbusServiceAvailable, false)

    // 2. busctl reports org.freedesktop.secrets unreachable -> fails closed
    const unreachableBusctl = join(dir, 'busctl-unreachable')
    writeFileSync(unreachableBusctl, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const s2 = new LinuxSecretServiceStore({
      secretToolPath: fakeSecretTool,
      busctlPath: unreachableBusctl,
    }).getStatus()
    assert.equal(s2.available, false)
    assert.equal(s2.locked, false)
    assert.match(s2.reason ?? '', /org\.freedesktop\.secrets/i)
    assert.equal(s2.diagnostics?.dbusServiceAvailable, false)

    // 3. org.freedesktop.secrets reachable, collection locked -> locked: true, available: false
    const lockedBusctl = join(dir, 'busctl-locked')
    writeFileSync(
      lockedBusctl,
      '#!/bin/sh\nif [ "$2" = "call" ]; then echo "s \\":1.99\\""; exit 0; fi\necho "b true"\nexit 0\n',
      { mode: 0o755 },
    )
    const s3 = new LinuxSecretServiceStore({
      secretToolPath: fakeSecretTool,
      busctlPath: lockedBusctl,
    }).getStatus()
    assert.equal(s3.available, false)
    assert.equal(s3.locked, true)
    assert.equal(s3.diagnostics?.dbusServiceAvailable, true)
    assert.equal(s3.diagnostics?.collectionAccessible, true)

    // 4. org.freedesktop.secrets reachable, collection missing/inaccessible -> fails closed
    const noCollBusctl = join(dir, 'busctl-nocoll')
    writeFileSync(
      noCollBusctl,
      '#!/bin/sh\nif [ "$2" = "call" ]; then echo "s \\":1.99\\""; exit 0; fi\nexit 1\n',
      { mode: 0o755 },
    )
    const s4 = new LinuxSecretServiceStore({
      secretToolPath: fakeSecretTool,
      busctlPath: noCollBusctl,
    }).getStatus()
    assert.equal(s4.available, false)
    assert.equal(s4.locked, false)
    assert.equal(s4.diagnostics?.dbusServiceAvailable, true)
    assert.equal(s4.diagnostics?.collectionAccessible, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CORE2-TERM-01: ScopedTerminalService revokes pending, active, and unconfirmed commands on run/bot termination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-core2-term-'))
  chmodSync(dir, 0o700)
  const workspace = join(dir, 'ws')
  mkdirSync(workspace, { recursive: true })
  chmodSync(workspace, 0o700)
  const dbHandle = await openGhostBotDatabase(dir)
  try {
    const botRepo = new BotRepository(dbHandle)
    const bot = await botRepo.createBot({
      name: 'Term Revoke Bot',
      description: 'CORE2-TERM-01',
      instructions: '',
      runtimeId: 'mock-offline',
      modelId: 'mock-fast',
      effort: 'low',
      permission: 'workspace',
      workspacePath: workspace,
      avatar: { kind: 'preset', shape: 'ghost', color: '#418D79', eyes: 'classic', rotation: 0, animation: true },
    })

    const termService = new ScopedTerminalService(dbHandle, botRepo)

    // 1. Pending command is cancelled immediately when run terminates
    const pendingCmd = termService.requestCommandApproval({
      botId: bot.id,
      executable: '/bin/echo',
      args: ['should-not-run'],
    })
    await termService.revokeByRunId(pendingCmd.runId, 'run_cancelled')
    const afterPendingRevoke = termService.getCommand(pendingCmd.id)
    assert.equal(afterPendingRevoke.status, 'cancelled')
    assert.equal(afterPendingRevoke.terminationConfirmed, true)
    assert.equal(afterPendingRevoke.replayAllowed, false)
    await assert.rejects(
      () =>
        termService.resolveCommandApproval({
          commandId: pendingCmd.id,
          decision: 'approved',
        }),
      /is cancelled/i,
    )

    // 2. Running command with no tracked process (unconfirmed) is marked uncertain, not cancelled
    const orphanCmd = termService.requestCommandApproval({
      botId: bot.id,
      executable: '/bin/sleep',
      args: ['5'],
    })
    dbHandle.sqlite
      .prepare(`UPDATE terminal_commands SET status = 'running' WHERE id = ?`)
      .run(orphanCmd.id)
    await termService.revokeByRunId(orphanCmd.runId, 'run_failed')
    const afterOrphan = termService.getCommand(orphanCmd.id)
    assert.equal(afterOrphan.status, 'uncertain')
    assert.equal(afterOrphan.terminationConfirmed, false)
    assert.equal(afterOrphan.replayAllowed, false)

    // 3. Active process-tree command is killed on revokeByRunId and confirmed cancelled
    const caps = await termService.getCapabilities()
    if (caps.bubblewrapAvailable) {
      const activeCmd = termService.requestCommandApproval({
        botId: bot.id,
        executable: '/bin/sh',
        args: ['-c', 'sleep 30'],
      })
      const execPromise = termService.resolveCommandApproval({
        commandId: activeCmd.id,
        decision: 'approved',
        timeoutMs: 30_000,
      })
      await new Promise((r) => setTimeout(r, 150))
      await termService.revokeByRunId(activeCmd.runId, 'run_cancelled')
      const resolved = await execPromise
      assert.equal(resolved.status, 'cancelled')
      assert.equal(resolved.terminationConfirmed, true)
    }

    // 4. Bot revocation cancels any remaining awaiting_approval commands for that bot
    const botCmd = termService.requestCommandApproval({
      botId: bot.id,
      executable: '/bin/echo',
      args: ['bot-revoked'],
    })
    await termService.revokeByBotId(bot.id, 'bot_deleted')
    const afterBotRevoke = termService.getCommand(botCmd.id)
    assert.equal(afterBotRevoke.status, 'cancelled')
    assert.equal(afterBotRevoke.terminationConfirmed, true)
  } finally {
    dbHandle.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
