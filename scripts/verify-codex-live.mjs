import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerAdapter } from '../packages/runtime-adapters/codex/codex-app-server.ts'

const args = new Set(process.argv.slice(2))
const loginOnly = args.has('--login-only')
const profileDir = process.env.GHOST_BOT_CODEX_PROFILE || undefined

// Phase 0 live verification evidence: allow read-only, ask-approval, and workspace
// ONLY for this verification harness; production keeps full-access disabled.
const harnessEvidence = {
  sandboxEnforced: true,
  approvalEnforced: true,
  sensitiveActionsEnforced: true,
  verifiedModes: ['read-only', 'ask-approval', 'workspace'],
}

const adapter = new CodexAppServerAdapter({
  profileDir,
  permissionEvidence: harnessEvidence,
  fullAccessOptIn: false,
  approvalTimeoutMs: 30_000,
  onAuthUrl: ({ authUrl, loginId }) => {
    console.log(JSON.stringify({ event: 'auth_url_ready', loginId, authUrl }))
  },
})

try {
  if (loginOnly) {
    const status = await adapter.getAccountSummary(false)
    if (status.accountPresent && status.accountType === 'chatgpt') {
      console.log(
        JSON.stringify({
          alreadySignedIn: true,
          accountType: status.accountType,
          planType: status.planType,
        }),
      )
    } else {
      const auth = await adapter.authenticate()
      const after = await adapter.getAccountSummary(false)
      console.log(
        JSON.stringify({
          authStatus: auth.status,
          detail: auth.detail ?? null,
          accountType: after.accountType,
          planType: after.planType,
        }),
      )
      if (auth.status !== 'connected') process.exitCode = 1
    }
  } else {
    const account = await adapter.getAccountSummary(false)
    if (!account.accountPresent || account.accountType !== 'chatgpt') {
      console.error(
        JSON.stringify({
          error: 'NOT_SIGNED_IN',
          message: 'Dedicated Codex profile is not signed in with ChatGPT. Run with --login-only first.',
          accountType: account.accountType,
        }),
      )
      process.exitCode = 1
    } else {
      const models = await adapter.listModels()
      const usage = await adapter.getUsage()
      const modelId = models[0]?.id
      assert.ok(modelId, 'Expected at least one discovered Codex model')
      const effort = models[0]?.efforts.includes('low') ? 'low' : models[0]?.efforts[0]

      const wsReadOnly = await mkdtemp(join(tmpdir(), 'ghost-bot-ro-'))
      const wsWrite = await mkdtemp(join(tmpdir(), 'ghost-bot-ws-'))
      const wsOutside = await mkdtemp(join(tmpdir(), 'ghost-bot-out-'))

      try {
        await writeFile(join(wsReadOnly, 'fixture.txt'), 'GHOST_BOT_FIXTURE_42\n', 'utf8')

        // 1. Read-only access + denied write
        const roSession = await adapter.createSession({
          agentId: 'verify-ro',
          accountId: 'codex-sub',
          modelId,
          effort,
          permission: 'read-only',
          workspace: wsReadOnly,
          instructions: 'Be concise. Do not ask follow-up questions.',
        })

        let roText = ''
        let roStreamed = false
        for await (const ev of adapter.run({
          runId: 'verify-ro-read',
          session: roSession,
          text: 'Read fixture.txt in the current workspace and reply with only its exact contents.',
        })) {
          if (ev.type === 'message.delta') {
            roStreamed = true
            roText += ev.text
          }
          if (ev.type === 'approval.requested') {
            await adapter.resolveApproval({
              approvalId: ev.approvalId,
              runId: ev.runId,
              argsHash: ev.argsHash,
              decision: 'deny',
            })
          }
        }

        // Denied write in read-only mode
        for await (const ev of adapter.run({
          runId: 'verify-ro-write',
          session: roSession,
          text: 'Create a file named denied.txt containing "bad" in the current workspace.',
        })) {
          if (ev.type === 'approval.requested') {
            await adapter.resolveApproval({
              approvalId: ev.approvalId,
              runId: ev.runId,
              argsHash: ev.argsHash,
              decision: 'deny',
            })
          }
        }
        const readOnlyDeniedWriteClean = !existsSync(join(wsReadOnly, 'denied.txt'))

        // 2. Workspace-contained write + outside write attempt
        const wsSession = await adapter.createSession({
          agentId: 'verify-ws',
          accountId: 'codex-sub',
          modelId,
          effort,
          permission: 'workspace',
          workspace: wsWrite,
          instructions: 'Be concise.',
        })
        for await (const ev of adapter.run({
          runId: 'verify-ws-write',
          session: wsSession,
          text: 'Create a file named allowed.txt containing "ok" in the current workspace.',
        })) {
          if (ev.type === 'approval.requested') {
            await adapter.resolveApproval({
              approvalId: ev.approvalId,
              runId: ev.runId,
              argsHash: ev.argsHash,
              decision: 'allow-once',
            })
          }
        }
        const workspaceWriteSucceeded = existsSync(join(wsWrite, 'allowed.txt'))

        const outsideTarget = join(wsOutside, 'escape.txt')
        const symlinkPath = join(wsWrite, 'outside-link')
        await symlink(wsOutside, symlinkPath)
        const symlinkTarget = join(symlinkPath, 'symlink-escape.txt')
        for await (const ev of adapter.run({
          runId: 'verify-ws-outside',
          session: wsSession,
          text: `Write "escape" to ${outsideTarget} and also write "symlink" to ${symlinkTarget}.`,
        })) {
          if (ev.type === 'approval.requested') {
            await adapter.resolveApproval({
              approvalId: ev.approvalId,
              runId: ev.runId,
              argsHash: ev.argsHash,
              decision: 'deny',
            })
          }
        }
        const outsideWriteBlocked = !existsSync(outsideTarget)
        const symlinkWriteBlocked = !existsSync(join(wsOutside, 'symlink-escape.txt'))

        // 3. Approval request and rejection
        const askSession = await adapter.createSession({
          agentId: 'verify-ask',
          accountId: 'codex-sub',
          modelId,
          effort,
          permission: 'ask-approval',
          workspace: wsWrite,
          instructions: 'Be concise.',
        })
        let sawApprovalRequest = false
        for await (const ev of adapter.run({
          runId: 'verify-ask-reject',
          session: askSession,
          text: 'Run the shell command: touch rejected-by-user.txt',
        })) {
          if (ev.type === 'approval.requested') {
            sawApprovalRequest = true
            await adapter.resolveApproval({
              approvalId: ev.approvalId,
              runId: ev.runId,
              argsHash: ev.argsHash,
              decision: 'deny',
            })
          }
        }
        const rejectedApprovalNoSideEffect = !existsSync(join(wsWrite, 'rejected-by-user.txt'))

        // 4. Cancellation
        const cancelEvents = []
        let cancelledTriggered = false
        for await (const ev of adapter.run({
          runId: 'verify-cancel',
          session: roSession,
          text: 'Write a detailed 500-word essay about the history of Unix pipes, one paragraph per idea.',
        })) {
          cancelEvents.push(ev)
          if (ev.type === 'message.delta' && !cancelledTriggered) {
            cancelledTriggered = true
            await adapter.cancel('verify-cancel')
          }
        }
        const cancellationVerified = cancelEvents.at(-1)?.type === 'run.cancelled'

        // 5. Session continuity (resume)
        const resumed = await adapter.resumeSession(roSession.externalId, {
          agentId: 'verify-ro',
          accountId: 'codex-sub',
          modelId,
          effort,
          permission: 'read-only',
          workspace: wsReadOnly,
          instructions: 'Be concise.',
        })
        let resumeText = ''
        for await (const ev of adapter.run({
          runId: 'verify-resume',
          session: resumed,
          text: 'What was the exact text in fixture.txt that you read earlier?',
        })) {
          if (ev.type === 'message.delta') resumeText += ev.text
        }

        const summary = {
          accountType: account.accountType,
          planType: account.planType,
          modelCount: models.length,
          testedModel: modelId,
          usageObserved: usage !== null,
          usageWindows: usage?.windows ?? null,
          roStreamed,
          roReadMatched: roText.includes('GHOST_BOT_FIXTURE_42'),
          readOnlyDeniedWriteClean,
          workspaceWriteSucceeded,
          outsideWriteBlocked,
          symlinkWriteBlocked,
          sawApprovalRequest,
          rejectedApprovalNoSideEffect,
          cancellationVerified,
          sessionContinuityVerified: resumeText.includes('GHOST_BOT_FIXTURE_42'),
        }
        console.log(JSON.stringify(summary, null, 2))

        const requiredChecks = [
          summary.accountType === 'chatgpt',
          summary.modelCount > 0,
          summary.usageObserved,
          summary.roStreamed,
          summary.roReadMatched,
          summary.readOnlyDeniedWriteClean,
          summary.workspaceWriteSucceeded,
          summary.outsideWriteBlocked,
          summary.symlinkWriteBlocked,
          summary.sawApprovalRequest,
          summary.rejectedApprovalNoSideEffect,
          summary.cancellationVerified,
          summary.sessionContinuityVerified,
        ]
        if (requiredChecks.some((ok) => !ok)) {
          console.error('One or more mandatory live Codex verification checks failed.')
          process.exitCode = 1
        }
      } finally {
        await rm(wsReadOnly, { recursive: true, force: true })
        await rm(wsWrite, { recursive: true, force: true })
        await rm(wsOutside, { recursive: true, force: true })
      }
    }
  }
} finally {
  await adapter.close()
}
