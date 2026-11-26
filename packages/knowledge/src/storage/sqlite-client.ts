import { unlink } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { sanitizeErrorMessage } from '@ghost-bot/memory'
import {
  KnowledgeStorageCorruptionError,
  KnowledgeStorageError,
  KnowledgeUnsafePathError,
} from '../contracts/errors.ts'
import {
  assertSafeDatabaseArtifacts,
  ensurePrivateDatabaseFileCreated,
  prepareSafeDatabasePath,
} from '../security/path-guard.ts'
import { initializeKnowledgeSchema } from './sqlite-schema.ts'

export interface KnowledgeDatabaseHandle {
  readonly dbPath: string
  readonly sqlite: DatabaseSync
  readonly fts5Enabled: boolean
  transaction: <T>(fn: () => T) => T
  close: () => void
}

export interface OpenKnowledgeDatabaseOptions {
  enableFts5?: boolean
}

export async function openKnowledgeDatabase(
  dbPathInput: string,
  options: OpenKnowledgeDatabaseOptions = {},
): Promise<KnowledgeDatabaseHandle> {
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
    throw new KnowledgeStorageError(`Failed to open knowledge SQLite database: ${sanitizeErrorMessage(err)}`)
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
      throw new KnowledgeStorageCorruptionError('Knowledge SQLite database failed integrity check')
    }

    const schemaResult = initializeKnowledgeSchema(sqlite, { enableFts5: options.enableFts5 })
    fts5Enabled = schemaResult.fts5Enabled
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
      err instanceof KnowledgeStorageCorruptionError ||
      err instanceof KnowledgeStorageError ||
      err instanceof KnowledgeUnsafePathError
    ) {
      throw err
    }
    throw new KnowledgeStorageError(`Failed to initialize knowledge database: ${sanitizeErrorMessage(err)}`)
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
    fts5Enabled,
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

export interface BorrowedKnowledgeDatabaseOptions {
  fts5Enabled?: boolean
  dbLabel?: string
}

function detectKnowledgeFtsTable(sqlite: DatabaseSync): boolean {
  try {
    const row = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks_fts'`)
      .get() as { name?: unknown } | undefined
    return row?.name === 'knowledge_chunks_fts'
  } catch {
    return false
  }
}

/**
 * Wraps an externally owned SQLite connection (e.g., daemon-owned `ghost-bot.sqlite`)
 * after production migrations have initialized the Knowledge tables.
 * Closing this handle only detaches the repository; it never closes `sqlite`.
 */
export function createBorrowedKnowledgeDatabaseHandle(
  sqlite: DatabaseSync,
  options: BorrowedKnowledgeDatabaseOptions = {},
): KnowledgeDatabaseHandle {
  const fts5Enabled = options.fts5Enabled ?? detectKnowledgeFtsTable(sqlite)
  const dbPath = options.dbLabel ?? ':borrowed:'

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
    fts5Enabled,
    transaction,
    close: () => {
      // Intentionally no-op: the caller retains ownership of `sqlite`.
    },
  }
}
