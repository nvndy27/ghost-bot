import { chmod, constants, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { KnowledgeUnsafePathError, KnowledgeValidationError } from '../contracts/errors.ts'

export function validateStoragePathInput(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new KnowledgeUnsafePathError('Storage path must be a non-empty string')
  }
  if (rawPath.includes('\0')) {
    throw new KnowledgeUnsafePathError('Storage path must not contain NUL bytes')
  }
  if (rawPath === ':memory:') {
    return rawPath
  }
  if (!isAbsolute(rawPath)) {
    throw new KnowledgeUnsafePathError('File-backed storage path must be absolute')
  }
  return resolve(rawPath)
}

async function assertNoSymlinkAncestors(targetDir: string): Promise<void> {
  const resolved = resolve(targetDir)
  const { root } = parse(resolved)
  const rel = resolved.slice(root.length)
  if (!rel) return

  const parts = rel.split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = current === root ? `${root}${part}` : `${current}${sep}${part}`
    const st = await lstat(current).catch(() => null)
    if (!st) break
    if (st.isSymbolicLink()) {
      throw new KnowledgeUnsafePathError(`Storage path ancestor must not be a symlink: ${current}`)
    }
    if (!st.isDirectory()) {
      throw new KnowledgeUnsafePathError(`Storage path ancestor must be a directory: ${current}`)
    }
  }
}

export async function assertSafeDirectory(dirPath: string): Promise<void> {
  if (dirPath.includes('\0')) {
    throw new KnowledgeUnsafePathError('Storage directory path must not contain NUL bytes')
  }
  await assertNoSymlinkAncestors(dirPath)

  const existing = await lstat(dirPath).catch(() => null)
  const createdByUs = !existing
  if (createdByUs) {
    await mkdir(dirPath, { recursive: true, mode: 0o700 })
  }

  const verified = await lstat(dirPath)
  if (verified.isSymbolicLink() || !verified.isDirectory()) {
    throw new KnowledgeUnsafePathError('Knowledge storage directory must be a real directory, not a symlink')
  }
  if (typeof process.getuid === 'function' && verified.uid !== process.getuid()) {
    throw new KnowledgeUnsafePathError('Knowledge storage directory is not owned by the current user')
  }

  if (createdByUs) {
    await chmod(dirPath, 0o700)
  } else if ((verified.mode & 0o077) !== 0) {
    throw new KnowledgeUnsafePathError(
      'Existing knowledge storage directory has overly permissive mode; expected 0700',
    )
  }
}

export async function assertSafeRegularFileIfExists(filePath: string): Promise<void> {
  const st = await lstat(filePath).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new KnowledgeUnsafePathError(`Unsafe knowledge database artifact at ${filePath}`)
  }
  if (st.nlink > 1) {
    throw new KnowledgeUnsafePathError(`Knowledge database artifact must not have multiple hardlinks: ${filePath}`)
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new KnowledgeUnsafePathError(`Knowledge database artifact not owned by current user: ${filePath}`)
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

export async function readAuthorizedSourceFile(
  filePathInput: string,
  allowedRootDirInput: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; displayFilename: string }> {
  if (!filePathInput || filePathInput.includes('\0') || !allowedRootDirInput || allowedRootDirInput.includes('\0')) {
    throw new KnowledgeUnsafePathError('Invalid source path or root directory')
  }
  if (!isAbsolute(allowedRootDirInput)) {
    throw new KnowledgeUnsafePathError('allowedRootDir must be an absolute path')
  }

  const rootStat = await lstat(allowedRootDirInput).catch(() => null)
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new KnowledgeUnsafePathError('allowedRootDir must be an existing non-symlink directory')
  }
  const canonicalRoot = await realpath(allowedRootDirInput)

  const candidatePath = isAbsolute(filePathInput)
    ? resolve(filePathInput)
    : resolve(canonicalRoot, filePathInput)

  const relFromRoot = relative(canonicalRoot, candidatePath)
  if (!relFromRoot || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
    throw new KnowledgeUnsafePathError('Source file path escapes authorized root directory')
  }

  const fileStat = await lstat(candidatePath).catch(() => null)
  if (!fileStat) {
    throw new KnowledgeUnsafePathError('Source file does not exist')
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new KnowledgeUnsafePathError('Source path must be a regular non-symlink file')
  }
  if (fileStat.nlink > 1) {
    throw new KnowledgeUnsafePathError('Source file must not have multiple hardlinks')
  }
  if (typeof process.getuid === 'function' && fileStat.uid !== process.getuid()) {
    throw new KnowledgeUnsafePathError('Source file is not owned by the current user')
  }

  const canonicalFile = await realpath(candidatePath)
  if (!canonicalFile.startsWith(`${canonicalRoot}${sep}`)) {
    throw new KnowledgeUnsafePathError('Canonical source file path escapes authorized root directory')
  }

  if (fileStat.size > maxBytes) {
    throw new KnowledgeValidationError(`Source file exceeds maximum allowed size (${maxBytes} bytes)`)
  }

  const flags =
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
  const handle = await open(canonicalFile, flags)
  try {
    const fdStat = await handle.stat()
    if (!fdStat.isFile() || fdStat.nlink > 1) {
      throw new KnowledgeUnsafePathError('Opened source file failed regular-file verification')
    }
    if (fdStat.size > maxBytes) {
      throw new KnowledgeValidationError(`Source file exceeds maximum allowed size (${maxBytes} bytes)`)
    }

    const buf = Buffer.allocUnsafe(maxBytes + 1)
    let totalRead = 0
    while (totalRead <= maxBytes) {
      const { bytesRead } = await handle.read(buf, totalRead, maxBytes + 1 - totalRead, totalRead)
      if (bytesRead === 0) break
      totalRead += bytesRead
      if (totalRead > maxBytes) {
        throw new KnowledgeValidationError(`Source file exceeds maximum allowed size (${maxBytes} bytes)`)
      }
    }

    const parts = canonicalFile.split(sep)
    const displayFilename = parts[parts.length - 1] ?? 'document'
    return {
      bytes: buf.subarray(0, totalRead),
      displayFilename,
    }
  } finally {
    await handle.close()
  }
}
