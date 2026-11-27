import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { constants as fsConstants, lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
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

const SENSITIVE_DIR_NAMES = new Set(['.git', '.ssh', '.gnupg', '.aws'])

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

export function isSensitiveSegment(name: string): boolean {
  const lower = name.toLowerCase()
  if (SENSITIVE_DIR_NAMES.has(lower)) return true
  if (SENSITIVE_EXACT_NAMES.has(lower)) return true
  if (lower.startsWith('.env.')) return true
  if (lower.startsWith('secret') && (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml'))) {
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
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    if (allowEmpty) return []
    throw new DaemonError('INVALID_PATH', 'Workspace-relative path is required', { statusCode: 400 })
  }
  const normalized = posix.normalize(trimmed)
  if (normalized === '.' || normalized === './') {
    if (allowEmpty) return []
    throw new DaemonError('INVALID_PATH', 'Workspace-relative file path is required', {
      statusCode: 400,
    })
  }
  if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) {
    throw new DaemonError('PATH_TRAVERSAL_REJECTED', 'Path traversal is not allowed', {
      statusCode: 403,
    })
  }
  const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.')
  if (segments.length > WORKSPACE_LIMITS.maxPathDepth) {
    throw new DaemonError('INVALID_PATH', 'Path exceeds maximum directory depth', {
      statusCode: 400,
    })
  }
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new DaemonError('PATH_TRAVERSAL_REJECTED', 'Path traversal segment rejected', {
        statusCode: 403,
      })
    }
    if (isSensitiveSegment(seg)) {
      throw new DaemonError('SENSITIVE_FILE_BLOCKED', `Access to sensitive path '${seg}' is blocked`, {
        statusCode: 403,
      })
    }
  }
  return segments
}

export function computeWorkspaceId(canonicalRoot: string): string {
  return createHash('sha256').update(canonicalRoot, 'utf8').digest('hex').slice(0, 24)
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
}

function assertTextBuffer(buf: Buffer, relativePath: string): string {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) {
      throw new DaemonError('UNSUPPORTED_BINARY_FILE', `Binary file '${relativePath}' cannot be opened`, {
        statusCode: 415,
      })
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return decoder.decode(buf)
  } catch {
    throw new DaemonError('UNSUPPORTED_BINARY_FILE', `Non-UTF-8 file '${relativePath}' cannot be opened`, {
      statusCode: 415,
    })
  }
}

async function openDirectoryNoFollow(
  dirPath: string,
  expectedCanonicalPrefix?: string,
): Promise<{ handle: FileHandle; stats: Stats }> {
  const oNoFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const oDirectory = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0
  const flags = fsConstants.O_RDONLY | oDirectory | oNoFollow

  const lstatRes = await lstat(dirPath).catch(() => null)
  if (!lstatRes) {
    throw new DaemonError('PATH_NOT_FOUND', 'Workspace path does not exist', { statusCode: 404 })
  }
  if (lstatRes.isSymbolicLink()) {
    throw new DaemonError('SYMLINK_REJECTED', 'Directory symlink rejected', { statusCode: 403 })
  }
  if (!lstatRes.isDirectory()) {
    throw new DaemonError('NOT_A_DIRECTORY', 'Expected a directory', { statusCode: 400 })
  }

  let handle: FileHandle
  try {
    handle = await open(dirPath, flags)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ELOOP') {
      throw new DaemonError('SYMLINK_REJECTED', 'Directory symlink rejected', { statusCode: 403 })
    }
    throw new DaemonError('WORKSPACE_OPEN_FAILED', `Failed to open directory safely: ${code ?? 'unknown'}`, {
      statusCode: 403,
    })
  }

  try {
    const fstatRes = await handle.stat()
    if (!fstatRes.isDirectory() || fstatRes.dev !== lstatRes.dev || fstatRes.ino !== lstatRes.ino) {
      throw new DaemonError('TOCTOU_DETECTED', 'Directory changed during containment verification', {
        statusCode: 409,
      })
    }
    if (expectedCanonicalPrefix) {
      const resolved = await realpath(dirPath)
      if (resolved !== expectedCanonicalPrefix && !resolved.startsWith(`${expectedCanonicalPrefix}/`)) {
        throw new DaemonError('WORKSPACE_ESCAPE_REJECTED', 'Resolved directory escaped workspace root', {
          statusCode: 403,
        })
      }
    }
    return { handle, stats: fstatRes }
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

export async function walkContainedDirectory(
  canonicalRoot: string,
  segments: string[],
): Promise<{ dirPath: string; dirHandle: FileHandle }> {
  const rootStat = await stat(canonicalRoot).catch(() => null)
  if (!rootStat || !rootStat.isDirectory()) {
    throw new DaemonError('WORKSPACE_UNAVAILABLE', 'Authorized workspace root is unavailable', {
      statusCode: 404,
    })
  }
  let currentPath = canonicalRoot
  let current = await openDirectoryNoFollow(currentPath, canonicalRoot)

  try {
    for (const seg of segments) {
      const nextPath = join(currentPath, seg)
      const next = await openDirectoryNoFollow(nextPath, canonicalRoot)
      await current.handle.close().catch(() => {})
      current = next
      currentPath = nextPath
    }
    return { dirPath: currentPath, dirHandle: current.handle }
  } catch (err) {
    await current.handle.close().catch(() => {})
    throw err
  }
}

export async function listContainedDirectory(
  canonicalRoot: string,
  relativePath: string,
): Promise<{ entries: WorkspaceDirectoryEntry[]; truncated: boolean; totalScanned: number; normalizedRelativePath: string }> {
  const segments = normalizeWorkspaceRelativePath(relativePath, true)
  const { dirPath, dirHandle } = await walkContainedDirectory(canonicalRoot, segments)

  try {
    const dirents = await readdir(dirPath, { withFileTypes: true })
    const sorted = [...dirents].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    const entries: WorkspaceDirectoryEntry[] = []
    let truncated = false

    for (const entry of sorted) {
      if (entry.isSymbolicLink()) {
        // Never expose or traverse symlinked entries in the workspace tree.
        continue
      }
      if (!entry.isDirectory() && !entry.isFile()) {
        continue
      }
      if (isSensitiveSegment(entry.name)) {
        continue
      }
      if (entries.length >= WORKSPACE_LIMITS.maxDirectoryEntries) {
        truncated = true
        break
      }
      const entryRel = segments.length > 0 ? `${segments.join('/')}/${entry.name}` : entry.name
      let sizeBytes: number | null = null
      if (entry.isFile()) {
        const st = await lstat(join(dirPath, entry.name)).catch(() => null)
        if (!st || st.isSymbolicLink() || !st.isFile()) continue
        sizeBytes = st.size
      }
      entries.push({
        name: entry.name,
        relativePath: entryRel,
        kind: entry.isDirectory() ? 'directory' : 'file',
        sizeBytes,
      })
    }

    return {
      entries,
      truncated,
      totalScanned: sorted.length,
      normalizedRelativePath: segments.join('/'),
    }
  } finally {
    await dirHandle.close().catch(() => {})
  }
}

export async function readContainedTextFile(
  canonicalRoot: string,
  relativePath: string,
): Promise<{ content: string; revision: string; sizeBytes: number; name: string; normalizedRelativePath: string }> {
  const segments = normalizeWorkspaceRelativePath(relativePath, false)
  const fileName = segments[segments.length - 1]
  if (isBlockedBinaryExtension(fileName)) {
    throw new DaemonError('UNSUPPORTED_BINARY_FILE', `File '${fileName}' is a binary type`, {
      statusCode: 415,
    })
  }

  const parentSegments = segments.slice(0, -1)
  const { dirPath, dirHandle } = await walkContainedDirectory(canonicalRoot, parentSegments)
  const targetPath = join(dirPath, fileName)

  const oNoFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const oNonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0
  const flags = fsConstants.O_RDONLY | oNoFollow | oNonBlock

  let fileHandle: FileHandle | null = null
  try {
    const preLstat = await lstat(targetPath).catch(() => null)
    if (!preLstat) {
      throw new DaemonError('FILE_NOT_FOUND', 'Requested file does not exist', { statusCode: 404 })
    }
    assertRegularFileStats(preLstat, fileName)

    try {
      fileHandle = await open(targetPath, flags)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ELOOP') {
        throw new DaemonError('SYMLINK_REJECTED', 'Symlink target rejected', { statusCode: 403 })
      }
      throw new DaemonError('FILE_OPEN_FAILED', `Failed to open file: ${code ?? 'unknown'}`, {
        statusCode: 403,
      })
    }

    const st = await fileHandle.stat()
    assertRegularFileStats(st, fileName)
    if (st.dev !== preLstat.dev || st.ino !== preLstat.ino) {
      throw new DaemonError('TOCTOU_DETECTED', 'File changed during open verification', {
        statusCode: 409,
      })
    }
    if (st.size > WORKSPACE_LIMITS.maxFileBytes) {
      throw new DaemonError(
        'FILE_TOO_LARGE',
        `File exceeds maximum readable size (${WORKSPACE_LIMITS.maxFileBytes} bytes)`,
        { statusCode: 413 },
      )
    }

    const buf = Buffer.allocUnsafe(st.size)
    let offset = 0
    while (offset < st.size) {
      const { bytesRead } = await fileHandle.read(buf, offset, st.size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const exactBuf = buf.subarray(0, offset)
    const content = assertTextBuffer(exactBuf, segments.join('/'))
    const revision = computeRevisionToken(st, exactBuf)

    return {
      content,
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
  relativePath: string,
  newContent: string,
  expectedRevision: string,
): Promise<{ revision: string; sizeBytes: number; normalizedRelativePath: string; savedAt: string }> {
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

  const parentSegments = segments.slice(0, -1)
  const { dirPath, dirHandle } = await walkContainedDirectory(canonicalRoot, parentSegments)
  const targetPath = join(dirPath, fileName)

  const oNoFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const oNonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0
  const flags = fsConstants.O_RDWR | oNoFollow | oNonBlock

  let fileHandle: FileHandle | null = null
  try {
    const preLstat = await lstat(targetPath).catch(() => null)
    if (!preLstat) {
      throw new DaemonError('FILE_NOT_FOUND', 'Target file does not exist', { statusCode: 404 })
    }
    assertRegularFileStats(preLstat, fileName)

    try {
      fileHandle = await open(targetPath, flags)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ELOOP') {
        throw new DaemonError('SYMLINK_REJECTED', 'Symlink target rejected', { statusCode: 403 })
      }
      if (code === 'EACCES' || code === 'EROFS') {
        throw new DaemonError('FILE_READ_ONLY', 'File is read-only on disk', { statusCode: 403 })
      }
      throw new DaemonError('FILE_OPEN_FAILED', `Failed to open file for writing: ${code ?? 'unknown'}`, {
        statusCode: 403,
      })
    }

    const st = await fileHandle.stat()
    assertRegularFileStats(st, fileName)
    if (st.dev !== preLstat.dev || st.ino !== preLstat.ino) {
      throw new DaemonError('TOCTOU_DETECTED', 'File changed during save verification', {
        statusCode: 409,
      })
    }
    if (st.size > WORKSPACE_LIMITS.maxFileBytes) {
      throw new DaemonError('FILE_TOO_LARGE', 'Existing file exceeds maximum editable size', {
        statusCode: 413,
      })
    }

    const currentBuf = Buffer.allocUnsafe(st.size)
    let offset = 0
    while (offset < st.size) {
      const { bytesRead } = await fileHandle.read(currentBuf, offset, st.size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const exactCurrent = currentBuf.subarray(0, offset)
    const currentRevision = computeRevisionToken(st, exactCurrent)
    if (currentRevision !== expectedRevision) {
      throw new DaemonError(
        'FILE_CONFLICT',
        'File was modified on disk since it was opened. Reload before saving.',
        { statusCode: 409 },
      )
    }

    await fileHandle.truncate(0)
    let written = 0
    while (written < nextBytes.length) {
      const res = await fileHandle.write(nextBytes, written, nextBytes.length - written, written)
      if (res.bytesWritten === 0) {
        throw new DaemonError('FILE_WRITE_INCOMPLETE', 'Incomplete write while saving file', {
          statusCode: 500,
        })
      }
      written += res.bytesWritten
    }
    await fileHandle.sync()

    const updatedStat = await fileHandle.stat()
    const newRevision = computeRevisionToken(updatedStat, nextBytes)
    return {
      revision: newRevision,
      sizeBytes: nextBytes.length,
      normalizedRelativePath: segments.join('/'),
      savedAt: new Date().toISOString(),
    }
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {})
    }
    await dirHandle.close().catch(() => {})
  }
}
