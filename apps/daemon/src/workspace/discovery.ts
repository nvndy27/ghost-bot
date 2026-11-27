import { extname } from 'node:path'
import { DaemonError } from '../errors.ts'
import {
  assertValidUtf8Text,
  isBlockedBinaryExtension,
  listContainedDirectory,
  normalizeWorkspaceRelativePath,
  readContainedFileBytes,
  readContainedTextFile,
} from './containment.ts'
import { DISCOVERY_LIMITS, type WorkspacePreviewPayload, type WorkspaceSearchHit } from './discovery-contracts.ts'
import type { AuthorizedWorkspace } from './files-service.ts'

const SKIPPED_ENTRY_ERRORS = new Set([
  'INVALID_PATH', 'SENSITIVE_FILE_BLOCKED', 'SYMLINK_REJECTED', 'MOUNT_BOUNDARY_REJECTED',
  'FILE_NOT_FOUND', 'FILE_OPEN_FAILED', 'FILE_TOO_LARGE', 'UNSUPPORTED_BINARY_FILE',
  'PATH_NOT_FOUND', 'NOT_A_DIRECTORY', 'WORKSPACE_OPEN_FAILED', 'HARDLINK_REJECTED',
  'UNSUPPORTED_SPECIAL_FILE', 'NOT_A_FILE',
])

export async function searchAuthorizedWorkspace(
  workspace: AuthorizedWorkspace,
  mode: 'filename' | 'content',
  query: string,
  signal?: AbortSignal,
) {
  const { canonicalRoot, rootDev, rootIno } = workspace
  const limits = DISCOVERY_LIMITS
  const deadline = performance.now() + limits.maxSearchMs
  const needle = query.toLowerCase()
  const directories = [{ path: '', depth: 0 }]
  const results: WorkspaceSearchHit[] = []
  let scannedFiles = 0
  let scannedEntries = 0
  let truncated = false
  const shouldStop = () => {
    signal?.throwIfAborted()
    return performance.now() >= deadline
  }

  for (const { path, depth } of directories) {
    if (shouldStop() || scannedEntries >= limits.maxEntries || scannedFiles >= limits.maxFiles) {
      truncated = true
      break
    }

    let listing
    try {
      listing = await listContainedDirectory(canonicalRoot, rootDev, rootIno, path, {
        maxScan: limits.maxEntries - scannedEntries,
        shouldStop,
      })
    } catch (err) {
      if (path && err instanceof DaemonError && SKIPPED_ENTRY_ERRORS.has(err.code)) continue
      throw err
    }
    scannedEntries += listing.totalScanned
    truncated ||= listing.truncated

    for (const entry of listing.entries) {
      if (shouldStop() || scannedFiles >= limits.maxFiles || results.length >= limits.maxResults) {
        return { results, scannedFiles, truncated: true }
      }
      if (entry.relativePath.length > 512 || entry.relativePath.includes('\\')) {
        truncated = true
        continue
      }
      if (entry.kind === 'directory') {
        if (depth < limits.maxDepth && directories.length < limits.maxDirectories) {
          directories.push({ path: entry.relativePath, depth: depth + 1 })
        } else {
          truncated = true
        }
        continue
      }

      scannedFiles += 1
      if (mode === 'filename') {
        if (entry.name.toLowerCase().includes(needle)) {
          results.push({ relativePath: entry.relativePath, lineNumber: null, line: null })
        }
        continue
      }
      if (isBlockedBinaryExtension(entry.name)) continue
      if ((entry.sizeBytes ?? 0) > limits.maxTextBytes) {
        truncated = true
        continue
      }
      try {
        const { content } = await readContainedTextFile(
          canonicalRoot, rootDev, rootIno, entry.relativePath, limits.maxTextBytes,
        )
        const lines = content.split('\n')
        for (let index = 0; index < lines.length; index++) {
          if (shouldStop() || results.length >= limits.maxResults) {
            return { results, scannedFiles, truncated: true }
          }
          const line = lines[index].replace(/\r$/, '')
          const match = line.toLowerCase().indexOf(needle)
          if (match < 0) continue
          const start = Math.max(0, match - 80)
          results.push({
            relativePath: entry.relativePath,
            lineNumber: index + 1,
            line: line.slice(start, start + limits.maxLineLength),
          })
        }
      } catch (err) {
        if (!(err instanceof DaemonError) || !SKIPPED_ENTRY_ERRORS.has(err.code)) throw err
        truncated ||= err.code === 'FILE_TOO_LARGE'
      }
    }
  }

  signal?.throwIfAborted()
  return { results, scannedFiles, truncated }
}

function imageMime(bytes: Buffer, extension: string): 'image/png' | 'image/gif' | null {
  let width: number
  let height: number
  let mime: 'image/png' | 'image/gif'
  if (extension === '.png' && bytes.length >= 33 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16)
    height = bytes.readUInt32BE(20)
    mime = 'image/png'
  } else if (extension === '.gif' && bytes.length >= 14 &&
             ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    width = bytes.readUInt16LE(6)
    height = bytes.readUInt16LE(8)
    mime = 'image/gif'
  } else {
    return null
  }

  return width > 0 && height > 0 && width * height <= 4_000_000 ? mime : null
}

export async function previewAuthorizedWorkspaceFile(
  workspace: AuthorizedWorkspace,
  relativePath: string,
): Promise<WorkspacePreviewPayload> {
  normalizeWorkspaceRelativePath(relativePath, false)
  const extension = extname(relativePath).toLowerCase()
  if (extension === '.pdf') {
    return { kind: 'unavailable', reason: 'PDF preview requires an isolated page rasterizer.' }
  }
  if (!['.md', '.markdown', '.svg', '.png', '.gif'].includes(extension)) {
    return { kind: 'unavailable', reason: 'Preview is unavailable for this file type.' }
  }

  const { bytes } = await readContainedFileBytes(
    workspace.canonicalRoot, workspace.rootDev, workspace.rootIno, relativePath,
    extension === '.svg' ? DISCOVERY_LIMITS.maxTextBytes : DISCOVERY_LIMITS.maxPreviewBytes,
  )
  if (extension === '.svg' || extension === '.md' || extension === '.markdown') {
    return {
      kind: extension === '.svg' ? 'svg' : 'markdown',
      text: assertValidUtf8Text(bytes, relativePath),
    }
  }

  const mime = imageMime(bytes, extension)
  return mime
    ? { kind: 'image', mime, base64: bytes.toString('base64') }
    : { kind: 'unavailable', reason: 'Unsupported or oversized image.' }
}
