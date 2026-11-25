import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CodexAppServerAdapter,
  mapPermissionToCodex,
  normalizeCodexRateLimits,
} from '../packages/runtime-adapters/codex/codex-app-server.ts'
import type { RuntimePermissionEvidence } from '../packages/shared-types/permissions.ts'
import type { AgentEvent } from '../packages/shared-types/runtime.ts'

const mockServerScript = `
const rl = require('node:readline').createInterface({ input: process.stdin });
let turnCounter = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'codex-mock/0.172.0' } }) + '\\n');
  } else if (msg.method === 'account/read') {
    if (process.env.MOCK_AUTH_MODE === 'apikey') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } }) + '\\n');
    } else if (process.env.MOCK_AUTH_MODE === 'signedout') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { account: null, requiresOpenaiAuth: true } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { account: { type: 'chatgpt', email: 'user@example.invalid', planType: 'plus', workspaceName: null }, requiresOpenaiAuth: true } }) + '\\n');
    }
  } else if (msg.method === 'model/list') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: {
        data: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }],
        nextCursor: null
      }
    }) + '\\n');
  } else if (msg.method === 'account/rateLimits/read') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { rateLimits: { primary: null, secondary: null } }
    }) + '\\n');
  } else if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 'thr-1' } } }) + '\\n');
  } else if (msg.method === 'turn/start') {
    turnCounter++;
    const turnId = 'turn-' + turnCounter;
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId } } }) + '\\n');
    if (msg.params.input[0].text === 'need-approval') {
      process.stdout.write(JSON.stringify({
        id: 'srv-app-1',
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'item-1', startedAtMs: 1, threadId: 'thr-1', turnId, command: 'touch forbidden.txt' }
      }) + '\\n');
    } else if (msg.params.input[0].text === 'slow-cancel') {
      process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', turnId, itemId: 'i1', delta: 'part1' } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', turnId, itemId: 'i1', delta: 'hello' } }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: turnId, status: 'completed' } } }) + '\\n');
    }
  } else if (msg.id === 'srv-app-1') {
    const text = msg.result.decision === 'accept' ? 'approved' : 'denied';
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', turnId: 'turn-' + turnCounter, itemId: 'i1', delta: text } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-' + turnCounter, status: 'completed' } } }) + '\\n');
  } else if (msg.method === 'turn/interrupt') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: msg.params.turnId, status: 'interrupted' } } }) + '\\n');
  }
});
`

const verifiedEvidence: RuntimePermissionEvidence = {
  sandboxEnforced: true,
  approvalEnforced: true,
  sensitiveActionsEnforced: true,
  verifiedModes: ['read-only', 'ask-approval', 'workspace'],
}

test('normalizes unknown Codex quota windows as null instead of inventing values', () => {
  const snapshot = normalizeCodexRateLimits(
    { rateLimits: { primary: null, secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null } } },
    '2026-11-25T00:00:00.000Z',
  )
  assert.deepEqual(snapshot, {
    source: 'provider',
    observedAt: '2026-11-25T00:00:00.000Z',
    windows: [
      { label: 'primary', usedPercent: null, resetAt: null },
      { label: '300m', usedPercent: 12, resetAt: null },
    ],
  })
  assert.equal(normalizeCodexRateLimits({}), null)
})

test('maps permission modes to Codex sandbox and approval policies', () => {
  assert.deepEqual(mapPermissionToCodex('read-only'), { sandbox: 'read-only', approvalPolicy: 'on-request' })
  assert.deepEqual(mapPermissionToCodex('ask-approval'), { sandbox: 'workspace-write', approvalPolicy: 'untrusted' })
  assert.deepEqual(mapPermissionToCodex('workspace'), { sandbox: 'workspace-write', approvalPolicy: 'on-request' })
})

test('rejects unsupported permission modes and unverified full-access fail-closed', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'ghost-bot-test-prof-'))
  const adapter = new CodexAppServerAdapter({
    profileDir,
    command: process.execPath,
    args: ['-e', mockServerScript],
    permissionEvidence: verifiedEvidence,
    fullAccessOptIn: false,
  })
  try {
    await assert.rejects(() =>
      adapter.createSession({
        agentId: 'a1',
        accountId: 'acc1',
        modelId: 'gpt-5-codex',
        permission: 'full-access',
        workspace: profileDir,
        instructions: '',
      }),
    )
  } finally {
    await adapter.close()
    await rm(profileDir, { recursive: true, force: true })
  }
})

test('handles streaming, rejected approvals, argsHash mismatch, and cancellation', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'ghost-bot-test-prof-'))
  const adapter = new CodexAppServerAdapter({
    profileDir,
    command: process.execPath,
    args: ['-e', mockServerScript],
    permissionEvidence: verifiedEvidence,
  })
  try {
    const auth = await adapter.getAuthStatus()
    assert.equal(auth.status, 'connected')
    const usage = await adapter.getUsage()
    assert.equal(usage?.windows[0]?.usedPercent, null)

    const session = await adapter.createSession({
      agentId: 'a1',
      accountId: 'acc1',
      modelId: 'gpt-5-codex',
      permission: 'ask-approval',
      workspace: profileDir,
      instructions: '',
    })

    // 1. Streaming + rejected approval + argsHash guard
    const approvalEvents: AgentEvent[] = []
    for await (const ev of adapter.run({ runId: 'run-1', session, text: 'need-approval' })) {
      approvalEvents.push(ev)
      if (ev.type === 'approval.requested') {
        await assert.rejects(() =>
          adapter.resolveApproval({
            approvalId: ev.approvalId,
            runId: ev.runId,
            argsHash: 'tampered-hash',
            decision: 'allow-once',
          }),
        )
        await adapter.resolveApproval({
          approvalId: ev.approvalId,
          runId: ev.runId,
          argsHash: ev.argsHash,
          decision: 'deny',
        })
      }
    }
    assert.ok(approvalEvents.some((e) => e.type === 'message.delta' && e.text === 'denied'))
    assert.equal(approvalEvents.at(-1)?.type, 'run.completed')

    // 2. Cancellation
    const cancelEvents: AgentEvent[] = []
    for await (const ev of adapter.run({ runId: 'run-2', session, text: 'slow-cancel' })) {
      cancelEvents.push(ev)
      if (ev.type === 'message.delta') {
        await adapter.cancel('run-2')
      }
    }
    assert.equal(cancelEvents.at(-1)?.type, 'run.cancelled')
  } finally {
    await adapter.close()
    await rm(profileDir, { recursive: true, force: true })
  }
})

test('blocks silent API key fallback in subscription-first auth status', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'ghost-bot-test-prof-'))
  const prev = process.env.MOCK_AUTH_MODE
  process.env.MOCK_AUTH_MODE = 'apikey'
  const adapter = new CodexAppServerAdapter({
    profileDir,
    command: process.execPath,
    args: ['-e', mockServerScript],
  })
  try {
    // Note: adapter strips env except allowlisted vars, so test via inline env or wrapper
    // Here we pass a wrapper script that sets MOCK_AUTH_MODE=apikey.
    await adapter.close()
    const apiAdapter = new CodexAppServerAdapter({
      profileDir,
      command: process.execPath,
      args: ['-e', `process.env.MOCK_AUTH_MODE='apikey';\n${mockServerScript}`],
    })
    const auth = await apiAdapter.getAuthStatus()
    assert.equal(auth.status, 'error')
    assert.match(auth.detail ?? '', /API key account/i)
    await apiAdapter.close()
  } finally {
    if (prev === undefined) delete process.env.MOCK_AUTH_MODE
    else process.env.MOCK_AUTH_MODE = prev
    await rm(profileDir, { recursive: true, force: true })
  }
})
