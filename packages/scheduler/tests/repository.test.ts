import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExecutionQueue } from '../src/queue/execution-queue.ts'
import { RoutineRepository } from '../src/repository/routine-repository.ts'
import { openSchedulerDatabase } from '../src/repository/sqlite-store.ts'

test('repository: CRUD, SQLite persistence across reopen, rollback, scope isolation, and corrupt record check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-sched-repo-'))
  const scope = { ownerId: 'user-1', botId: 'chief' }
  const otherScope = { ownerId: 'user-2', botId: 'chief' }

  try {
    const db1 = openSchedulerDatabase(dir)
    const repo1 = new RoutineRepository(db1)

    const dirMode = (await stat(dir)).mode & 0o777
    const dbMode = (await stat(db1.dbPath)).mode & 0o777
    assert.equal(dirMode, 0o700)
    assert.equal(dbMode, 0o600)

    const created = repo1.create(
      {
        name: 'Morning Brief',
        description: 'Daily summary',
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'daily', hour: 9, minute: 0 },
        task: { prompt: 'Summarize inbox', idempotent: true },
      },
      Date.parse('2026-01-01T00:00:00.000Z'),
    )
    assert.equal(created.enabled, true)
    assert.equal(created.nextRunAt, '2026-01-01T09:00:00.000Z')

    // Scope isolation
    assert.throws(() => repo1.getById(created.id, otherScope), { code: 'SCOPE_FORBIDDEN' })
    assert.throws(() => repo1.disable(created.id, otherScope), { code: 'SCOPE_FORBIDDEN' })

    // Transaction rollback
    assert.throws(() => {
      db1.transaction(() => {
        db1.sqlite
          .prepare(`UPDATE scheduler_routines SET enabled = 0 WHERE id = ?`)
          .run(created.id)
        throw new Error('force rollback')
      })
    }, /force rollback/)
    assert.equal(repo1.getById(created.id, scope).enabled, true)

    // Update, disable, enable, archive, list pagination
    const updated = repo1.update(created.id, scope, { name: 'Morning Brief v2' })
    assert.equal(updated.name, 'Morning Brief v2')
    assert.equal(repo1.disable(created.id, scope).enabled, false)
    assert.equal(repo1.enable(created.id, scope).enabled, true)

    const queue1 = new ExecutionQueue(db1)
    const occ1 = queue1.enqueueOccurrence(updated, '2026-01-01T09:00:00.000Z')
    const occ2 = queue1.enqueueOccurrence(updated, '2026-01-01T09:00:00.000Z')
    assert.equal(occ1.created, true)
    assert.equal(occ2.created, false)
    assert.equal(occ1.task.id, occ2.task.id)

    db1.close()

    // Reopen and verify persistence
    const db2 = openSchedulerDatabase(dir)
    const repo2 = new RoutineRepository(db2)
    const listed = repo2.list(scope, { limit: 10, offset: 0 })
    assert.equal(listed.total, 1)
    assert.equal(listed.routines[0]?.name, 'Morning Brief v2')
    assert.equal(repo2.listExecutionHistory(created.id, scope).length, 1)

    // Corrupt stored record detection
    db2.sqlite
      .prepare(`UPDATE scheduler_routines SET trigger_json = '{bad-json' WHERE id = ?`)
      .run(created.id)
    assert.throws(() => repo2.getById(created.id, scope), { code: 'CORRUPT_RECORD' })

    db2.sqlite
      .prepare(`UPDATE scheduler_routines SET trigger_json = ? WHERE id = ?`)
      .run(JSON.stringify({ kind: 'daily', hour: 9, minute: 0 }), created.id)
    repo2.archive(created.id, scope)
    assert.equal(repo2.list(scope, { includeArchived: false }).total, 0)
    assert.equal(repo2.list(scope, { includeArchived: true }).total, 1)
    repo2.delete(created.id, scope)
    assert.equal(repo2.list(scope, { includeArchived: true }).total, 0)
    db2.close()

    // Symlink dir rejection
    const symDir = join(dir, 'sym-data')
    await symlink(dir, symDir)
    assert.throws(() => openSchedulerDatabase(symDir), /must not be a symlink/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
