import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { chmod, constants, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, parse, resolve, sep } from 'node:path'
import { McpUnsafePathError } from '../contracts/errors.ts'

const DISALLOWED_PACKAGE_RUNNERS = new Set([
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'bunx',
  'uvx',
  'pip',
  'pip3',
  'curl',
  'wget',
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
])

export function validateStoragePathInput(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new McpUnsafePathError('Storage path must be a non-empty string')
  }
  if (rawPath.includes('\0')) {
    throw new McpUnsafePathError('Storage path must not contain NUL bytes')
  }
  if (rawPath === ':memory:') {
    return rawPath
  }
  if (!isAbsolute(rawPath)) {
    throw new McpUnsafePathError('File-backed storage path must be absolute')
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
      throw new McpUnsafePathError(`Storage path ancestor must not be a symlink: ${current}`)
    }
    if (!st.isDirectory()) {
      throw new McpUnsafePathError(`Storage path ancestor must be a directory: ${current}`)
    }
  }
}

export async function assertSafeDirectory(dirPath: string): Promise<void> {
  if (dirPath.includes('\0')) {
    throw new McpUnsafePathError('Storage directory path must not contain NUL bytes')
  }
  await assertNoSymlinkAncestors(dirPath)

  const existing = await lstat(dirPath).catch(() => null)
  const createdByUs = !existing
  if (createdByUs) {
    await mkdir(dirPath, { recursive: true, mode: 0o700 })
  }

  const verified = await lstat(dirPath)
  if (verified.isSymbolicLink() || !verified.isDirectory()) {
    throw new McpUnsafePathError('MCP storage directory must be a real directory, not a symlink')
  }
  if (typeof process.getuid === 'function' && verified.uid !== process.getuid()) {
    throw new McpUnsafePathError('MCP storage directory is not owned by the current user')
  }

  if (createdByUs) {
    await chmod(dirPath, 0o700)
  } else if ((verified.mode & 0o077) !== 0) {
    throw new McpUnsafePathError(
      'Existing MCP storage directory has overly permissive mode; expected 0700',
    )
  }
}

export async function assertSafeRegularFileIfExists(filePath: string): Promise<void> {
  const st = await lstat(filePath).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new McpUnsafePathError(`Unsafe MCP database artifact at ${filePath}`)
  }
  if (st.nlink > 1) {
    throw new McpUnsafePathError(`MCP database artifact must not have multiple hardlinks: ${filePath}`)
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new McpUnsafePathError(`MCP database artifact not owned by current user: ${filePath}`)
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

export async function validateStdioLaunchPaths(
  executablePathInput: string,
  cwdInput: string,
): Promise<{ executablePath: string; cwd: string }> {
  if (!isAbsolute(executablePathInput) || executablePathInput.includes('\0')) {
    throw new McpUnsafePathError('MCP executablePath must be an absolute path without NUL bytes')
  }
  if (!isAbsolute(cwdInput) || cwdInput.includes('\0')) {
    throw new McpUnsafePathError('MCP cwd must be an absolute path without NUL bytes')
  }

  const exeName = basename(executablePathInput).toLowerCase()
  if (DISALLOWED_PACKAGE_RUNNERS.has(exeName)) {
    throw new McpUnsafePathError(
      `Disallowed MCP executable "${exeName}": automatic package runners, downloaders, and shells are forbidden`,
    )
  }

  const exeStat = await lstat(executablePathInput).catch(() => null)
  if (!exeStat) {
    throw new McpUnsafePathError('MCP executablePath does not exist')
  }
  if (exeStat.isSymbolicLink() || !exeStat.isFile()) {
    throw new McpUnsafePathError('MCP executablePath must be a regular non-symlink file')
  }
  if (typeof process.getuid === 'function' && exeStat.uid !== process.getuid() && exeStat.uid !== 0) {
    throw new McpUnsafePathError('MCP executablePath must be owned by current user or root')
  }
  if ((exeStat.mode & 0o111) === 0) {
    throw new McpUnsafePathError('MCP executablePath is not marked executable')
  }

  const cwdStat = await lstat(cwdInput).catch(() => null)
  if (!cwdStat || cwdStat.isSymbolicLink() || !cwdStat.isDirectory()) {
    throw new McpUnsafePathError('MCP cwd must be an existing non-symlink directory')
  }
  if (typeof process.getuid === 'function' && cwdStat.uid !== process.getuid()) {
    throw new McpUnsafePathError('MCP cwd must be owned by the current user')
  }

  const canonicalExe = await realpath(executablePathInput)
  const canonicalCwd = await realpath(cwdInput)

  return { executablePath: canonicalExe, cwd: canonicalCwd }
}

export function computeLaunchBinaryDigestSync(
  executablePath: string,
  args: readonly string[],
): string | null {
  try {
    const exeStat = lstatSync(executablePath)
    if (!exeStat.isFile() || exeStat.isSymbolicLink()) return null
    const canonicalExe = realpathSync(executablePath)
    const hash = createHash('sha256')
    hash.update(readFileSync(canonicalExe))

    const firstArg = args[0]
    if (firstArg && isAbsolute(firstArg) && !firstArg.includes('\0')) {
      try {
        const argStat = lstatSync(firstArg)
        if (argStat.isFile() && !argStat.isSymbolicLink()) {
          hash.update('\0script\0')
          hash.update(readFileSync(realpathSync(firstArg)))
        }
      } catch {
        // Non-file first argument (e.g., flag) is not hashed as a script.
      }
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}
