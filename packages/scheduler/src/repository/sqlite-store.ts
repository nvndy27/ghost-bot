import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SchedulerError } from '../security/validation.ts'

export interface SchedulerDatabaseHandle {
  sqlite: DatabaseSync
  dbPath: string
  transaction<T>(fn: () => T): T
  close(): void
}

function chmodIfExists(path: string, mode: number): void {
  if (existsSync(path)) {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new SchedulerError('INVALID_STORAGE', `Storage artifact "${path}" must not be a symlink`)
    }
    chmodSync(path, mode)
  }
}

function getColumnNames(sqlite: DatabaseSync, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

export function openSchedulerDatabase(
  dataDir: string,
  fileName = 'scheduler.sqlite',
): SchedulerDatabaseHandle {
  const resolvedDir = resolve(dataDir)
  if (existsSync(resolvedDir)) {
    const dirStat = lstatSync(resolvedDir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new SchedulerError('INVALID_STORAGE', 'Scheduler data directory must not be a symlink')
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
      CREATE TABLE IF NOT EXISTS scheduler_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `)

    const applied = new Set(
      (
        sqlite.prepare(`SELECT version FROM scheduler_schema_migrations`).all() as Array<{
          version: number
        }>
      ).map((r) => Number(r.version)),
    )

    if (!applied.has(1)) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS scheduler_routines (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          trigger_json TEXT NOT NULL,
          timezone TEXT NOT NULL,
          task_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          archived_at TEXT,
          missed_run_policy TEXT NOT NULL,
          max_catch_up_runs INTEGER NOT NULL,
          concurrency_policy TEXT NOT NULL,
          max_concurrent_runs INTEGER NOT NULL,
          retry_policy_json TEXT NOT NULL,
          expires_at TEXT,
          next_run_at TEXT,
          last_run_at TEXT,
          last_evaluated_at TEXT,
          last_task_status TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_scheduler_routines_scope
          ON scheduler_routines(owner_id, bot_id, archived_at, enabled);

        CREATE TABLE IF NOT EXISTS scheduler_tasks (
          id TEXT PRIMARY KEY,
          routine_id TEXT NOT NULL REFERENCES scheduler_routines(id) ON DELETE CASCADE,
          owner_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          occurrence_key TEXT NOT NULL UNIQUE,
          scheduled_for TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          max_attempts INTEGER NOT NULL,
          claim_owner TEXT,
          claim_lease_expires_at TEXT,
          uncertain_execution INTEGER NOT NULL DEFAULT 0,
          approval_required INTEGER NOT NULL DEFAULT 0,
          task_snapshot_json TEXT NOT NULL,
          error_code TEXT,
          error_message TEXT,
          started_at TEXT,
          ended_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_claim
          ON scheduler_tasks(status, scheduled_for, created_at);

        CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_routine
          ON scheduler_tasks(routine_id, created_at DESC);
      `)
      sqlite
        .prepare(
          `INSERT INTO scheduler_schema_migrations (version, name, applied_at) VALUES (1, '0001_scheduler_foundation', ?)`,
        )
        .run(new Date().toISOString())
    }

    if (!applied.has(2)) {
      const routineCols = getColumnNames(sqlite, 'scheduler_routines')
      if (!routineCols.has('revision')) {
        sqlite.exec(`ALTER TABLE scheduler_routines ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;`)
      }
      if (!routineCols.has('ownership')) {
        sqlite.exec(
          `ALTER TABLE scheduler_routines ADD COLUMN ownership TEXT NOT NULL DEFAULT 'ghost-bot';`,
        )
      }
      const taskCols = getColumnNames(sqlite, 'scheduler_tasks')
      if (!taskCols.has('routine_revision')) {
        sqlite.exec(`ALTER TABLE scheduler_tasks ADD COLUMN routine_revision INTEGER NOT NULL DEFAULT 1;`)
      }
      if (!taskCols.has('trigger_source')) {
        sqlite.exec(
          `ALTER TABLE scheduler_tasks ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'schedule';`,
        )
      }
      sqlite
        .prepare(
          `INSERT INTO scheduler_schema_migrations (version, name, applied_at) VALUES (2, '0002_scheduler_phase5a2', ?)`,
        )
        .run(new Date().toISOString())
    }

    if (!applied.has(3)) {
      const taskCols = getColumnNames(sqlite, 'scheduler_tasks')
      if (!taskCols.has('payload_hash')) {
        sqlite.exec(`ALTER TABLE scheduler_tasks ADD COLUMN payload_hash TEXT;`)
      }
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS scheduler_occurrence_dedup (
          occurrence_key TEXT PRIMARY KEY,
          routine_id TEXT NOT NULL REFERENCES scheduler_routines(id) ON DELETE CASCADE,
          trigger_source TEXT NOT NULL,
          payload_hash TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_scheduler_dedup_routine
          ON scheduler_occurrence_dedup(routine_id, expires_at);
      `)
      sqlite
        .prepare(
          `INSERT INTO scheduler_schema_migrations (version, name, applied_at) VALUES (3, '0003_scheduler_phase5a3', ?)`,
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
