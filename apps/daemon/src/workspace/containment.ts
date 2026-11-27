import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  constants as fsConstants,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, posix } from 'node:path'
import { DaemonError } from '../errors.ts'
import { WORKSPACE_LIMITS, type WorkspaceDirectoryEntry } from './contracts.ts'

const SENSITIVE_EXACT_NAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.dockercfg',
  'auth.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.json',
  'secrets.json',
  'service-account.json',
])

const SENSITIVE_DIR_NAMES = new Set(['.git', '.ssh', '.gnupg', '.aws', '.ghost-bot-trash'])

const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.kdbx'])

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.wasm',
  '.sqlite',
  '.db',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
])

export interface SaveHookOptions {
  onBeforeCommit?: () => Promise<void> | void
  injectWriteError?: () => void
}

export async function assertDescriptorContainmentSupported(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new DaemonError(
      'CONTAINMENT_UNSUPPORTED',
      `Descriptor-relative /proc/self/fd containment requires Linux (current: ${process.platform})`,
      { statusCode: 503 },
    )
  }
  const st = await stat('/proc/self/fd').catch(() => null)
  if (!st || !st.isDirectory()) {
    throw new DaemonError(
      'CONTAINMENT_UNSUPPORTED',
      'Linux /proc/self/fd descriptor containment is unavailable',
      { statusCode: 503 },
    )
  }
}

function procFdChildPath(dirFd: number, singleChildName: string): string {
  if (
    singleChildName.length === 0 ||
    singleChildName === '.' ||
    singleChildName === '..' ||
    singleChildName.includes('/') ||
    singleChildName.includes('\0')
  ) {
    throw new DaemonError('INVALID_PATH', 'Invalid single path component', { statusCode: 400 })
  }
  return `/proc/self/fd/${dirFd}/${singleChildName}`
}

export function isSensitiveSegment(name: string): boolean {
  const lower = name.toLowerCase()
  if (SENSITIVE_DIR_NAMES.has(lower)) return true
  if (SENSITIVE_EXACT_NAMES.has(lower)) return true
  if (lower.startsWith('.env.')) return true
  if (
    lower.startsWith('secret') &&
    (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml'))
  ) {
    return true
  }
  const dot = lower.lastIndexOf('.')
  if (dot >= 0 && SENSITIVE_EXTENSIONS.has(lower.slice(dot))) return true
  return false
}

export function isBlockedBinaryExtension(name: string): boolean {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return BINARY_EXTENSIONS.has(lower.slice(dot))
}

export function detectLanguageFromPath(relativePath: string): string {
  const lower = relativePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot) : ''
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript'
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.json':
      return 'json'
    case '.md':
    case '.mdx':
      return 'markdown'
    case '.css':
      return 'css'
    case '.html':
    case '.htm':
      return 'html'
    case '.py':
      return 'python'
    case '.rs':
      return 'rust'
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'shell'
    case '.yml':
    case '.yaml':
      return 'yaml'
    case '.sql':
      return 'sql'
    default:
      return 'plaintext'
  }
}

export function normalizeWorkspaceRelativePath(raw: string, allowEmpty: boolean): string[] {
  if (raw.includes('\0')) {
    throw new DaemonError('INVALID_PATH', 'Path contains NUL byte', { statusCode: 400 })
  }
  if (raw.includes('\\')) {
    throw new DaemonError('INVALID_PATH', 'Backslashes are not allowed in workspace paths', {
      statusCode: 400,
    })
  }
  if (isAbsolute(raw) || raw.startsWith('/')) {
    throw new DaemonError('INVALID_PATH', 'Absolute paths are not allowed', { statusCode: 400 })
  }
  if (raw.length === 0) {
    if (allowEmpty) return []
    throw new DaemonError('INVALID_PATH', 'Workspace-relative path is required', { statusCode: 400 })
  }
  if (raw.trim().length === 0) {
    throw new DaemonError('INVALID_PATH', 'Whitespace-only path is not allowed', {
      statusCode: 400,
    })
  }

  // Reject raw traversal segments BEFORE normalization so 'a/../b' never passes silently.
  const rawParts = raw.split('/')
  for (const part of rawParts) {
    if (part === '..' || part === '.') {
      throw new DaemonError('PATH_TRAVERSAL_REJECTED', 'Raw traversal segment is not allowed', {
        statusCode: 403,
      })
    }
  }

  const segments = rawParts.filter((s) => s.length > 0)
  if (segments.length === 0) {
    if (allowEmpty) return []
    throw new DaemonError('INVALID_PATH', 'Workspace-relative file path is required', {
      statusCode: 400,
    })
  }
  if (segments.length > WORKSPACE_LIMITS.maxPathDepth) {
    throw new DaemonError('INVALID_PATH', 'Path exceeds maximum directory depth', {
      statusCode: 400,
    })
  }
  if (posix.isAbsolute(segments.join('/'))) {
    throw new DaemonError('PATH_TRAVERSAL_REJECTED', 'Absolute path rejected', { statusCode: 403 })
  }
  for (const seg of segments) {
    if (isSensitiveSegment(seg)) {
      throw new DaemonError('SENSITIVE_FILE_BLOCKED', `Access to sensitive path '${seg}' is blocked`, {
        statusCode: 403,
      })
    }
  }
  return segments
}

export function computeWorkspaceId(
  canonicalRoot: string,
  rootDev: number,
  rootIno: number,
  ownerKind: 'bot' | 'team',
  ownerId: string,
): string {
  return createHash('sha256')
    .update(`${canonicalRoot}:${rootDev}:${rootIno}:${ownerKind}:${ownerId}`, 'utf8')
    .digest('hex')
    .slice(0, 24)
}

export function computeRevisionToken(st: Stats, bytes: Buffer): string {
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  return `${st.dev}:${st.ino}:${st.size}:${Math.trunc(st.mtimeMs)}:${contentHash.slice(0, 24)}`
}

function assertRegularFileStats(st: Stats, label: string): void {
  if (st.isSymbolicLink()) {
    throw new DaemonError('SYMLINK_REJECTED', `Symlink rejected for '${label}'`, {
      statusCode: 403,
    })
  }
  if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
    throw new DaemonError('UNSUPPORTED_SPECIAL_FILE', `Special file rejected for '${label}'`, {
      statusCode: 403,
    })
  }
  if (!st.isFile()) {
    throw new DaemonError('NOT_A_FILE', `Target '${label}' is not a regular file`, {
      statusCode: 400,
    })
  }
  if (st.nlink > 1) {
    throw new DaemonError(
      'HARDLINK_REJECTED',
      `Hard-linked file '${label}' (nlink=${st.nlink}) is rejected by workspace containment policy`,
      { statusCode: 403 },
    )
  }
}

export function assertValidUtf8Text(buf: Buffer, label: string): string {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) {
      throw new DaemonError('UNSUPPORTED_BINARY_FILE', `Binary/NUL content rejected for '${label}'`, {
        statusCode: 415,
      })
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return decoder.decode(buf)
  } catch {
    throw new DaemonError('UNSUPPORTED_BINARY_FILE', `Non-UTF-8 content rejected for '${label}'`, {
      statusCode: 415,
    })
  }
}

async function openRootDirectoryFd(
  canonicalRoot: string,
  expectedDev: number,
  expectedIno: number,
): Promise<FileHandle> {
  await assertDescriptorContainmentSupported()
  const oNoFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const oDirectory = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0
  const handle = await open(canonicalRoot, fsConstants.O_RDONLY | oDirectory | oNoFollow).catch(
    (err) => {
      const code = (err as NodeJS.ErrnoException)?.code
      throw new DaemonError(
        code === 'ELOOP' ? 'SYMLINK_REJECTED' : 'WORKSPACE_UNAVAILABLE',
        `Failed to open workspace root safely: ${code ?? 'unknown'}`,
        { statusCode: code === 'ELOOP' ? 403 : 404 },
      )
    },
  )

  try {
    const st = await handle.stat()
    if (!st.isDirectory()) {
      throw new DaemonError('WORKSPACE_UNAVAILABLE', 'Workspace root is not a directory', {
        statusCode: 404,
      })
    }
    if (st.dev !== expectedDev || st.ino !== expectedIno) {
      throw new DaemonError('ROOT_IDENTITY_CHANGED', 'Workspace root identity changed on disk', {
        statusCode: 409,
      })
    }
    return handle
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

async function openChildDirectoryFd(
  parentHandle: FileHandle,
  seg: string,
  rootDev: number,
): Promise<FileHandle> {
  const oNoFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const oDirectory = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0
  const childFdPath = procFdChildPath(parentHandle.fd, seg)

  const handle = await open(childFdPath, fsConstants.O_RDONLY | oDirectory | oNoFollow).catch(
    async (err) => {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ELOOP') {
        throw new DaemonError('SYMLINK_REJECTED', `Directory symlink rejected at '${seg}'`, {
          statusCode: 403,
        })
      }
      if (code === 'ENOENT') {
        throw new DaemonError('PATH_NOT_FOUND', `Directory '${seg}' does not exist`, {
          statusCode: 404,
        })
      }
      if (code === 'ENOTDIR') {
        const st = await lstat(childFdPath).catch(() => null)
        if (st?.isSymbolicLink()) {
          throw new DaemonError('SYMLINK_REJECTED', `Directory symlink rejected at '${seg}'`, {
            statusCode: 403,
          })
        }
        throw new DaemonError('NOT_A_DIRECTORY', `'${seg}' is not a directory`, {
          statusCode: 400,
        })
      }
      throw new DaemonError('WORKSPACE_OPEN_FAILED', `Failed to open '${seg}': ${code ?? 'unknown'}`, {
        statusCode: 403,
      })
    },
  )

  try {
    const st = await handle.stat()
    if (!st.isDirectory()) {
      throw new DaemonError('NOT_A_DIRECTORY', `'${seg}' is not a directory`, { statusCode: 400 })
    }
    if (st.dev !== rootDev) {
      throw new DaemonError(
        'MOUNT_BOUNDARY_REJECTED',
        `Directory '${seg}' crosses filesystem mount boundary`,
        { statusCode: 403 },
      )
    }
    return handle
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

export async function walkContainedDirectoryFd(
  canonicalRoot: string,
  rootDev: number,
  rootIno: number,
  segments: string[],
): Promise<FileHandle> {
  let current = await openRootDirectoryFd(canonicalRoot, rootDev, rootIno)
  try {
    for (const seg of segments) {
      const next = await openChildDirectoryFd(current, seg, rootDev)
      await current.close().catch(() => {})
      current = next
    }
    return current
  } catch (err) {
    await current.close().catch(() => {})
    throw err
  }
}

export async function listContainedDirectory(
  canonicalRoot: string,
  rootDev: number,
  rootIno: number,
  relativePath: string,
  limits?: { maxScan: number; shouldStop: () => boolean },
): Promise<{
  entries: WorkspaceDirectoryEntry[]
  truncated: boolean
  totalScanned: number
  normalizedRelativePath: string
}> {
  const segments = normalizeWorkspaceRelativePath(relativePath, true)
  const dirHandle = await walkContainedDirectoryFd(canonicalRoot, rootDev, rootIno, segments)

  try {
    const dir = await opendir(`/proc/self/fd/${dirHandle.fd}`)
    const entries: WorkspaceDirectoryEntry[] = []
    let truncated = false
    let totalScanned = 0

    try {
      for await (const entry of dir) {
        if (
          totalScanned >= Math.min(WORKSPACE_LIMITS.maxDirectoryScan, limits?.maxScan ?? Infinity) ||
          limits?.shouldStop()
        ) {
          truncated = true
          break
        }
        totalScanned += 1
        if (entry.isSymbolicLink()) continue
        if (!entry.isDirectory() && !entry.isFile()) continue
        if (isSensitiveSegment(entry.name)) continue

        if (entries.length >= WORKSPACE_LIMITS.maxDirectoryEntries) {
          truncated = true
          break
        }

        const entryRel = segments.length > 0 ? `${segments.join('/')}/${entry.name}` : entry.name
        let sizeBytes: number | null = null
        if (entry.isFile()) {
          const st = await lstat(procFdChildPath(dirHandle.fd, entry.name)).catch(() => null)
          if (!st || st.isSymbolicLink() || !st.isFile() || st.nlink > 1 || st.dev !== rootDev) {
            continue
          }
          sizeBytes = st.size
        }
        entries.push({
          name: entry.name,
          relativePath: entryRel,
          kind: entry.isDirectory() ? 'directory' : 'file',
          sizeBytes,
        })
      }
    } finally {
      await dir.close().catch(() => {})
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return {
      entries,
      truncated,
      totalScanned,
      normalizedRelativePath: segments.join('/'),
    }
  } finally {
    await dirHandle.close().catch(() => {})
  }
}

async function readExactFromHandle(handle: FileHandle, expectedSize: number): Promise<Buffer> {
  if (expectedSize === 0) return Buffer.alloc(0)
  const buf = Buffer.allocUnsafe(expectedSize)
  let offset = 0
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(buf, offset, expectedSize - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buf.subarray(0, offset)
}

export async function readContainedTextFile(
  canonicalRoot: string,
  rootDev: number,
  rootIno: number,
  relativePath: string,
  maxBytes: number = WORKSPACE_LIMITS.maxFileBytes,
) {
  const fileName = normalizeWorkspaceRelativePath(relativePath, false).at(-1)!
  if (isBlockedBinaryExtension(fileName)) {
    throw new DaemonError('UNSUPPORTED_BINARY_FILE', `File '${fileName}' is a binary type`, {
      statusCode: 415,
    })
  }

  const { bytes, ...file } = await readContainedFileBytes(canonicalRoot, rootDev, rootIno, relativePath, maxBytes)
  return { ...file, content: assertValidUtf8Text(bytes, file.normalizedRelativePath) }
}

export async function readContainedFileBytes(
  canonicalRoot: string,
  rootDev: number,
  rootIno: number,
  relativePath: string,
  maxBytes: number,
) {
  const segments = normalizeWorkspaceRelativePath(relativePath, false)
  const fileName = segments[segments.length - 1]

  const parentSegments = segments.slice(0, -1)
  const dirHandle = await walkContainedDirectoryFd(canonicalRoot, rootDev, rootIno, parentSegments)
  const childPath = procFdChildPath(dirHandle.fd, fileName)

  const oNoFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const oNonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0
  const flags = fsConstants.O_RDONLY | oNoFollow | oNonBlock

  let fileHandle: FileHandle | null = null
  try {
    try {
      fileHandle = await open(childPath, flags)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ELOOP') {
        throw new DaemonError('SYMLINK_REJECTED', 'Symlink target rejected', { statusCode: 403 })
      }
      if (code === 'ENOENT') {
        throw new DaemonError('FILE_NOT_FOUND', 'Requested file does not exist', { statusCode: 404 })
      }
      throw new DaemonError('FILE_OPEN_FAILED', `Failed to open file: ${code ?? 'unknown'}`, {
        statusCode: 403,
      })
    }

    const st = await fileHandle.stat()
    assertRegularFileStats(st, fileName)
    if (st.dev !== rootDev) {
      throw new DaemonError('MOUNT_BOUNDARY_REJECTED', 'File crosses mount boundary', {
        statusCode: 403,
      })
    }
    if (st.size > maxBytes) {
      throw new DaemonError(
        'FILE_TOO_LARGE',
        `File exceeds maximum readable size (${maxBytes} bytes)`,
        { statusCode: 413 },
      )
    }

    const exactBuf = await readExactFromHandle(fileHandle, st.size)
    const revision = computeRevisionToken(st, exactBuf)

    return {
      bytes: exactBuf,
      revision,
      sizeBytes: exactBuf.length,
      name: fileName,
      normalizedRelativePath: segments.join('/'),
    }
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {})
    }
    await dirHandle.close().catch(() => {})
  }
}

export async function saveContainedTextFile(
  canonicalRoot: string,
  rootDev: number,
  rootIno: number,
  relativePath: string,
  newContent: string,
  expectedRevision: string,
  hooks?: SaveHookOptions,
): Promise<{
  revision: string
  sizeBytes: number
  normalizedRelativePath: string
  savedAt: string
}> {
  const segments = normalizeWorkspaceRelativePath(relativePath, false)
  const fileName = segments[segments.length - 1]
  if (isBlockedBinaryExtension(fileName)) {
    throw new DaemonError('UNSUPPORTED_BINARY_FILE', `File '${fileName}' is a binary type`, {
      statusCode: 415,
    })
  }

  const nextBytes = Buffer.from(newContent, 'utf8')
  if (nextBytes.length > WORKSPACE_LIMITS.maxFileBytes) {
    throw new DaemonError(
      'FILE_TOO_LARGE',
      `Content exceeds maximum writable size (${WORKSPACE_LIMITS.maxFileBytes} bytes)`,
      { statusCode: 413 },
    )
  }
  assertValidUtf8Text(nextBytes, segments.join('/'))

  const parentSegments = segments.slice(0, -1)
  const dirHandle = await walkContainedDirectoryFd(canonicalRoot, rootDev, rootIno, parentSegments)
  const targetChildPath = procFdChildPath(dirHandle.fd, fileName)

  const oNoFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const oNonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0

  let readHandle: FileHandle | null = null
  let tmpHandle: FileHandle | null = null
  let tmpName: string | null = null
  let stagedIdentity: Stats | null = null

  try {
    try {
      readHandle = await open(targetChildPath, fsConstants.O_RDONLY | oNoFollow | oNonBlock)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ELOOP') {
        throw new DaemonError('SYMLINK_REJECTED', 'Symlink target rejected', { statusCode: 403 })
      }
      if (code === 'ENOENT') {
        throw new DaemonError('FILE_NOT_FOUND', 'Target file does not exist', { statusCode: 404 })
      }
      throw new DaemonError('FILE_OPEN_FAILED', `Failed to open file: ${code ?? 'unknown'}`, {
        statusCode: 403,
      })
    }

    const st = await readHandle.stat()
    assertRegularFileStats(st, fileName)
    if (st.dev !== rootDev) {
      throw new DaemonError('MOUNT_BOUNDARY_REJECTED', 'File crosses mount boundary', {
        statusCode: 403,
      })
    }
    if (st.size > WORKSPACE_LIMITS.maxFileBytes) {
      throw new DaemonError('FILE_TOO_LARGE', 'Existing file exceeds maximum editable size', {
        statusCode: 413,
      })
    }
    if ((st.mode & 0o222) === 0) {
      throw new DaemonError('FILE_READ_ONLY', 'File is read-only on disk', { statusCode: 403 })
    }

    const currentBuf = await readExactFromHandle(readHandle, st.size)
    const currentRevision = computeRevisionToken(st, currentBuf)
    await readHandle.close().catch(() => {})
    readHandle = null

    if (currentRevision !== expectedRevision) {
      throw new DaemonError(
        'FILE_CONFLICT',
        'File was modified on disk since it was opened. Reload before saving.',
        { statusCode: 409 },
      )
    }

    const origMode = st.mode & 0o777
    const origDev = st.dev
    const origIno = st.ino
    tmpName = `.ghost-tmp-${randomUUID()}`
    const tmpChildPath = procFdChildPath(dirHandle.fd, tmpName)

    tmpHandle = await open(
      tmpChildPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | oNoFollow,
      0o600,
    ).catch((err) => {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EACCES' || code === 'EROFS') {
        throw new DaemonError('FILE_READ_ONLY', 'Workspace directory is read-only', {
          statusCode: 403,
        })
      }
      throw new DaemonError('FILE_WRITE_FAILED', `Failed to stage temp file: ${code ?? 'unknown'}`, {
        statusCode: 500,
      })
    })

    stagedIdentity = await tmpHandle.stat()
    let written = 0
    while (written < nextBytes.length) {
      if (hooks?.injectWriteError) {
        hooks.injectWriteError()
      }
      const res = await tmpHandle.write(nextBytes, written, nextBytes.length - written, written)
      if (res.bytesWritten === 0) {
        throw new DaemonError('FILE_WRITE_INCOMPLETE', 'Incomplete write while staging file', {
          statusCode: 500,
        })
      }
      written += res.bytesWritten
    }
    if (hooks?.onBeforeCommit) {
      await hooks.onBeforeCommit()
    }

    // Revalidate target identity (dev, ino) and expectedRevision immediately before atomic rename.
    const preCommitHandle = await open(targetChildPath, fsConstants.O_RDONLY | oNoFollow | oNonBlock).catch(
      (err) => {
        const code = (err as NodeJS.ErrnoException)?.code
        throw new DaemonError(
          code === 'ELOOP' ? 'SYMLINK_REJECTED' : 'FILE_CONFLICT',
          'Target file could not be revalidated before commit',
          { statusCode: code === 'ELOOP' ? 403 : 409 },
        )
      },
    )
    try {
      const preCommitStat = await preCommitHandle.stat()
      assertRegularFileStats(preCommitStat, fileName)
      if (preCommitStat.dev !== origDev || preCommitStat.ino !== origIno) {
        throw new DaemonError(
          'FILE_CONFLICT',
          'Target file identity changed on disk during save staging',
          { statusCode: 409 },
        )
      }
      if (preCommitStat.size > WORKSPACE_LIMITS.maxFileBytes) {
        throw new DaemonError('FILE_TOO_LARGE', 'Target file grew beyond editable limit during staging', {
          statusCode: 413,
        })
      }
      const preCommitBytes = await readExactFromHandle(preCommitHandle, preCommitStat.size)
      const preCommitRevision = computeRevisionToken(preCommitStat, preCommitBytes)
      if (preCommitRevision !== expectedRevision) {
        throw new DaemonError(
          'FILE_CONFLICT',
          'File was modified on disk while staging save. Reload before saving.',
          { statusCode: 409 },
        )
      }
    } finally {
      await preCommitHandle.close().catch(() => {})
    }

    // A pinned descriptor identifies our staged inode even if the directory entry is replaced.
    await tmpHandle.chmod(origMode)
    await tmpHandle.sync()
    const stagedStat = await tmpHandle.stat()
    assertRegularFileStats(stagedStat, tmpName)
    const stagedBytes = await readExactFromHandle(tmpHandle, nextBytes.length)
    const stagedEntry = await lstat(tmpChildPath).catch(() => null)
    if (
      !stagedEntry?.isFile() ||
      stagedEntry.nlink !== 1 ||
      stagedEntry.dev !== rootDev ||
      stagedEntry.ino !== stagedStat.ino ||
      stagedEntry.size !== nextBytes.length ||
      stagedEntry.ctimeMs !== stagedStat.ctimeMs ||
      stagedEntry.mtimeMs !== stagedStat.mtimeMs ||
      (stagedEntry.mode & 0o777) !== origMode ||
      Buffer.compare(stagedBytes, nextBytes) !== 0
    ) {
      throw new DaemonError('STAGED_FILE_INVALID', 'Staged temporary file changed before commit', {
        statusCode: 409,
      })
    }
    const stagedIno = stagedStat.ino

    // Atomic replacement inside the pinned directory descriptor; never truncates the live file first.
    await rename(tmpChildPath, targetChildPath)
    tmpName = null
    await dirHandle.sync().catch(() => {})

    try {
      const verifyHandle = await open(targetChildPath, fsConstants.O_RDONLY | oNoFollow | oNonBlock)
      try {
        const updatedStat = await verifyHandle.stat()
        assertRegularFileStats(updatedStat, fileName)
        if (updatedStat.size > WORKSPACE_LIMITS.maxFileBytes) {
          throw new DaemonError('FILE_TOO_LARGE', 'Post-commit file exceeds readable limit', {
            statusCode: 500,
          })
        }
        const verifyBytes = await readExactFromHandle(verifyHandle, updatedStat.size)
        if (updatedStat.ino !== stagedIno || Buffer.compare(verifyBytes, nextBytes) !== 0) {
          throw new DaemonError(
            'SAVE_OUTCOME_UNCERTAIN',
            'Post-commit file identity or content did not match staged write',
            { statusCode: 500 },
          )
        }
        const newRevision = computeRevisionToken(updatedStat, verifyBytes)
        return {
          revision: newRevision,
          sizeBytes: verifyBytes.length,
          normalizedRelativePath: segments.join('/'),
          savedAt: new Date().toISOString(),
        }
      } finally {
        await verifyHandle.close().catch(() => {})
      }
    } catch (postErr) {
      throw new DaemonError(
        'SAVE_OUTCOME_UNCERTAIN',
        `File replacement committed, but post-commit verification failed: ${postErr instanceof Error ? postErr.message : String(postErr)}`,
        { statusCode: 500 },
      )
    }
  } finally {
    if (readHandle) {
      await readHandle.close().catch(() => {})
    }
    if (tmpName && stagedIdentity) {
      const stagedPath = procFdChildPath(dirHandle.fd, tmpName)
      const entry = await lstat(stagedPath).catch(() => null)
      if (entry?.dev === stagedIdentity.dev && entry.ino === stagedIdentity.ino) {
        await unlink(stagedPath).catch(() => {})
      }
    }
    if (tmpHandle) {
      await tmpHandle.close().catch(() => {})
    }
    await dirHandle.close().catch(() => {})
  }
}

export async function createContainedEntry(
  canonicalRoot: string,
  rootDev: number,
  rootIno: number,
  relativePath: string,
  kind: 'file' | 'directory',
  content = '',
  hooks?: SaveHookOptions,
): Promise<{
  normalizedRelativePath: string
  kind: 'file' | 'directory'
  revision: string | null
  sizeBytes: number | null
}> {
  const segments = normalizeWorkspaceRelativePath(relativePath, false)
  const entryName = segments[segments.length - 1]
  if (kind === 'file' && isBlockedBinaryExtension(entryName)) {
    throw new DaemonError('UNSUPPORTED_BINARY_FILE', `File '${entryName}' is a binary type`, {
      statusCode: 415,
    })
  }

  const parentSegments = segments.slice(0, -1)
  const dirHandle = await walkContainedDirectoryFd(canonicalRoot, rootDev, rootIno, parentSegments)
  const targetChildPath = procFdChildPath(dirHandle.fd, entryName)
  const oNoFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const oNonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0

  if (kind === 'directory') {
    try {
      if (hooks?.onBeforeCommit) await hooks.onBeforeCommit()
      await mkdir(targetChildPath, 0o755)
      await dirHandle.sync().catch(() => {})
      return {
        normalizedRelativePath: segments.join('/'),
        kind: 'directory',
        revision: null,
        sizeBytes: null,
      }
    } catch (err) {
      if (err instanceof DaemonError) throw err
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') {
        throw new DaemonError('FILE_EXISTS', `Directory '${entryName}' already exists`, {
          statusCode: 409,
        })
      }
      throw new DaemonError('CREATE_FAILED', `Failed to create directory: ${code ?? 'unknown'}`, {
        statusCode: 500,
      })
    } finally {
      await dirHandle.close().catch(() => {})
    }
  }

  const nextBytes = Buffer.from(content, 'utf8')
  if (nextBytes.length > WORKSPACE_LIMITS.maxFileBytes) {
    await dirHandle.close().catch(() => {})
    throw new DaemonError('FILE_TOO_LARGE', 'File content exceeds maximum size', { statusCode: 413 })
  }
  assertValidUtf8Text(nextBytes, segments.join('/'))

  let tmpHandle: FileHandle | null = null
  let tmpName: string | null = `.ghost-tmp-${randomUUID()}`
  const tmpChildPath = procFdChildPath(dirHandle.fd, tmpName)

  try {
    tmpHandle = await open(
      tmpChildPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | oNoFollow,
      0o644,
    )
    let written = 0
    while (written < nextBytes.length) {
      if (hooks?.injectWriteError) hooks.injectWriteError()
      const res = await tmpHandle.write(nextBytes, written, nextBytes.length - written, written)
      if (res.bytesWritten === 0) {
        throw new DaemonError('FILE_WRITE_INCOMPLETE', 'Incomplete write while staging file', {
          statusCode: 500,
        })
      }
      written += res.bytesWritten
    }
    const stagedStat = await tmpHandle.stat()
    assertRegularFileStats(stagedStat, tmpName)
    if (stagedStat.dev !== rootDev || stagedStat.size !== nextBytes.length) {
      throw new DaemonError('STAGED_FILE_INVALID', 'Staged temporary file failed integrity check', {
        statusCode: 500,
      })
    }
    const stagedDev = stagedStat.dev
    const stagedIno = stagedStat.ino
    await tmpHandle.sync()

    if (hooks?.onBeforeCommit) await hooks.onBeforeCommit()

    // Keep tmpHandle open and verify directory entry still points to our staged inode before link().
    const preLinkStat = await lstat(tmpChildPath).catch(() => null)
    if (
      !preLinkStat?.isFile() ||
      preLinkStat.nlink !== 1 ||
      preLinkStat.dev !== stagedDev ||
      preLinkStat.ino !== stagedIno ||
      preLinkStat.size !== nextBytes.length
    ) {
      throw new DaemonError('STAGED_FILE_INVALID', 'Staged temporary file was substituted before publication', {
        statusCode: 409,
      })
    }

    // Atomic no-clobber link fails with EEXIST if destination appeared concurrently.
    await link(tmpChildPath, targetChildPath).catch((err) => {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') {
        throw new DaemonError('FILE_EXISTS', `File '${entryName}' already exists`, {
          statusCode: 409,
        })
      }
      throw new DaemonError('CREATE_FAILED', `Failed to publish file: ${code ?? 'unknown'}`, {
        statusCode: 500,
      })
    })
    // Only unlink tmpChildPath if it still refers to our staged inode (never unlink a substituted entry).
    const postLinkTmp = await lstat(tmpChildPath).catch(() => null)
    if (postLinkTmp?.dev === stagedDev && postLinkTmp.ino === stagedIno) {
      await unlink(tmpChildPath).catch(() => {})
      tmpName = null
    }
    await tmpHandle.close()
    tmpHandle = null
    await dirHandle.sync().catch(() => {})

    try {
      const verifyHandle = await open(targetChildPath, fsConstants.O_RDONLY | oNoFollow | oNonBlock)
      try {
        const updatedStat = await verifyHandle.stat()
        assertRegularFileStats(updatedStat, entryName)
        if (updatedStat.size > WORKSPACE_LIMITS.maxFileBytes) {
          throw new DaemonError('FILE_TOO_LARGE', 'Created file exceeds readable limit', {
            statusCode: 500,
          })
        }
        const verifyBytes = await readExactFromHandle(verifyHandle, updatedStat.size)
        if (updatedStat.ino !== stagedIno || Buffer.compare(verifyBytes, nextBytes) !== 0) {
          throw new DaemonError(
            'SAVE_OUTCOME_UNCERTAIN',
            'Created file verification mismatched staged content',
            { statusCode: 500 },
          )
        }
        return {
          normalizedRelativePath: segments.join('/'),
          kind: 'file',
          revision: computeRevisionToken(updatedStat, verifyBytes),
          sizeBytes: verifyBytes.length,
        }
      } finally {
        await verifyHandle.close().catch(() => {})
      }
    } catch (postErr) {
      throw new DaemonError(
        'SAVE_OUTCOME_UNCERTAIN',
        `File creation committed, but post-commit verification failed: ${postErr instanceof Error ? postErr.message : String(postErr)}`,
        { statusCode: 500 },
      )
    }
  } finally {
    if (tmpHandle) await tmpHandle.close().catch(() => {})
    if (tmpName) {
      const st = await lstat(tmpChildPath).catch(() => null)
      if (st?.isFile() && st.dev === rootDev) {
        await unlink(tmpChildPath).catch(() => {})
      }
    }
    await dirHandle.close().catch(() => {})
  }
}

export async function renameContainedFile(
  _canonicalRoot: string,
  _rootDev: number,
  _rootIno: number,
  _fromPath: string,
  _toPath: string,
  _expectedRevision: string,
  _hooks?: SaveHookOptions,
): Promise<{ normalizedFromPath: string; normalizedToPath: string; revision: string }> {
  throw new DaemonError(
    'WORKSPACE_RENAME_GATED',
    'Atomic no-clobber rename (RENAME_NOREPLACE) is unavailable in Node.js fs; rename remains gated to prevent unsafe source unlink',
    { statusCode: 501 },
  )
}

export async function deleteContainedFile(
  canonicalRoot: string,
  rootDev: number,
  rootIno: number,
  relativePath: string,
  expectedRevision: string,
  hooks?: SaveHookOptions,
): Promise<{ normalizedRelativePath: string; quarantined: boolean; quarantinePath: string }> {
  const segments = normalizeWorkspaceRelativePath(relativePath, false)
  const fileName = segments[segments.length - 1]
  const normalizedRelativePath = segments.join('/')
  const rootHandle = await openRootDirectoryFd(canonicalRoot, rootDev, rootIno)
  const dirHandle = await walkContainedDirectoryFd(
    canonicalRoot,
    rootDev,
    rootIno,
    segments.slice(0, -1),
  )

  const oNoFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const oNonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0
  const srcChildPath = procFdChildPath(dirHandle.fd, fileName)

  let trashHandle: FileHandle | null = null
  try {
    const trashRootPath = procFdChildPath(rootHandle.fd, '.ghost-bot-trash')
    await mkdir(trashRootPath, 0o700).catch((err) => {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EEXIST') throw err
    })
    trashHandle = await openChildDirectoryFd(rootHandle, '.ghost-bot-trash', rootDev)
    const trashStat = await trashHandle.stat()
    if (
      typeof process.getuid === 'function' &&
      trashStat.uid !== process.getuid()
    ) {
      throw new DaemonError('QUARANTINE_UNSAFE_OWNER', 'Quarantine directory is not owned by current user', {
        statusCode: 403,
      })
    }
    if ((trashStat.mode & 0o077) !== 0) {
      throw new DaemonError(
        'QUARANTINE_UNSAFE_PERMISSIONS',
        'Quarantine directory permissions are too permissive',
        { statusCode: 403 },
      )
    }

    const verifyTarget = async () => {
      const h = await open(srcChildPath, fsConstants.O_RDONLY | oNoFollow | oNonBlock).catch((err) => {
        const code = (err as NodeJS.ErrnoException)?.code
        throw new DaemonError(
          code === 'ELOOP' ? 'SYMLINK_REJECTED' : 'FILE_NOT_FOUND',
          'Target file could not be opened safely',
          { statusCode: code === 'ELOOP' ? 403 : 404 },
        )
      })
      try {
        const st = await h.stat()
        assertRegularFileStats(st, fileName)
        if (st.dev !== rootDev) {
          throw new DaemonError('MOUNT_BOUNDARY_REJECTED', 'File crosses mount boundary', {
            statusCode: 403,
          })
        }
        if (st.size > WORKSPACE_LIMITS.maxFileBytes) {
          throw new DaemonError('FILE_TOO_LARGE', 'File exceeds size limit', { statusCode: 413 })
        }
        const bytes = await readExactFromHandle(h, st.size)
        const rev = computeRevisionToken(st, bytes)
        if (rev !== expectedRevision) {
          throw new DaemonError('FILE_CONFLICT', 'File changed on disk before deletion', {
            statusCode: 409,
          })
        }
        return { dev: st.dev, ino: st.ino }
      } finally {
        await h.close().catch(() => {})
      }
    }

    const initial = await verifyTarget()
    if (hooks?.onBeforeCommit) await hooks.onBeforeCommit()
    const rechecked = await verifyTarget()
    if (rechecked.dev !== initial.dev || rechecked.ino !== initial.ino) {
      throw new DaemonError('FILE_CONFLICT', 'Target identity changed before deletion', {
        statusCode: 409,
      })
    }

    const safeTrashName = `${randomUUID()}-${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}`
    const quarantineChildPath = procFdChildPath(trashHandle.fd, safeTrashName)
    await rename(srcChildPath, quarantineChildPath)
    await dirHandle.sync().catch(() => {})
    await trashHandle.sync().catch(() => {})

    const qStat = await lstat(quarantineChildPath).catch(() => null)
    const srcStillThere = await lstat(srcChildPath).catch(() => null)
    if (!qStat?.isFile() || qStat.dev !== initial.dev || qStat.ino !== initial.ino || srcStillThere !== null) {
      throw new DaemonError(
        'DELETE_OUTCOME_UNCERTAIN',
        'Quarantine move committed, but post-commit verification failed',
        { statusCode: 500 },
      )
    }

    return {
      normalizedRelativePath,
      quarantined: true,
      quarantinePath: `.ghost-bot-trash/${safeTrashName}`,
    }
  } finally {
    if (trashHandle) await trashHandle.close().catch(() => {})
    await dirHandle.close().catch(() => {})
    await rootHandle.close().catch(() => {})
  }
}
