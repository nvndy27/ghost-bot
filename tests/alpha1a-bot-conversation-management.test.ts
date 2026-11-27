import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'
import { orderSidebarItems } from '../apps/desktop/src/state/sidebarOrder.ts'
import {
  SessionRecordSchema,
  SidebarOrganizationSchema,
} from '../packages/shared-types/ipc.ts'
import { formatProviderLabel } from '../packages/shared-types/runtime.ts'

function requestJson(
  socketPath: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

test('formatProviderLabel maps canonical runtimes without model or effort', () => {
  assert.equal(formatProviderLabel('codex'), 'Codex')
  assert.equal(formatProviderLabel('claude-api'), 'Claude')
  assert.equal(formatProviderLabel('gemini-api'), 'Gemini')
  assert.equal(formatProviderLabel('ollama'), 'Ollama')
  assert.equal(formatProviderLabel('openclaw'), 'OpenClaw')
  assert.equal(formatProviderLabel('kimi-acp'), 'Kimi')
  assert.equal(formatProviderLabel('lmstudio'), 'LM Studio')
  assert.equal(formatProviderLabel('llamacpp'), 'llama.cpp')
  assert.equal(formatProviderLabel('openrouter'), 'OpenRouter')
  assert.equal(formatProviderLabel('mock-offline'), 'Mock')
  assert.equal(formatProviderLabel(undefined), 'Mock')
})

test('orderSidebarItems places pinned items first, preserves custom order, and deduplicates', () => {
  const items = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
    { id: 'c', name: 'Gamma' },
    { id: 'd', name: 'Delta' },
  ]
  const ordered = orderSidebarItems(items, ['c', 'c'], ['d', 'b', 'a', 'b'])
  assert.deepEqual(
    ordered.map((x) => x.id),
    ['c', 'd', 'b', 'a'],
  )
})

test('Alpha.1A sidebar organization and unread state persist across daemon restarts and prune deleted entities', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-alpha1a-test-'))
  const authToken = 'alpha1a-test-token-1234567890'
  const socketPath = join(dataDir, 'daemon.sock')
  const daemon1 = new GhostBotDaemon({
    dataDir,
    socketPath,
    authToken,
    runtimeMode: 'mock',
  })

  let daemon2: GhostBotDaemon | null = null
  try {
    await daemon1.start()

    // Migrations 0001-0013 remain frozen
    const dbCheck = await openGhostBotDatabase(dataDir)
    try {
      const migRow = dbCheck.sqlite
        .prepare('SELECT COUNT(*) AS cnt, MAX(version) AS maxVer FROM schema_migrations')
        .get() as { cnt: number; maxVer: number }
      assert.equal(migRow.cnt, 13)
      assert.equal(migRow.maxVer, 13)
    } finally {
      dbCheck.close()
    }

    // Create a custom bot and a team
    const createdBotRes = await requestJson(socketPath, 'POST', '/bots', authToken, {
      name: 'Temp Bot',
      description: 'Test bot',
      instructions: 'Stay helpful',
      avatar: { kind: 'preset', shape: 'ghost', color: '#292929', eyes: 'classic', rotation: 0, animation: true },
      runtimeId: 'mock-offline',
      modelId: 'gpt-6.2-mock',
      effort: 'medium',
      workspacePath: dataDir,
      permission: 'read-only',
    })
    assert.equal(createdBotRes.status, 201)
    const tempBotId = String(createdBotRes.body.id)

    const createdTeamRes = await requestJson(socketPath, 'POST', '/teams', authToken, {
      name: 'Alpha Team',
      leadBotId: 'chief',
      memberBotIds: ['chief', 'developer'],
    })
    assert.equal(createdTeamRes.status, 201)
    const teamId = String(createdTeamRes.body.id)

    // Pin & order with duplicates and invalid IDs -> daemon deduplicates & prunes invalid IDs
    const putOrgRes = await requestJson(socketPath, 'PUT', '/sidebar/organization', authToken, {
      pinnedBotIds: [tempBotId, 'non-existent-bot', tempBotId, 'researcher'],
      botOrder: ['developer', tempBotId, 'chief', 'non-existent-bot'],
      pinnedTeamIds: [teamId, 'missing-team', teamId],
      teamOrder: [teamId],
    })
    assert.equal(putOrgRes.status, 200)
    const org = SidebarOrganizationSchema.parse(putOrgRes.body)
    assert.deepEqual(org.pinnedBotIds, [tempBotId, 'researcher'])
    assert.deepEqual(org.botOrder, ['developer', tempBotId, 'chief'])
    assert.deepEqual(org.pinnedTeamIds, [teamId])
    assert.deepEqual(org.teamOrder, [teamId])

    // Create two sessions for chief and start a mock run in session 1
    const sess1Res = await requestJson(socketPath, 'POST', '/sessions', authToken, {
      agentId: 'chief',
      title: 'Thread One',
    })
    assert.equal(sess1Res.status, 201)
    const sess1 = SessionRecordSchema.parse(sess1Res.body)
    assert.equal(sess1.unread, false)

    const runRes = await requestJson(socketPath, 'POST', '/runs', authToken, {
      sessionId: sess1.id,
      text: 'Hello Alpha.1A',
      idempotencyKey: 'alpha1a-run-1',
    })
    assert.equal(runRes.status, 201)
    const runId = String((runRes.body.run as Record<string, unknown>).id)

    // Wait for mock run to complete
    let completed = false
    for (let i = 0; i < 40; i++) {
      const getRun = await requestJson(socketPath, 'GET', `/runs/${runId}`, authToken)
      if (getRun.body.status === 'completed') {
        completed = true
        break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(completed, true)

    // Session 1 should now report unread: true and lastCompletedRunStatus: 'completed'
    const sessList1 = await requestJson(socketPath, 'GET', '/sessions?agentId=chief', authToken)
    const found1 = (sessList1.body.sessions as Array<Record<string, unknown>>).find(
      (s) => s.id === sess1.id,
    )
    assert.ok(found1)
    assert.equal(found1.unread, true)
    assert.equal(found1.lastCompletedRunStatus, 'completed')

    // Restart daemon and verify both sidebar organization and unread state persist
    await daemon1.stop()

    daemon2 = new GhostBotDaemon({
      dataDir,
      socketPath,
      authToken,
      runtimeMode: 'mock',
    })
    await daemon2.start()
    {
      const orgAfterRestart = await requestJson(socketPath, 'GET', '/sidebar/organization', authToken)
      assert.deepEqual(SidebarOrganizationSchema.parse(orgAfterRestart.body), org)

      const sessAfterRestart = await requestJson(socketPath, 'GET', '/sessions?agentId=chief', authToken)
      const foundAfterRestart = (sessAfterRestart.body.sessions as Array<Record<string, unknown>>).find(
        (s) => s.id === sess1.id,
      )
      assert.ok(foundAfterRestart)
      assert.equal(foundAfterRestart.unread, true)
      assert.equal(foundAfterRestart.lastCompletedRunStatus, 'completed')

      // Mark session read -> unread becomes false
      const readRes = await requestJson(socketPath, 'POST', `/sessions/${sess1.id}/read`, authToken)
      assert.equal(readRes.status, 200)

      const sessAfterRead = await requestJson(socketPath, 'GET', '/sessions?agentId=chief', authToken)
      const foundAfterRead = (sessAfterRead.body.sessions as Array<Record<string, unknown>>).find(
        (s) => s.id === sess1.id,
      )
      assert.equal(foundAfterRead?.unread, false)

      // Delete temp bot and archive team -> organization prunes both
      const delBot = await requestJson(socketPath, 'DELETE', `/bots/${tempBotId}`, authToken)
      assert.equal(delBot.status, 200)
      const archTeam = await requestJson(socketPath, 'POST', `/teams/${teamId}/archive`, authToken)
      assert.equal(archTeam.status, 200)

      const orgAfterPrune = await requestJson(socketPath, 'GET', '/sidebar/organization', authToken)
      const pruned = SidebarOrganizationSchema.parse(orgAfterPrune.body)
      assert.deepEqual(pruned.pinnedBotIds, ['researcher'])
      assert.deepEqual(pruned.botOrder, ['developer', 'chief'])
      assert.deepEqual(pruned.pinnedTeamIds, [])
      assert.deepEqual(pruned.teamOrder, [])
    }
  } finally {
    await daemon2?.stop().catch(() => {})
    await daemon1.stop().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  }
})
