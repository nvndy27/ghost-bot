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

export function openSchedulerDatabase(dataDir: string, fileName = 'scheduler.sqlite'): SchedulerDatabaseHandle {
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
  if (existsSync(dbPath)) {
    const fileStat = lstatSync(dbPath)
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new SchedulerError('INVALID_STORAGE', 'Scheduler database path must not be a symlink')
    }
  }

  const sqlite = new DatabaseSync(dbPath)
  chmodSync(dbPath, 0o600)

  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

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

  return {
    sqlite,
    dbPath,
    transaction<T>(fn: () => T): T {
      sqlite.exec('BEGIN IMMEDIATE')
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
      }
    },
    close() {
      sqlite.close()
    },
  }
}
