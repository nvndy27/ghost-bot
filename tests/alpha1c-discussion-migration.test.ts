import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { MIGRATIONS, runMigrations } from '../apps/daemon/src/db/migrations.ts'

test('0014 preserves an existing version 13 roster and adds idempotent discussion storage', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
    const record = db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)')
    for (const migration of MIGRATIONS.filter((step) => step.version <= 13)) {
      db.exec(migration.sql)
      record.run(migration.version, migration.name, '2026-11-27T00:00:00Z')
    }
    db.exec("INSERT INTO agents (id, name, description, avatar_json, instructions, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at) VALUES ('chief', 'Existing bot', '', '{}', '', 'mock-offline', 'mock-model', 'low', '.', 'read-only', 'now', 'now')")
    db.exec("INSERT INTO teams (id, name, leader_agent_id, lead_bot_id, member_bot_ids_json) VALUES ('existing', 'Legacy group', 'chief', 'chief', '[\"chief\"]')")
    assert.equal(runMigrations(db), 1)
    assert.equal(runMigrations(db), 0)
    assert.equal(db.prepare("SELECT name FROM teams WHERE id = 'existing'").get()?.name, 'Legacy group')
    const insert = db.prepare('INSERT INTO team_discussion_turns (id, team_id, operation_id, prompt, replies_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('turn', 'existing', 'operation', 'Offline fixture', '[]', 'now')
    assert.throws(() => insert.run('another', 'existing', 'operation', 'Duplicate', '[]', 'now'), /UNIQUE/)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})
