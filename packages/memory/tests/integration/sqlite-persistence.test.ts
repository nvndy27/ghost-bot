import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MemoryDuplicateError,
  MemoryStorageCorruptionError,
  MemoryUnsafePathError,
  openMemoryDatabase,
  SqliteMemoryRepository,
  type MemoryAuthContext,
} from '../../src/index.ts'

const AUTH: MemoryAuthContext = {
  actorId: 'user-1',
  userId: 'user-1',
  botId: 'bot-1',
  workspaceId: 'ws-1',
  allowUserWideRead: true,
  allowUserWideWrite: true,
}

test('SQLite persistence: permissions, CRUD, reopen, pagination, rollback, and corruption guards', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ghost-bot-mem-test-'))
  const dataDir = join(rootDir, 'store')
  const dbPath = join(dataDir, 'memory.sqlite')

  try {
    let tick = 0
    const clock = () => new Date(Date.UTC(2026, 10, 25, 12, 0, tick++))

    const handle1 = await openMemoryDatabase(dbPath)
    const repo1 = new SqliteMemoryRepository(handle1, { clock })

    const dirMode = statSync(dataDir).mode & 0o777
    const fileMode = statSync(dbPath).mode & 0o777
    assert.equal(dirMode, 0o700)
    assert.equal(fileMode, 0o600)

    const r1 = repo1.create(AUTH, {
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      category: 'preference',
      content: 'First persistent memory',
      tags: ['alpha', 'Beta'],
    })
    const r2 = repo1.create(AUTH, {
      scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
      category: 'project_context',
      content: 'Second persistent memory',
      tags: ['workspace'],
    })
    const r3 = repo1.create(AUTH, {
      scope: { kind: 'user', userId: 'user-1' },
      category: 'fact',
      content: 'Third user-wide memory',
    })

    // Duplicate throws and does not corrupt DB
    assert.throws(
      () =>
        repo1.create(AUTH, {
          scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
          category: 'preference',
          content: 'first   persistent memory',
        }),
      MemoryDuplicateError,
    )

    // Transaction rollback leaves no partial write
    assert.throws(() => {
      handle1.transaction(() => {
        handle1.sqlite
          .prepare(
            `INSERT INTO memories (
              id, schema_version, scope_kind, user_id, bot_id, workspace_id, scope_key,
              origin, category, content, normalized_content, content_hash,
              tags_json, provenance_json, status, created_at, updated_at, archived_at, expires_at
            ) VALUES ('rollback-id', 1, 'bot', 'user-1', 'bot-1', NULL, 'bot:user-1:bot-1',
              'explicit', 'fact', 'Rollback test', 'rollback test', '0000000000000000000000000000000000000000000000000000000000000000',
              '[]', '{"origin":"explicit","createdBy":"user-1","sourceRefs":[]}', 'active',
              '2026-11-25T12:00:00.000Z', '2026-11-25T12:00:00.000Z', NULL, NULL)`,
          )
          .run()
        throw new Error('simulated mid-transaction failure')
      })
    })
    assert.equal(repo1.getById(AUTH, 'rollback-id'), null)

    repo1.close()

    // Reopen and verify persistence, pagination, update, archive, delete
    const handle2 = await openMemoryDatabase(dbPath)
    const repo2 = new SqliteMemoryRepository(handle2, { clock })

    const page1 = repo2.list(AUTH, { includeUserWide: true, limit: 2, offset: 0 })
    const page2 = repo2.list(AUTH, { includeUserWide: true, limit: 2, offset: 2 })
    assert.equal(page1.total, 3)
    assert.equal(page1.items.length, 2)
    assert.equal(page2.items.length, 1)

    const updated = repo2.update(AUTH, r1.id, { content: 'First persistent memory updated' })
    assert.equal(updated.content, 'First persistent memory updated')

    const searchAfterUpdate = repo2.search(AUTH, { query: 'updated', includeUserWide: true })
    assert.equal(searchAfterUpdate.items.length, 1)
    assert.equal(searchAfterUpdate.items[0]!.record.id, r1.id)

    repo2.archive(AUTH, r2.id)
    assert.equal(repo2.getById(AUTH, r2.id), null)
    assert.equal(repo2.delete(AUTH, r3.id), true)
    assert.equal(repo2.getById(AUTH, r3.id, { includeUserWide: true }), null)

    // Invalid stored JSON row must throw MemoryStorageCorruptionError, never silently discard
    handle2.sqlite
      .prepare('UPDATE memories SET provenance_json = ? WHERE id = ?')
      .run('{broken-json', r1.id)
    assert.throws(() => repo2.getById(AUTH, r1.id), MemoryStorageCorruptionError)

    repo2.close()

    // Symlinked DB path must be rejected
    const symlinkDb = join(dataDir, 'symlink.sqlite')
    symlinkSync(dbPath, symlinkDb)
    await assert.rejects(() => openMemoryDatabase(symlinkDb), MemoryUnsafePathError)

    // Corrupted DB file must fail safely without overwriting
    const corruptDbPath = join(dataDir, 'corrupt.sqlite')
    writeFileSync(corruptDbPath, 'not a valid sqlite file at all', { mode: 0o600 })
    chmodSync(corruptDbPath, 0o600)
    await assert.rejects(() => openMemoryDatabase(corruptDbPath))
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})
