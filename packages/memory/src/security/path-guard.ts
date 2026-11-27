import { chmod, constants, lstat, mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path'
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

async function assertNoSymlinkAncestors(targetDir: string): Promise<void> {
  const resolved = resolve(targetDir)
  const { root } = parse(resolved)
  const relative = resolved.slice(root.length)
  if (!relative) return

  const parts = relative.split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = current === root ? `${root}${part}` : `${current}${sep}${part}`
    const st = await lstat(current).catch(() => null)
    if (!st) break
    if (st.isSymbolicLink()) {
      throw new MemoryUnsafePathError(`Storage path ancestor must not be a symlink: ${current}`)
    }
    if (!st.isDirectory()) {
      throw new MemoryUnsafePathError(`Storage path ancestor must be a directory: ${current}`)
    }
  }
}

export async function assertSafeDirectory(dirPath: string): Promise<void> {
  if (dirPath.includes('\0')) {
    throw new MemoryUnsafePathError('Storage directory path must not contain NUL bytes')
  }
  await assertNoSymlinkAncestors(dirPath)

  const existing = await lstat(dirPath).catch(() => null)
  const createdByUs = !existing
  if (createdByUs) {
    await mkdir(dirPath, { recursive: true, mode: 0o700 })
  }

  const verified = await lstat(dirPath)
  if (verified.isSymbolicLink() || !verified.isDirectory()) {
    throw new MemoryUnsafePathError('Memory storage directory must be a real directory, not a symlink')
  }
  if (typeof process.getuid === 'function' && verified.uid !== process.getuid()) {
    throw new MemoryUnsafePathError('Memory storage directory is not owned by the current user')
  }

  if (createdByUs) {
    await chmod(dirPath, 0o700)
  } else if ((verified.mode & 0o077) !== 0) {
    throw new MemoryUnsafePathError(
      'Existing memory storage directory has overly permissive mode; expected 0700',
    )
  }
}

export async function assertSafeRegularFileIfExists(filePath: string): Promise<void> {
  const st = await lstat(filePath).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new MemoryUnsafePathError(`Unsafe memory database artifact at ${filePath}`)
  }
  if (st.nlink > 1) {
    throw new MemoryUnsafePathError(`Memory database artifact must not have multiple hardlinks: ${filePath}`)
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new MemoryUnsafePathError(`Memory database artifact not owned by current user: ${filePath}`)
  }
  if ((st.mode & 0o177) !== 0) {
    await chmod(filePath, 0o600)
  }
}

export async function ensurePrivateDatabaseFileCreated(dbPath: string): Promise<boolean> {
  if (dbPath === ':memory:') return false
  const existing = await lstat(dbPath).catch(() => null)
  if (existing) return false

  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_RDWR |
    (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)

  const handle = await open(dbPath, flags, 0o600)
  try {
    await chmod(dbPath, 0o600)
  } finally {
    await handle.close()
  }
  return true
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
