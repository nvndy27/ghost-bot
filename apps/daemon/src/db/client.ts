import { chmod, lstat, mkdir } from 'node:fs/promises'
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

async function assertSafeDirectory(dirPath: string): Promise<void> {
  const st = await lstat(dirPath).catch(() => null)
  if (!st) {
    await mkdir(dirPath, { recursive: true, mode: 0o700 })
  }
  const verified = await lstat(dirPath)
  if (verified.isSymbolicLink() || !verified.isDirectory()) {
    throw new DaemonError('UNSAFE_DATA_DIR', 'Data directory must be a real directory, not a symlink', {
      statusCode: 500,
    })
  }
  if (typeof process.getuid === 'function' && verified.uid !== process.getuid()) {
    throw new DaemonError('UNSAFE_DATA_DIR', 'Data directory is not owned by the current user', {
      statusCode: 500,
    })
  }
  await chmod(dirPath, 0o700)
}

async function assertSafeRegularFileIfExists(filePath: string): Promise<void> {
  const st = await lstat(filePath).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new DaemonError('UNSAFE_DB_FILE', `Unsafe database artifact at ${filePath}`, {
      statusCode: 500,
    })
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new DaemonError('UNSAFE_DB_FILE', `Database artifact not owned by current user: ${filePath}`, {
      statusCode: 500,
    })
  }
  await chmod(filePath, 0o600)
}

export async function openGhostBotDatabase(dataDir?: string): Promise<DatabaseHandle> {
  const dir = resolve(dataDir ?? process.env.GHOST_BOT_DATA_DIR ?? defaultDataDir())
  await assertSafeDirectory(dir)

  const dbPath = join(dir, 'ghost-bot.sqlite')
  await assertSafeRegularFileIfExists(dbPath)
  await assertSafeRegularFileIfExists(`${dbPath}-wal`)
  await assertSafeRegularFileIfExists(`${dbPath}-shm`)

  let sqlite: DatabaseSync
  try {
    sqlite = new DatabaseSync(dbPath)
    sqlite.exec('PRAGMA foreign_keys = ON;')
    sqlite.exec('PRAGMA journal_mode = WAL;')
    sqlite.exec('PRAGMA busy_timeout = 5000;')
    runMigrations(sqlite)
    await assertSafeRegularFileIfExists(dbPath)
    await assertSafeRegularFileIfExists(`${dbPath}-wal`)
    await assertSafeRegularFileIfExists(`${dbPath}-shm`)
  } catch (err) {
    if (err instanceof DaemonError) throw err
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
