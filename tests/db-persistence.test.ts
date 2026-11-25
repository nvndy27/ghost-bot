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

test('BotRepository supports CRUD, duplicate, transaction rollback, workspace validation, and corrupt config recovery', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-repo-'))
  try {
    const handle = await openGhostBotDatabase(dataDir)
    const repo = new BotRepository(handle)

    const created = await repo.createBot({
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
      workspacePath: dataDir,
      permission: 'read-only',
    })
    assert.equal(created.name, 'Audit Bot')

    const updated = await repo.updateBot({
      id: created.id,
      patch: { name: 'Audit Bot v2', permission: 'workspace' },
    })
    assert.equal(updated.name, 'Audit Bot v2')
    assert.equal(updated.permission, 'workspace')

    const dup = await repo.duplicateBot(created.id)
    assert.equal(dup.name, 'Audit Bot v2 (Copy)')

    // Workspace path validation rejects traversal, relative paths, and missing directories
    for (const badWs of ['../escape', 'relative/path', '/nonexistent-ghost-bot-ws-99999', '/tmp\0bad']) {
      await assert.rejects(
        () =>
          repo.createBot({
            name: 'BadWS',
            description: '',
            instructions: '',
            avatar: { kind: 'preset', shape: 'ghost', color: '#292929', eyes: 'classic', rotation: 0, animation: true },
            runtimeId: 'mock-offline',
            modelId: 'gpt-6.2-mock',
            effort: 'low',
            workspacePath: badWs,
            permission: 'read-only',
          }),
        { code: 'INVALID_WORKSPACE' },
      )
    }

    // Deleting a bot with a session preserves conversation history (soft-archive + ON DELETE RESTRICT)
    const now = new Date().toISOString()
    handle.sqlite
      .prepare(
        `INSERT INTO sessions (id, agent_id, account_id, runtime_id, external_session_id, title, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run('sess-1', created.id, 'acc-1', 'mock-offline', 'Test session', now)
    handle.sqlite
      .prepare(
        `INSERT INTO messages (id, session_id, role, content_json, created_at, run_id)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run('msg-1', 'sess-1', 'user', JSON.stringify({ text: 'hello' }), now)

    assert.throws(() => handle.sqlite.prepare('DELETE FROM agents WHERE id = ?').run(created.id))
    repo.deleteBot(created.id)
    assert.equal(repo.getBot(created.id), null)
    const preservedMsg = handle.sqlite.prepare('SELECT id FROM messages WHERE id = ?').get('msg-1') as
      | { id: string }
      | undefined
    assert.equal(preservedMsg?.id, 'msg-1')

    // Unsupported future schema version fails explicitly without modifying DB
    handle.sqlite
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(999, '999_future', now)
    assert.throws(() => runMigrations(handle.sqlite), /Unsupported database schema version 999/)

    // Transaction rollback leaves state intact on error.
    assert.throws(() =>
      handle.transaction(() => {
        handle.sqlite
          .prepare('UPDATE agents SET name = ? WHERE id = ?')
          .run('ShouldRollback', dup.id)
        throw new Error('simulated failure')
      }),
    )
    assert.equal(repo.getBot(dup.id)?.name, 'Audit Bot v2 (Copy)')

    // Corrupt stored JSON recovers gracefully without crashing listBots.
    handle.sqlite
      .prepare('UPDATE agents SET avatar_json = ?, permission_mode = ? WHERE id = ?')
      .run('{broken-json', 'full-access', dup.id)
    const recovered = repo.getBot(dup.id)
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

test('upgrades legacy b33f975 database with ON DELETE CASCADE sessions to ON DELETE RESTRICT without data loss', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdir } = await import('node:fs/promises')
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-upgrade-'))
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const dbPath = join(dataDir, 'ghost-bot.sqlite')
    const legacy = new DatabaseSync(dbPath)
    const now = new Date().toISOString()
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, '0001_initial_schema', '${now}');
      CREATE TABLE provider_accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, auth_kind TEXT NOT NULL, credential_ref TEXT NOT NULL, status TEXT NOT NULL, capabilities_json TEXT NOT NULL, checked_at TEXT NOT NULL);
      CREATE TABLE model_profiles (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, runtime_id TEXT NOT NULL, model_id TEXT NOT NULL, effort TEXT NOT NULL, options_json TEXT NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, avatar_json TEXT NOT NULL, runtime_id TEXT NOT NULL, model_profile_id TEXT, model_id TEXT NOT NULL, effort TEXT NOT NULL, workspace_path TEXT NOT NULL, permission_mode TEXT NOT NULL, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, leader_agent_id TEXT);
      CREATE TABLE team_members (team_id TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (team_id, agent_id));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, account_id TEXT NOT NULL, runtime_id TEXT NOT NULL, external_session_id TEXT, title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE usage_records (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL, value_json TEXT NOT NULL, source TEXT NOT NULL, observed_at TEXT NOT NULL, reset_at TEXT);
      CREATE TABLE audit_logs (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL, redacted_json TEXT NOT NULL, timestamp TEXT NOT NULL);
      INSERT INTO agents VALUES ('a1', 'Legacy Bot', '', '', '{}', 'mock-offline', NULL, 'gpt-6.2-mock', 'medium', '~', 'read-only', NULL, '${now}', '${now}');
      INSERT INTO sessions VALUES ('s1', 'a1', 'acc1', 'mock-offline', NULL, 'Legacy chat', '${now}');
      INSERT INTO messages VALUES ('m1', 's1', 'user', '{"text":"keep me"}', '${now}', NULL);
    `)
    legacy.close()

    const upgraded = await openGhostBotDatabase(dataDir)
    const versions = upgraded.sqlite
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number }>
    assert.deepEqual(versions.map((v) => v.version), [1, 2])

    const schemaRow = upgraded.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
      .get() as { sql: string }
    assert.match(schemaRow.sql, /ON DELETE RESTRICT/i)

    assert.throws(() => upgraded.sqlite.prepare('DELETE FROM agents WHERE id = ?').run('a1'))
    const repo = new BotRepository(upgraded)
    repo.deleteBot('a1')
    const msg = upgraded.sqlite.prepare('SELECT id FROM messages WHERE id = ?').get('m1') as { id: string } | undefined
    assert.equal(msg?.id, 'm1')
    upgraded.close()

    // Re-opening after upgrade is idempotent
    const reopened = await openGhostBotDatabase(dataDir)
    assert.equal(runMigrations(reopened.sqlite), 0)
    reopened.close()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('rejects symlinked data directory and symlinked database file', async () => {
  const { mkdir, symlink, writeFile } = await import('node:fs/promises')
  const base = await mkdtemp(join(tmpdir(), 'ghost-bot-symlink-db-'))
  try {
    const realDir = join(base, 'real-dir')
    const linkDir = join(base, 'link-dir')
    await mkdir(realDir, { recursive: true })
    await symlink(realDir, linkDir)

    await assert.rejects(() => openGhostBotDatabase(linkDir), { code: 'UNSAFE_DATA_DIR' })

    const safeDir = join(base, 'safe-dir')
    await mkdir(safeDir, { recursive: true, mode: 0o700 })
    const targetFile = join(base, 'outside.txt')
    await writeFile(targetFile, 'untouched', { mode: 0o644 })
    await symlink(targetFile, join(safeDir, 'ghost-bot.sqlite'))

    await assert.rejects(() => openGhostBotDatabase(safeDir), { code: 'UNSAFE_DB_FILE' })
    const targetStat = await stat(targetFile)
    assert.equal(targetStat.mode & 0o777, 0o644)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
