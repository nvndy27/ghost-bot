import { unlink } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStorageCorruptionError, MemoryStorageError, MemoryUnsafePathError } from '../contracts/errors.ts'
import {
  assertSafeDatabaseArtifacts,
  ensurePrivateDatabaseFileCreated,
  prepareSafeDatabasePath,
} from '../security/path-guard.ts'
import { sanitizeErrorMessage } from '../security/redaction.ts'
import { initializeMemorySchema } from './sqlite-schema.ts'

export interface MemoryDatabaseHandle {
  readonly dbPath: string
  readonly sqlite: DatabaseSync
  readonly fts5Enabled: boolean
  transaction: <T>(fn: () => T) => T
  close: () => void
}

export interface OpenMemoryDatabaseOptions {
  enableFts5?: boolean
}

export async function openMemoryDatabase(
  dbPathInput: string,
  options: OpenMemoryDatabaseOptions = {},
): Promise<MemoryDatabaseHandle> {
  const dbPath = await prepareSafeDatabasePath(dbPathInput)
  const createdNewFile = await ensurePrivateDatabaseFileCreated(dbPath)

  let sqlite: DatabaseSync
  let fts5Enabled = false

  try {
    sqlite = new DatabaseSync(dbPath)
  } catch (err) {
    if (createdNewFile) {
      await unlink(dbPath).catch(() => undefined)
    }
    throw new MemoryStorageError(`Failed to open memory SQLite database: ${sanitizeErrorMessage(err)}`)
  }

  try {
    sqlite.exec('PRAGMA foreign_keys = ON;')
    if (dbPath !== ':memory:') {
      sqlite.exec('PRAGMA journal_mode = WAL;')
    }
    sqlite.exec('PRAGMA busy_timeout = 5000;')

    const integrity = sqlite.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown> | undefined
    const checkValue = integrity ? Object.values(integrity)[0] : undefined
    if (checkValue !== 'ok') {
      throw new MemoryStorageCorruptionError('SQLite database failed integrity check')
    }

    const schemaResult = initializeMemorySchema(sqlite, { enableFts5: options.enableFts5 })
    fts5Enabled = schemaResult.fts5Enabled
    await assertSafeDatabaseArtifacts(dbPath)
  } catch (err) {
    try {
      sqlite.close()
    } catch {
      // Ignore close error during failed initialization.
    }
    if (createdNewFile) {
      await unlink(dbPath).catch(() => undefined)
      await unlink(`${dbPath}-wal`).catch(() => undefined)
      await unlink(`${dbPath}-shm`).catch(() => undefined)
    }
    if (
      err instanceof MemoryStorageCorruptionError ||
      err instanceof MemoryStorageError ||
      err instanceof MemoryUnsafePathError
    ) {
      throw err
    }
    throw new MemoryStorageError(`Failed to initialize memory database: ${sanitizeErrorMessage(err)}`)
  }

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
        // Ignore rollback errors.
      }
      throw err
    }
  }

  return {
    dbPath,
    sqlite,
    fts5Enabled,
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
