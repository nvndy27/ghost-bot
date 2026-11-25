import { chmod, lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { MemoryUnsafePathError } from '../contracts/errors.ts'

export function validateStoragePathInput(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new MemoryUnsafePathError('Storage path must be a non-empty string')
  }
  if (rawPath.includes('\0')) {
    throw new MemoryUnsafePathError('Storage path must not contain NUL bytes')
  }
  if (rawPath === ':memory:') {
    return rawPath
  }
  if (!isAbsolute(rawPath)) {
    throw new MemoryUnsafePathError('File-backed storage path must be absolute')
  }
  return resolve(rawPath)
}

export async function assertSafeDirectory(dirPath: string): Promise<void> {
  if (dirPath.includes('\0')) {
    throw new MemoryUnsafePathError('Storage directory path must not contain NUL bytes')
  }
  const st = await lstat(dirPath).catch(() => null)
  if (!st) {
    await mkdir(dirPath, { recursive: true, mode: 0o700 })
  }
  const verified = await lstat(dirPath)
  if (verified.isSymbolicLink() || !verified.isDirectory()) {
    throw new MemoryUnsafePathError('Memory storage directory must be a real directory, not a symlink')
  }
  if (typeof process.getuid === 'function' && verified.uid !== process.getuid()) {
    throw new MemoryUnsafePathError('Memory storage directory is not owned by the current user')
  }
  await chmod(dirPath, 0o700)
}

export async function assertSafeRegularFileIfExists(filePath: string): Promise<void> {
  const st = await lstat(filePath).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new MemoryUnsafePathError(`Unsafe memory database artifact at ${filePath}`)
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new MemoryUnsafePathError(`Memory database artifact not owned by current user: ${filePath}`)
  }
  await chmod(filePath, 0o600)
}

export async function prepareSafeDatabasePath(dbPathInput: string): Promise<string> {
  const dbPath = validateStoragePathInput(dbPathInput)
  if (dbPath === ':memory:') {
    return dbPath
  }
  const dir = dirname(dbPath)
  await assertSafeDirectory(dir)
  await assertSafeDatabaseArtifacts(dbPath)
  return dbPath
}

export async function assertSafeDatabaseArtifacts(dbPath: string): Promise<void> {
  if (dbPath === ':memory:') return
  await assertSafeRegularFileIfExists(dbPath)
  await assertSafeRegularFileIfExists(`${dbPath}-wal`)
  await assertSafeRegularFileIfExists(`${dbPath}-shm`)
}
