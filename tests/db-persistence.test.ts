import { strict as assert } from 'node:assert'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BotRepository } from '../apps/daemon/src/bots/repository.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { runMigrations } from '../apps/daemon/src/db/migrations.ts'
import { seedInitialBotsIfNeeded } from '../apps/daemon/src/db/seed.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'

function requestDaemon(
  socketPath: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload !== undefined
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload, 'utf8'),
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
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

test('SQLite database initializes with 0700/0600 permissions, foreign keys, idempotent migrations, and single-time seeding', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-db-'))
  try {
    const h1 = await openGhostBotDatabase(dataDir)
    const dirStat = await stat(dataDir)
    assert.equal(dirStat.mode & 0o777, 0o700)
    const dbStat = await stat(h1.dbPath)
    assert.equal(dbStat.mode & 0o777, 0o600)

    const fk = h1.sqlite.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    assert.equal(fk.foreign_keys, 1)

    // Re-running migrations is idempotent (0 new migrations applied).
    assert.equal(runMigrations(h1.sqlite), 0)

    // First-launch seeding inserts 5 bots once.
    assert.equal(seedInitialBotsIfNeeded(h1), true)
    assert.equal(seedInitialBotsIfNeeded(h1), false)

    const repo1 = new BotRepository(h1)
    assert.equal(repo1.listBots().bots.length, 5)

    // Delete a seeded bot and restart: deleted bot must NOT be recreated.
    repo1.deleteBot('daily-assistant')
    h1.close()

    const h2 = await openGhostBotDatabase(dataDir)
    assert.equal(seedInitialBotsIfNeeded(h2), false)
    const repo2 = new BotRepository(h2)
    assert.equal(repo2.listBots().bots.length, 4)
    assert.equal(repo2.getBot('daily-assistant'), null)
    h2.close()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('BotRepository supports CRUD, duplicate, transaction rollback, and corrupt config recovery', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-repo-'))
  try {
    const handle = await openGhostBotDatabase(dataDir)
    const repo = new BotRepository(handle)

    const created = repo.createBot({
      name: 'Audit Bot',
      description: 'Checks diffs',
      instructions: 'Be strict.',
      avatar: {
        kind: 'preset',
        shape: 'security',
        color: '#536B85',
        eyes: 'classic',
        rotation: 5,
        animation: true,
      },
      runtimeId: 'mock-offline',
      modelId: 'gpt-6.2-mock',
      effort: 'high',
      workspacePath: '~/Projects/ghost-bot',
      permission: 'read-only',
    })
    assert.equal(created.name, 'Audit Bot')

    const updated = repo.updateBot({
      id: created.id,
      patch: { name: 'Audit Bot v2', permission: 'workspace' },
    })
    assert.equal(updated.name, 'Audit Bot v2')
    assert.equal(updated.permission, 'workspace')

    const dup = repo.duplicateBot(created.id)
    assert.equal(dup.name, 'Audit Bot v2 (Copy)')

    // Transaction rollback leaves state intact on error.
    assert.throws(() =>
      handle.transaction(() => {
        handle.sqlite
          .prepare('UPDATE agents SET name = ? WHERE id = ?')
          .run('ShouldRollback', created.id)
        throw new Error('simulated failure')
      }),
    )
    assert.equal(repo.getBot(created.id)?.name, 'Audit Bot v2')

    // Corrupt stored JSON recovers gracefully without crashing listBots.
    handle.sqlite
      .prepare('UPDATE agents SET avatar_json = ?, permission_mode = ? WHERE id = ?')
      .run('{broken-json', 'full-access', created.id)
    const recovered = repo.getBot(created.id)
    assert.equal(recovered?.permission, 'ask-approval')
    assert.equal(recovered?.avatar.kind, 'preset')

    handle.close()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('daemon persists bots across restart and rejects malicious SVG or full-access permission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-bot-daemon-crud-'))
  const dataDir = join(dir, 'data')
  const socketPath = join(dir, 'daemon.sock')
  const token = '0123456789abcdef0123456789abcdef'

  const d1 = new GhostBotDaemon({ authToken: token, socketPath, dataDir, runtimeMode: 'mock' })
  await d1.start()
  let createdId = ''
  try {
    // Reject unsupported full-access permission
    const badPerm = await requestDaemon(socketPath, 'POST', '/bots', token, {
      name: 'Bad',
      avatar: { kind: 'preset', shape: 'ghost', color: '#292929', eyes: 'classic', rotation: 0, animation: true },
      permission: 'full-access',
    })
    assert.equal(badPerm.status, 400)

    // Reject malicious SVG
    const badSvg = await requestDaemon(socketPath, 'POST', '/avatars/import-svg', token, {
      rawSvg: '<svg><script>alert(1)</script></svg>',
    })
    assert.equal(badSvg.status, 400)

    // Create valid bot
    const res = await requestDaemon(socketPath, 'POST', '/bots', token, {
      name: 'Persisted Bot',
      avatar: { kind: 'preset', shape: 'analyst', color: '#49ABAD', eyes: 'round', rotation: -5, animation: true },
      permission: 'read-only',
    })
    assert.equal(res.status, 201)
    createdId = (res.body as { id: string }).id
  } finally {
    await d1.stop()
  }

  // Restart daemon against same dataDir and verify persistence
  const d2 = new GhostBotDaemon({ authToken: token, socketPath, dataDir, runtimeMode: 'mock' })
  await d2.start()
  try {
    const listed = await requestDaemon(socketPath, 'GET', '/bots', token)
    assert.equal(listed.status, 200)
    const bots = (listed.body as { bots: Array<{ id: string; name: string }> }).bots
    assert.ok(bots.some((b) => b.id === createdId && b.name === 'Persisted Bot'))

    const del = await requestDaemon(socketPath, 'DELETE', `/bots/${createdId}`, token)
    assert.equal(del.status, 200)
  } finally {
    await d2.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
