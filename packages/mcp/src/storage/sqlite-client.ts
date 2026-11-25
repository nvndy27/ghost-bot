import { unlink } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { sanitizeErrorMessage } from '@ghost-bot/memory'
import { McpStorageCorruptionError, McpStorageError, McpUnsafePathError } from '../contracts/errors.ts'
import {
  assertSafeDatabaseArtifacts,
  ensurePrivateDatabaseFileCreated,
  prepareSafeDatabasePath,
} from '../security/path-guard.ts'
import { initializeMcpSchema } from './sqlite-schema.ts'

export interface McpDatabaseHandle {
  readonly dbPath: string
  readonly sqlite: DatabaseSync
  transaction: <T>(fn: () => T) => T
  close: () => void
}

export async function openMcpDatabase(dbPathInput: string): Promise<McpDatabaseHandle> {
  const dbPath = await prepareSafeDatabasePath(dbPathInput)
  const createdNewFile = await ensurePrivateDatabaseFileCreated(dbPath)

  let sqlite: DatabaseSync
  try {
    sqlite = new DatabaseSync(dbPath)
  } catch (err) {
    if (createdNewFile) {
      await unlink(dbPath).catch(() => undefined)
    }
    throw new McpStorageError(`Failed to open MCP SQLite database: ${sanitizeErrorMessage(err)}`)
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
      throw new McpStorageCorruptionError('MCP SQLite database failed integrity check')
    }

    initializeMcpSchema(sqlite)
    await assertSafeDatabaseArtifacts(dbPath)
  } catch (err) {
    try {
      sqlite.close()
    } catch {
      // Ignore close error.
    }
    if (createdNewFile) {
      await unlink(dbPath).catch(() => undefined)
      await unlink(`${dbPath}-wal`).catch(() => undefined)
      await unlink(`${dbPath}-shm`).catch(() => undefined)
    }
    if (
      err instanceof McpStorageCorruptionError ||
      err instanceof McpStorageError ||
      err instanceof McpUnsafePathError
    ) {
      throw err
    }
    throw new McpStorageError(`Failed to initialize MCP database: ${sanitizeErrorMessage(err)}`)
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
        // Ignore rollback error.
      }
      throw err
    }
  }

  return {
    dbPath,
    sqlite,
    transaction,
    close: () => {
      try {
        sqlite.close()
      } catch {
        // Ignore close error.
      }
    },
  }
}
