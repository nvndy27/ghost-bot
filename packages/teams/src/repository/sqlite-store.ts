import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TeamError } from '../security/validation.ts'

export interface TeamDatabaseHandle {
  sqlite: DatabaseSync
  dbPath: string
  transaction<T>(fn: () => T): T
  close(): void
}

function chmodIfExists(path: string, mode: number): void {
  if (existsSync(path)) {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new TeamError('INVALID_STORAGE', `Storage artifact "${path}" must not be a symlink`)
    }
    chmodSync(path, mode)
  }
}

export function openTeamDatabase(dataDir: string, fileName = 'teams.sqlite'): TeamDatabaseHandle {
  const resolvedDir = resolve(dataDir)
  if (existsSync(resolvedDir)) {
    const st = lstatSync(resolvedDir)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new TeamError('INVALID_STORAGE', 'Teams data directory must not be a symlink')
    }
  } else {
    mkdirSync(resolvedDir, { recursive: true, mode: 0o700 })
  }
  chmodSync(resolvedDir, 0o700)

  const dbPath = join(resolvedDir, fileName)
  chmodIfExists(dbPath, 0o600)

  const sqlite = new DatabaseSync(dbPath)
  chmodSync(dbPath, 0o600)

  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `)

  chmodIfExists(`${dbPath}-wal`, 0o600)
  chmodIfExists(`${dbPath}-shm`, 0o600)

  let txDepth = 0
  function transaction<T>(fn: () => T): T {
    if (txDepth > 0) {
      txDepth += 1
      try {
        return fn()
      } finally {
        txDepth -= 1
      }
    }
    sqlite.exec('BEGIN IMMEDIATE')
    txDepth = 1
    try {
      const result = fn()
      sqlite.exec('COMMIT')
      return result
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {
        // ignore rollback error
      }
      throw err
    } finally {
      txDepth = 0
    }
  }

  transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS team_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        lead_bot_id TEXT NOT NULL,
        member_bot_ids_json TEXT NOT NULL,
        memory_sharing_policy TEXT NOT NULL DEFAULT 'explicit-only',
        bounds_json TEXT NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id, archived_at);

      CREATE TABLE IF NOT EXISTS team_tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        root_task_id TEXT NOT NULL,
        parent_task_id TEXT,
        depth INTEGER NOT NULL,
        assigned_bot_id TEXT NOT NULL,
        delegated_by_bot_id TEXT,
        idempotency_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        token_budget INTEGER NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        duration_budget_ms INTEGER NOT NULL,
        duration_used_ms INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_team_tasks_root ON team_tasks(root_task_id, depth, status);
      CREATE INDEX IF NOT EXISTS idx_team_tasks_queue ON team_tasks(team_id, status, created_at);

      CREATE TABLE IF NOT EXISTS team_messages (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        author_bot_id TEXT NOT NULL,
        target_bot_id TEXT,
        originating_task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(team_id, seq)
      );
    `)

    const applied = sqlite
      .prepare(`SELECT version FROM team_schema_migrations WHERE version = 1`)
      .get()
    if (!applied) {
      sqlite
        .prepare(
          `INSERT INTO team_schema_migrations (version, name, applied_at) VALUES (1, '0001_teams_foundation', ?)`,
        )
        .run(new Date().toISOString())
    }
  })

  return {
    sqlite,
    dbPath,
    transaction,
    close() {
      chmodIfExists(dbPath, 0o600)
      chmodIfExists(`${dbPath}-wal`, 0o600)
      chmodIfExists(`${dbPath}-shm`, 0o600)
      sqlite.close()
    },
  }
}
