import { chmod, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { DaemonError } from '../errors.ts'
import { runMigrations } from './migrations.ts'
import * as schema from './schema.ts'

export type GhostBotDb = SqliteRemoteDatabase<typeof schema>

export interface DatabaseHandle {
  dbPath: string
  sqlite: DatabaseSync
  db: GhostBotDb
  transaction: <T>(fn: () => T) => T
  close: () => void
}

export function defaultDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.trim() ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'ghost-bot')
}

export async function openGhostBotDatabase(dataDir?: string): Promise<DatabaseHandle> {
  const requestedDir = resolve(dataDir ?? process.env.GHOST_BOT_DATA_DIR ?? defaultDataDir())
  await mkdir(requestedDir, { recursive: true, mode: 0o700 })
  const dir = await realpath(requestedDir)
  await chmod(dir, 0o700)

  const dbPath = join(dir, 'ghost-bot.sqlite')
  let sqlite: DatabaseSync
  try {
    sqlite = new DatabaseSync(dbPath)
    sqlite.exec('PRAGMA foreign_keys = ON;')
    sqlite.exec('PRAGMA journal_mode = WAL;')
    sqlite.exec('PRAGMA busy_timeout = 5000;')
    runMigrations(sqlite)
    await chmod(dbPath, 0o600).catch(() => undefined)
    await chmod(`${dbPath}-wal`, 0o600).catch(() => undefined)
    await chmod(`${dbPath}-shm`, 0o600).catch(() => undefined)
  } catch (err) {
    throw new DaemonError(
      'DB_INIT_FAILED',
      `Failed to initialize SQLite database: ${err instanceof Error ? err.message : String(err)}`,
      { statusCode: 500 },
    )
  }

  const db = drizzle<typeof schema>(
    async (sql, params, method) => {
      const stmt = sqlite.prepare(sql)
      const args = params as SQLInputValue[]
      if (method === 'run') {
        stmt.run(...args)
        return { rows: [] }
      }
      const records = stmt.all(...args) as Array<Record<string, unknown>>
      if (method === 'get') {
        const first = records[0]
        return { rows: first ? Object.values(first) : ([] as unknown[]) }
      }
      return { rows: records.map((r) => Object.values(r)) }
    },
    { schema },
  )

  const transaction = <T,>(fn: () => T): T => {
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      sqlite.exec('COMMIT')
      return result
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {
        // Ignore rollback failure.
      }
      throw err
    }
  }

  return {
    dbPath,
    sqlite,
    db,
    transaction,
    close: () => {
      try {
        sqlite.close()
      } catch {
        // Ignore close errors.
      }
    },
  }
}
